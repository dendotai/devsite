/**
 * devsite init — one-time machine bootstrap for *.internal dev URLs over Tailscale.
 *
 * Design notes:
 *   - No ports. `package.json#devSite` declares only a host; the Caddyfile gets a
 *     `respond 503` placeholder per host, and the devsite Vite plugin (vite.mjs)
 *     swaps in a live `reverse_proxy` to a free ephemeral port at `bun dev` time
 *     via Caddy's admin API. Any number of projects can run at once.
 *   - The Caddyfile is machine-global. devsite owns ONLY its marker-delimited
 *     region (regenerated every run; blocks registered by other repos are kept);
 *     everything outside the markers is preserved verbatim — pre-existing user
 *     config is sacred. Every write shows a diff and asks first. The first write
 *     ever saves `Caddyfile.pre-devsite` and no code path touches it again;
 *     `.bak` holds the state before the latest run.
 *
 * Owns the privileged Caddy setup so nobody has to assemble it by hand. It:
 *   - generates devsite's region of /opt/homebrew/etc/Caddyfile from every
 *     package.json#devSite (repo root, apps/*, packages/*),
 *   - pins Caddy's PKI storage to a fixed path so the local CA is identical no matter
 *     which user runs Caddy (a root service vs a foreground process) — the drift that
 *     silently broke phone cert-trust after a restart,
 *   - widens the internal leaf lifetime so certs don't lapse overnight,
 *   - runs Caddy as the always-on brew service.
 *
 * Run it as yourself — it shells out to sudo only for the privileged steps, so
 * the password prompt lands in your terminal:
 *   bunx devsite init            # apply (prompts for sudo once)
 *   bunx devsite init --dry-run  # print the diff it would apply; touch nothing
 * A habitual `sudo bunx devsite init` still works: the run resolves the real
 * user behind sudo (SUDO_USER) and pins storage to *their* home. Only a true
 * root shell (no SUDO_USER) is refused.
 *
 * `bun dev` never needs sudo: it only ever talks to Caddy's admin API on localhost.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";

const LEAF_LIFETIME = "168h"; // 7d — survives nights/weekends; Caddy renews it while running.

// devsite's owned region of the Caddyfile. The begin marker carries a format
// version so a future renderer change can't make older installed copies
// mis-parse (and mangle) a newer region.
const REGION_BEGIN =
  "# >>> devsite v1 — managed region; `devsite init` regenerates it, edits here are lost >>>";
const REGION_END = "# <<< devsite <<<";
const REGION_BEGIN_RE = /^# >>> devsite .*>>>[ \t]*$/m;
const REGION_END_RE = /^# <<< devsite <<<[ \t]*$/m;
// Directives rescued from a pre-existing global options block live here inside
// devsite's own global block (Caddy allows exactly one, first in the file).
const KEPT_BEGIN = "\t# >>> kept from the pre-devsite global options — devsite preserves these >>>";
const KEPT_END = "\t# <<< kept <<<";

// Where the pinned PKI storage lives; derived from the *human's* home once per run.
type Pki = { storageRoot: string; caRootCert: string };

// The storage pin must always point at the *human's* home — under `sudo bunx
// devsite init` the process home is /var/root, and pinning that mints a fresh
// CA no device trusts. Resolve the real user behind sudo, or refuse (null)
// when there is no way back to one (a true root shell).
function realUserHome(): string | null {
  // Overridable so tests can exercise the root paths without actually being root.
  // An empty export must not count: Number("") is 0, which would read as root.
  const uid = process.env.DEVSITE_UID
    ? Number(process.env.DEVSITE_UID)
    : (process.getuid?.() ?? -1);
  if (uid !== 0) return homedir();
  const user = process.env.SUDO_USER;
  // `sudo` records the invoking user; a root shell (`su`, root login) records
  // nothing — and "root behind the sudo" is just a root shell with extra steps.
  if (user && user !== "root") {
    // The authoritative home, from Directory Services — not a guessed /Users/<name>.
    const r = exec("dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], true);
    const home = r.out.match(/^NFSHomeDirectory:\s*(.+)$/m)?.[1];
    if (r.status === 0 && home) {
      console.log(`Running under sudo — pinning certificate storage to ${user}'s home: ${home}`);
      return home;
    }
  }
  console.error(
    "devsite init is running as root and cannot find your real user account.\n" +
      "Run it as yourself, without sudo — it calls sudo itself for the privileged steps:\n" +
      "  bunx devsite init",
  );
  return null;
}

type Route = { host: string; project: string };

// Hosts are interpolated into `bash -c` command strings (verify) and into the
// Caddyfile, so anything but a plain hostname must never get past discovery —
// a project package.json is not trusted input on a run that holds sudo.
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

async function discoverRoutes(repoRoot: string): Promise<Route[]> {
  const candidates = [join(repoRoot, "package.json")];
  for (const dir of ["apps", "packages"]) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    for (const rel of new Bun.Glob("*/package.json").scanSync(base)) {
      candidates.push(join(base, rel));
    }
  }
  const routes: Route[] = [];
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const pkg = (await Bun.file(path).json()) as {
      name?: string;
      devSite?: { host?: string };
    };
    const host = pkg.devSite?.host;
    if (host) {
      if (!HOSTNAME_RE.test(host)) {
        throw new Error(`devSite.host ${JSON.stringify(host)} in ${path} is not a plain hostname`);
      }
      routes.push({ host, project: pkg.name ?? relative(repoRoot, path) });
    }
  }
  return routes.sort((a, b) => a.host.localeCompare(b.host));
}

// devsite-rendered site blocks: `# <project>\n<host> {` at column 0. Inside the
// managed region this shape is guaranteed; outside it only occurs when
// migrating a pre-region (v0) file.
const DEVSITE_BLOCK_RE = /^# .+\n(\S+) \{\n[\s\S]*?\n\}/gm;

function devsiteBlocks(text: string): { host: string; block: string }[] {
  const out: { host: string; block: string }[] = [];
  for (const m of text.matchAll(DEVSITE_BLOCK_RE)) {
    if (m[1]) out.push({ host: m[1], block: m[0] });
  }
  return out;
}

function splitRegion(text: string): { region: string | null; outside: string } {
  const b = text.match(REGION_BEGIN_RE);
  const e = text.match(REGION_END_RE);
  if (b?.index === undefined || e?.index === undefined || e.index < b.index) {
    return { region: null, outside: text };
  }
  const end = e.index + e[0].length;
  return { region: text.slice(b.index, end), outside: text.slice(0, b.index) + text.slice(end) };
}

// A global options block is a bare `{` at column 0 (Caddy allows at most one,
// and it must precede every site block). Nested braces are indented in any
// conventionally formatted file, so the first column-0 `}` closes it.
function extractGlobalOptions(outside: string): { inner: string | null; rest: string } {
  const m = outside.match(/^\{[ \t]*\n([\s\S]*?)^\}[ \t]*(\n|$)/m);
  if (m?.index === undefined) return { inner: null, rest: outside };
  return {
    inner: m[1] ?? "",
    rest: outside.slice(0, m.index) + outside.slice(m.index + m[0].length),
  };
}

// What survives of a foreign global options block once devsite's own directives
// (which we re-render ourselves) and comments are dropped.
function foreignGlobalDirectives(inner: string): string[] {
  const withoutStorage = inner.replace(/^[ \t]*storage file_system \{[\s\S]*?^[ \t]*\}\n?/m, "");
  return withoutStorage
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && l.trim() !== "local_certs" && !l.trim().startsWith("#"));
}

function keptDirectivesIn(region: string | null): string[] {
  if (region === null) return [];
  const b = region.indexOf(KEPT_BEGIN);
  const e = region.indexOf(KEPT_END);
  if (b === -1 || e === -1 || e < b) return [];
  return region
    .slice(b + KEPT_BEGIN.length, e)
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "");
}

function renderRegion(routes: Route[], foreign: string[], kept: string[], pki: Pki): string {
  const lines = [
    REGION_BEGIN,
    "# Change a project's package.json#devSite and re-run `devsite init`.",
    "",
    "{",
    "\t# Pin PKI storage so Caddy's local CA is the SAME no matter which user runs",
    "\t# it (always-on root service vs a foreground process). Every device trusts",
    `\t# this one CA root: ${pki.caRootCert}`,
    "\tstorage file_system {",
    `\t\troot "${pki.storageRoot}"`,
    "\t}",
    "\tlocal_certs",
    ...(kept.length > 0 ? [KEPT_BEGIN, ...kept, KEPT_END] : []),
    "}",
  ];

  // Placeholder only — the devsite Vite plugin swaps in a reverse_proxy to the
  // dev server's ephemeral port at runtime via the admin API.
  for (const r of routes) {
    lines.push(
      "",
      `# ${r.project}`,
      `${r.host} {`,
      "\ttls {",
      "\t\tissuer internal {",
      `\t\t\tlifetime ${LEAF_LIFETIME}`,
      "\t\t}",
      "\t}",
      `\trespond "devsite: dev server for ${r.host} is not running (start it with bun dev)" 503`,
      "}",
    );
  }
  for (const b of foreign) lines.push("", b);
  lines.push(REGION_END);
  return lines.join("\n");
}

// Region first — it holds the global options block, which Caddy requires ahead
// of every site block. Content a user manually placed above the markers moves
// below them (preserved, but reordered).
function composeCaddyfile(region: string, outside: string): string {
  const rest = outside.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
  return rest === "" ? `${region}\n` : `${region}\n\n${rest}\n`;
}

function exec(cmd: string, args: string[], capture = false) {
  const r = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  return { status: r.status ?? 1, out: (r.stdout ?? "").trim(), error: r.error };
}

// null = the file already has exactly this content. diff's contract: exit 0
// identical, exit 1 different — a failed spawn or any other exit is trouble,
// and must never read as "there is a change" and walk toward a privileged
// write over a diff nobody saw.
function diffAgainstCurrent(next: string, caddyfilePath: string): string | null {
  const tmp = join(tmpdir(), `Caddyfile.devsite.next.${process.pid}`);
  writeFileSync(tmp, next);
  const current = existsSync(caddyfilePath) ? caddyfilePath : "/dev/null";
  const r = exec(
    "diff",
    ["-u", "-L", `${caddyfilePath} (current)`, "-L", `${caddyfilePath} (new)`, current, tmp],
    true,
  );
  if (r.error || r.status > 1) {
    throw new Error(
      `could not diff against ${caddyfilePath}: ${r.error?.message ?? `diff exited ${r.status}`}`,
    );
  }
  return r.status === 0 ? null : r.out;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function sudo(args: string[]) {
  console.log(`  sudo ${args.join(" ")}`);
  if (exec("sudo", args).status !== 0) {
    throw new Error(`\`sudo ${args.join(" ")}\` failed`);
  }
}

function applyPrivileged(content: string, write: boolean, caddyfilePath: string) {
  if (write) {
    const tmp = join(tmpdir(), `Caddyfile.devsite.${process.pid}`);
    writeFileSync(tmp, content);
    if (existsSync(caddyfilePath)) {
      // The world before devsite ever touched it — created once, never written again.
      if (!existsSync(`${caddyfilePath}.pre-devsite`)) {
        sudo(["cp", caddyfilePath, `${caddyfilePath}.pre-devsite`]);
      }
      sudo(["cp", caddyfilePath, `${caddyfilePath}.bak`]);
    }
    sudo(["cp", tmp, caddyfilePath]);
    sudo(["chmod", "644", caddyfilePath]);
  }
  exec("sudo", ["pkill", "-x", "caddy"]); // kill any non-service foreground Caddy; ok if none
  sudo(["brew", "services", "restart", "caddy"]);
  // Trust the pinned CA in the Mac keychain. Caddy's own auto-trust needs an
  // interactive prompt it can't get as a background service, so do it explicitly.
  console.log("  sudo caddy trust");
  exec("sudo", ["caddy", "trust"]); // best-effort; ok if already trusted
}

function tailscale(args: string[]): string | null {
  for (const bin of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]) {
    const r = exec(bin, args, true);
    if (r.status === 0) return r.out;
  }
  return null;
}

function check(ok: boolean, label: string, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}`);
}

function sha256Fp(opensslOut: string): string | null {
  return opensslOut.split("=")[1]?.trim() ?? null;
}

function servedIntermediateFp(host: string): string | null {
  const r = exec(
    "bash",
    [
      "-c",
      `echo | openssl s_client -connect ${host}:443 -servername ${host} -showcerts 2>/dev/null ` +
        `| awk '/BEGIN CERT/{n++} n==2{print}' | openssl x509 -noout -fingerprint -sha256 2>/dev/null`,
    ],
    true,
  );
  return r.status === 0 ? sha256Fp(r.out) : null;
}

function pinnedIntermediateFp(storageRoot: string): string | null {
  const p = join(storageRoot, "pki", "authorities", "local", "intermediate.crt");
  if (!existsSync(p)) return null;
  const r = exec("openssl", ["x509", "-in", p, "-noout", "-fingerprint", "-sha256"], true);
  return r.status === 0 ? sha256Fp(r.out) : null;
}

function verify(routes: Route[], pki: Pki) {
  const host = routes[0]?.host;
  if (!host) return;
  // curl on macOS uses its own trust store, not the keychain devices trust, so
  // check reachability with -k and verify trust separately via the cert chain.
  // Any HTTP status counts: with no dev server running the placeholder answers
  // 503; the Vite plugin swaps in the real upstream at `bun dev` time.
  // curl prints "000" as the http_code when the connection itself fails, so
  // success needs both a zero exit status and a real status code.
  const r = exec(
    "bash",
    ["-c", `curl -k -sS -o /dev/null -w '%{http_code}' --max-time 8 https://${host}/`],
    true,
  );
  check(
    r.status === 0 && r.out !== "000",
    `https://${host} answers over TLS (Caddy up)`,
    `HTTP ${r.out || "—"}`,
  );

  const served = servedIntermediateFp(host);
  const pinned = pinnedIntermediateFp(pki.storageRoot);
  check(
    Boolean(served && pinned && served === pinned),
    "served cert chains to the pinned CA (what every trusting device sees)",
    served && pinned ? (served === pinned ? "match" : "MISMATCH") : "could not compare",
  );

  const tsIp = tailscale(["ip", "-4"])?.split("\n")[0]?.trim();
  check(Boolean(tsIp), "Tailscale up on this Mac", tsIp ?? "tailscale not reachable");
  if (tsIp) {
    const answered = exec("dig", ["+short", "+time=3", "+tries=1", `@${tsIp}`, host], true).out;
    check(
      answered === tsIp,
      "dnsmasq answers on the Tailscale IP (the phone's DNS path)",
      answered || "no answer",
    );
  }
  check(
    existsSync("/etc/resolver/internal"),
    "/etc/resolver/internal present (Mac resolves *.internal locally)",
  );
  check(
    existsSync(pki.caRootCert),
    "local CA root exists (this is what devices must trust)",
    pki.caRootCert,
  );
}

function printChecklist(routes: Route[], pki: Pki) {
  console.log("\nManual, per-device (one-time — can't be automated from here):");
  console.log(
    `  • Tailscale admin → DNS → split-DNS: domain 'internal' → this Mac's Tailscale IP.`,
  );
  console.log(
    `  • On each phone: install AND trust the CA root, then reload https://${routes[0]?.host}`,
  );
  console.log(`      ${pki.caRootCert}`);
  console.log(`      (iOS: install the profile, THEN Settings → General → About →`);
  console.log(`       Certificate Trust Settings → toggle it ON — installing ≠ trusting.)`);
  console.log("\nFrom here on your only surface is `bun dev` — it needs no sudo.");
}

// No argv knowledge here — run.ts parses flags and passes options. Fatal
// conditions return 1 (after explaining themselves); unexpected errors throw
// and run.ts turns them into an exit code.
export async function init({
  dryRun,
  // Explicit seams for in-process tests; the defaults are what production uses.
  // Installed under node_modules, so the repo root is where the CLI is invoked.
  cwd = process.cwd(),
  // DEVSITE_CADDYFILE lets the spawn-based tests point a whole child process
  // at a scratch file.
  caddyfilePath = process.env.DEVSITE_CADDYFILE ?? "/opt/homebrew/etc/Caddyfile",
}: {
  dryRun: boolean;
  cwd?: string;
  caddyfilePath?: string;
}): Promise<number> {
  const home = realUserHome();
  if (home === null) return 1;
  const storageRoot = join(home, "Library", "Application Support", "Caddy");
  const pki: Pki = {
    storageRoot,
    caRootCert: join(storageRoot, "pki", "authorities", "local", "root.crt"),
  };

  const routes = await discoverRoutes(cwd);
  if (routes.length === 0) {
    console.error(
      `No package.json#devSite routes found in ${cwd} ` +
        "(checked package.json, apps/*/package.json, packages/*/package.json). " +
        "Run from the repo root.",
    );
    return 1;
  }
  const ownHosts = new Set(routes.map((r) => r.host));

  const existing = existsSync(caddyfilePath) ? readFileSync(caddyfilePath, "utf8") : "";
  const { region, outside: rawOutside } = splitRegion(existing);

  let outside = rawOutside;
  let foreign: string[];
  if (region !== null) {
    foreign = devsiteBlocks(region)
      .filter((b) => !ownHosts.has(b.host))
      .map((b) => b.block);
  } else {
    // Migration from a pre-region (v0) file: devsite-rendered blocks move into
    // the region, the old header comments are dropped, everything else stays.
    const blocks = devsiteBlocks(outside);
    for (const b of blocks) outside = outside.replace(b.block, "");
    outside = outside
      .split("\n")
      .filter(
        (l) =>
          !l.startsWith("# Generated by `devsite init`") &&
          !l.startsWith("# Change a project's package.json#devSite"),
      )
      .join("\n");
    foreign = blocks.filter((b) => !ownHosts.has(b.host)).map((b) => b.block);
  }

  // A pre-existing global options block can't coexist with ours (Caddy allows
  // one, first in the file) — rescue its directives into the kept section.
  let kept = keptDirectivesIn(region);
  const g = extractGlobalOptions(outside);
  let merged = false;
  if (g.inner !== null) {
    outside = g.rest;
    const add = foreignGlobalDirectives(g.inner).filter((d) => !kept.includes(d));
    if (add.length > 0) {
      kept = kept.concat(add);
      merged = true;
    }
  }

  console.log(`devsite init — ${routes.length} route(s):`);
  for (const r of routes) console.log(`  ${r.host} → dev server's port at runtime  (${r.project})`);
  if (foreign.length > 0) {
    console.log(`  + ${foreign.length} block(s) from other repos kept`);
  }
  if (merged) {
    console.warn(
      "\n⚠ Your Caddyfile already had its own global options block. Caddy allows only one, " +
        "so devsite moved its directives into the managed region (marked as kept — see the diff). " +
        "Note: `local_certs` gives EVERY site on this Caddy an internal-CA cert; " +
        "a public site in this file will lose its real certificate.",
    );
  }

  const content = composeCaddyfile(renderRegion(routes, foreign, kept, pki), outside);
  const diff = diffAgainstCurrent(content, caddyfilePath);

  if (dryRun) {
    if (diff === null) {
      console.log(`\n--dry-run: ${caddyfilePath} is already up to date; nothing to write.`);
    } else {
      console.log(`\n--dry-run: would write ${caddyfilePath}; the diff:\n\n${diff}`);
    }
    return 0;
  }

  if (diff === null) {
    console.log(
      `\n${caddyfilePath} is already up to date — (re)starting the Caddy service (needs sudo)…`,
    );
  } else {
    console.log(`\nThe change to ${caddyfilePath}:\n\n${diff}\n`);
    if (!process.stdin.isTTY) {
      console.error(
        "stdin is not a TTY — cannot ask for confirmation; nothing written. " +
          "Run interactively, or use --dry-run to inspect the diff.",
      );
      return 1;
    }
    if (!(await confirm("Apply this change? [y/N] "))) {
      console.error("Aborted — nothing written.");
      return 1;
    }
    console.log(
      `\nWriting ${caddyfilePath} + (re)starting the always-on Caddy service (needs sudo)…`,
    );
  }
  applyPrivileged(content, diff !== null, caddyfilePath);
  console.log("\nVerifying:");
  verify(routes, pki);
  printChecklist(routes, pki);
  return 0;
}
