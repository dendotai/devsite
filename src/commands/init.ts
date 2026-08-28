/**
 * devsite init — one-time machine bootstrap for *.internal dev URLs over Tailscale.
 *
 * Design notes:
 *   - No ports. `package.json#devSite` declares only a host; each host gets a
 *     `respond 503` placeholder, and the devsite Vite plugin (vite.mjs) swaps in
 *     a live `reverse_proxy` to a free ephemeral port at `bun dev` time via
 *     Caddy's admin API. Any number of projects can run at once.
 *   - devsite owns the `devsite.d/` directory next to the Caddyfile — one
 *     `<host>.caddy` file per host, first line `# <project>`. The user's
 *     Caddyfile is edited exactly once, ever: a single
 *     `import devsite.d/*.caddy # devsite` line (the glob covers future files).
 *     Registering or renaming hosts only writes `devsite.d/` files; nothing in
 *     the user's file is ever re-parsed or regenerated. Global options live in
 *     the Caddyfile's own global options block, where every Caddy user expects
 *     them: devsite creates the block (once) when the user has none, or adds
 *     its two directives into the user's block (once). A block the user has
 *     touched is never rewritten — later runs only presence-check; a block
 *     that is purely devsite's own rendering re-renders fresh.
 *   - Older formats (v0 plain blocks, the v1 marker region) migrate in the same
 *     confirmed run: devsite-rendered blocks (recognized by their `respond
 *     "devsite: …" 503` placeholder) move into `devsite.d/` files — other
 *     projects' blocks byte-for-byte — and the old markers disappear.
 *   - Every write shows one multi-file diff and asks first. The first Caddyfile
 *     write ever saves `Caddyfile.pre-devsite` and no code path touches it
 *     again; `.bak` holds the Caddyfile before the latest run.
 *
 * Owns the privileged Caddy setup so nobody has to assemble it by hand. It:
 *   - renders `devsite.d/` from every package.json#devSite (repo root, apps/*,
 *     packages/*) and imports it from /opt/homebrew/etc/Caddyfile,
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
// Adding a version-sensitive node API here (fs.glob is the only one so far,
// Node 22+)? Check engines.node in package.json, and consider a node-version
// matrix on the CI smoke step (ci.yml) — one version stops proving the floor.
import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { type CliContext, processContext } from "../context";

const LEAF_LIFETIME = "168h"; // 7d — survives nights/weekends; Caddy renews it while running.

// The one line devsite ever puts in the user's Caddyfile. The trailing comment
// tags the line for humans; the presence check tolerates it moving or losing
// the comment.
const IMPORT_LINE = "import devsite.d/*.caddy # devsite";
const IMPORT_RE = /^import devsite\.d\/\*\.caddy(?:[ \t]+#.*)?$/m;
// A pre-release devsite.d design kept the global options in this file; the
// name stays reserved (and any such file is deleted) so a stray copy can
// never inject a second global block.
const GLOBAL_FILE = "00-global.caddy";

// Older devsite formats, recognized only to migrate away from them.
// v1: a marker-delimited region devsite regenerated on every run.
const REGION_BEGIN_RE = /^# >>> devsite .*>>>[ \t]*$/m;
const REGION_END_RE = /^# <<< devsite <<<[ \t]*$/m;
// v1's global block rescued user directives between these markers.
const KEPT_BEGIN = "\t# >>> kept from the pre-devsite global options — devsite preserves these >>>";
const KEPT_END = "\t# <<< kept <<<";

// Where the pinned PKI storage lives; derived from the *human's* home once per run.
type Pki = { storageRoot: string; caRootCert: string };

// The storage pin must always point at the *human's* home — under `sudo bunx
// devsite init` the process home is /var/root, and pinning that mints a fresh
// CA no device trusts. Resolve the real user behind sudo, or refuse (null)
// when there is no way back to one (a true root shell).
function realUserHome(ctx: CliContext): string | null {
  // Overridable so tests can exercise the root paths without actually being root.
  // An empty export must not count: Number("") is 0, which would read as root.
  const uid = ctx.env.DEVSITE_UID ? Number(ctx.env.DEVSITE_UID) : (process.getuid?.() ?? -1);
  if (uid !== 0) return homedir();
  const user = ctx.env.SUDO_USER;
  // `sudo` records the invoking user; a root shell (`su`, root login) records
  // nothing — and "root behind the sudo" is just a root shell with extra steps.
  if (user && user !== "root") {
    // The authoritative home, from Directory Services — not a guessed /Users/<name>.
    const r = exec("dscl", [".", "-read", `/Users/${user}`, "NFSHomeDirectory"], true);
    const home = r.out.match(/^NFSHomeDirectory:\s*(.+)$/m)?.[1];
    if (r.status === 0 && home) {
      ctx.stdout.write(
        `Running under sudo — pinning certificate storage to ${user}'s home: ${home}\n`,
      );
      return home;
    }
  }
  ctx.stderr.write(
    "devsite init is running as root and cannot find your real user account.\n" +
      "Run it as yourself, without sudo — it calls sudo itself for the privileged steps:\n" +
      "  bunx devsite init\n",
  );
  return null;
}

type Route = { host: string; project: string };

// Hosts are interpolated into `bash -c` command strings (verify) and into
// devsite.d filenames, so anything but a plain hostname must never get past
// discovery — a project package.json is not trusted input on a run that holds
// sudo.
const HOSTNAME_RE =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

function discoverRoutes(repoRoot: string): Route[] {
  const candidates = [join(repoRoot, "package.json")];
  for (const dir of ["apps", "packages"]) {
    const base = join(repoRoot, dir);
    if (!existsSync(base)) continue;
    for (const rel of globSync("*/package.json", { cwd: base })) {
      candidates.push(join(base, rel));
    }
  }
  const routes: Route[] = [];
  // Keyed lowercase: DNS is case-insensitive, and Caddy refuses a config with
  // two site blocks for one address — that refusal would land only after the
  // privileged write, as a dead always-on service.
  const claimed = new Map<string, string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      devSite?: { host?: string };
    };
    const host = pkg.devSite?.host;
    if (host) {
      if (!HOSTNAME_RE.test(host)) {
        throw new Error(`devSite.host ${JSON.stringify(host)} in ${path} is not a plain hostname`);
      }
      // `<host>.caddy` is the host's filename; this one name is reserved.
      if (host.toLowerCase() === "00-global") {
        throw new Error(`devSite.host "00-global" in ${path} collides with devsite's global file`);
      }
      const project = pkg.name ?? relative(repoRoot, path);
      const owner = claimed.get(host.toLowerCase());
      if (owner !== undefined) {
        throw new Error(
          `devSite.host ${JSON.stringify(host.toLowerCase())} is declared by both ${owner} and ${project} — every project needs its own host`,
        );
      }
      claimed.set(host.toLowerCase(), project);
      routes.push({ host, project });
    }
  }
  return routes.sort((a, b) => a.host.localeCompare(b.host));
}

// devsite-rendered site blocks: `# <project>\n<host> {` at column 0, holding
// the devsite 503 placeholder. The placeholder check matters outside the v1
// region: there the comment+block shape alone also matches user content (any
// site block with a comment directly above it), which must never be migrated.
const DEVSITE_BLOCK_RE = /^# .+\n(\S+) \{\n[\s\S]*?\n\}/gm;
const PLACEHOLDER_RE = /^\trespond "devsite: /m;

function devsiteBlocks(text: string): { host: string; block: string }[] {
  const out: { host: string; block: string }[] = [];
  for (const m of text.matchAll(DEVSITE_BLOCK_RE)) {
    if (m[1] && HOSTNAME_RE.test(m[1]) && PLACEHOLDER_RE.test(m[0])) {
      out.push({ host: m[1], block: m[0] });
    }
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
function findGlobalBlock(
  text: string,
): { start: number; end: number; full: string; inner: string } | null {
  const m = text.match(/^\{[ \t]*\n([\s\S]*?)^\}[ \t]*(?:\n|$)/m);
  if (m?.index === undefined) return null;
  return { start: m.index, end: m.index + m[0].length, full: m[0], inner: m[1] ?? "" };
}

// What survives of a global options block once devsite's own directives and
// comments are dropped — empty means the block was devsite's own rendering.
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

function storagePinLines(pki: Pki): string[] {
  return [
    "\t# Pin PKI storage so Caddy's local CA is the SAME no matter which user runs",
    "\t# it (always-on root service vs a foreground process). Every device trusts",
    `\t# this one CA root: ${pki.caRootCert}`,
    "\tstorage file_system {",
    `\t\troot "${pki.storageRoot}"`,
    "\t}",
  ];
}

// Placeholder only — the devsite Vite plugin swaps in a reverse_proxy to the
// dev server's ephemeral port at runtime via the admin API. The first line
// (`# <project>`) is the file's ownership record, read by rename cleanup.
function renderHostFile(r: Route): string {
  return [
    `# ${r.project}`,
    `${r.host} {`,
    "\ttls {",
    "\t\tissuer internal {",
    `\t\t\tlifetime ${LEAF_LIFETIME}`,
    "\t\t}",
    "\t}",
    `\trespond "devsite: dev server for ${r.host} is not running (start it with bun dev)" 503`,
    "}",
    "",
  ].join("\n");
}

function exec(cmd: string, args: string[], capture = false) {
  const r = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  // outRaw exists for diff output, where trimming could eat a meaningful
  // trailing context line (a lone space) and corrupt the patch.
  return {
    status: r.status ?? 1,
    out: (r.stdout ?? "").trim(),
    outRaw: r.stdout ?? "",
    error: r.error,
  };
}

// One planned file operation; next === null deletes the file. rel is the path
// relative to the Caddyfile's directory — the label patch(1) applies against.
type Change = { rel: string; abs: string; next: string | null };

let tmpSeq = 0;
function writeTmp(content: string): string {
  const p = join(tmpdir(), `devsite.next.${process.pid}.${tmpSeq++}`);
  writeFileSync(p, content);
  return p;
}

// diff's contract: exit 0 identical, exit 1 different — a failed spawn or any
// other exit is trouble, and must never read as "there is a change" and walk
// toward a privileged write over a diff nobody saw.
function unifiedDiff(c: Change): string {
  const current = existsSync(c.abs) ? c.abs : "/dev/null";
  const currentLabel = current === "/dev/null" ? "/dev/null" : c.rel;
  const next = c.next === null ? "/dev/null" : writeTmp(c.next);
  const nextLabel = c.next === null ? "/dev/null" : c.rel;
  const r = exec("diff", ["-u", "-L", currentLabel, "-L", nextLabel, current, next], true);
  if (r.error || r.status > 1) {
    throw new Error(`could not diff ${c.rel}: ${r.error?.message ?? `diff exited ${r.status}`}`);
  }
  return r.outRaw;
}

async function confirm(question: string, ctx: CliContext): Promise<boolean> {
  // readline only ever calls output.write here (non-terminal prompts); the
  // cast bridges Writer to the nominal stream type it asks for.
  const rl = createInterface({
    input: ctx.stdin,
    output: ctx.stdout as unknown as NodeJS.WritableStream,
  });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function sudo(args: string[], ctx: CliContext) {
  ctx.stdout.write(`  sudo ${args.join(" ")}\n`);
  if (exec("sudo", args).status !== 0) {
    throw new Error(`\`sudo ${args.join(" ")}\` failed`);
  }
}

function applyPrivileged(
  changes: Change[],
  caddyfilePath: string,
  devsiteDir: string,
  ctx: CliContext,
) {
  if (changes.some((c) => c.abs === caddyfilePath) && existsSync(caddyfilePath)) {
    // The world before devsite ever touched it — created once, never written again.
    if (!existsSync(`${caddyfilePath}.pre-devsite`)) {
      sudo(["cp", caddyfilePath, `${caddyfilePath}.pre-devsite`], ctx);
    }
    sudo(["cp", caddyfilePath, `${caddyfilePath}.bak`], ctx);
  }
  if (!existsSync(devsiteDir) && changes.some((c) => c.next !== null && c.abs !== caddyfilePath)) {
    sudo(["mkdir", "-p", devsiteDir], ctx);
  }
  for (const c of changes) {
    if (c.next === null) {
      sudo(["rm", c.abs], ctx);
    } else {
      sudo(["cp", writeTmp(c.next), c.abs], ctx);
      sudo(["chmod", "644", c.abs], ctx);
    }
  }
  exec("sudo", ["pkill", "-x", "caddy"]); // kill any non-service foreground Caddy; ok if none
  sudo(["brew", "services", "restart", "caddy"], ctx);
  // Trust the pinned CA in the Mac keychain. Caddy's own auto-trust needs an
  // interactive prompt it can't get as a background service, so do it explicitly.
  ctx.stdout.write("  sudo caddy trust\n");
  exec("sudo", ["caddy", "trust"]); // best-effort; ok if already trusted
}

function tailscale(args: string[]): string | null {
  for (const bin of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]) {
    const r = exec(bin, args, true);
    if (r.status === 0) return r.out;
  }
  return null;
}

function check(ok: boolean, label: string, detail: string, ctx: CliContext) {
  ctx.stdout.write(`  ${ok ? "✓" : "✗"} ${label}${detail ? ` — ${detail}` : ""}\n`);
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

function verify(routes: Route[], pki: Pki, ctx: CliContext) {
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
    ctx,
  );

  const served = servedIntermediateFp(host);
  const pinned = pinnedIntermediateFp(pki.storageRoot);
  check(
    Boolean(served && pinned && served === pinned),
    "served cert chains to the pinned CA (what every trusting device sees)",
    served && pinned ? (served === pinned ? "match" : "MISMATCH") : "could not compare",
    ctx,
  );

  const tsIp = tailscale(["ip", "-4"])?.split("\n")[0]?.trim();
  check(Boolean(tsIp), "Tailscale up on this Mac", tsIp ?? "tailscale not reachable", ctx);
  if (tsIp) {
    const answered = exec("dig", ["+short", "+time=3", "+tries=1", `@${tsIp}`, host], true).out;
    check(
      answered === tsIp,
      "dnsmasq answers on the Tailscale IP (the phone's DNS path)",
      answered || "no answer",
      ctx,
    );
  }
  check(
    existsSync("/etc/resolver/internal"),
    "/etc/resolver/internal present (Mac resolves *.internal locally)",
    "",
    ctx,
  );
  check(
    existsSync(pki.caRootCert),
    "local CA root exists (this is what devices must trust)",
    pki.caRootCert,
    ctx,
  );
}

function printChecklist(routes: Route[], pki: Pki, ctx: CliContext) {
  ctx.stdout.write(
    [
      "",
      "Manual, per-device (one-time — can't be automated from here):",
      `  • Tailscale admin → DNS → split-DNS: domain 'internal' → this Mac's Tailscale IP.`,
      `  • On each phone: install AND trust the CA root, then reload https://${routes[0]?.host}`,
      `      ${pki.caRootCert}`,
      `      (iOS: install the profile, THEN Settings → General → About →`,
      `       Certificate Trust Settings → toggle it ON — installing ≠ trusting.)`,
      "",
      "From here on your only surface is `bun dev` — it needs no sudo.",
      "",
    ].join("\n"),
  );
}

// The planned end state of the user's Caddyfile, plus what the planning
// learned along the way (migrated foreign blocks, whether the user owns the
// global block, whether the local_certs warning applies).
type CaddyfilePlan = {
  next: string;
  migrated: { host: string; block: string }[];
  // Non-null when the plan puts local_certs into a block the user owns — the
  // path-specific first half of the warning; init appends the blast radius.
  globalWarning: string | null;
};

// devsite's two global directives, as presence checks on a block's inner text.
function hasLocalCerts(inner: string): boolean {
  return /^\s*local_certs\s*$/m.test(inner);
}
function hasStoragePin(inner: string): boolean {
  return inner.includes("storage file_system");
}

function planCaddyfile(existing: string, ownHosts: Set<string>, pki: Pki): CaddyfilePlan {
  const { region, outside: rawOutside } = splitRegion(existing);
  let outside = rawOutside;
  let migrated: { host: string; block: string }[];
  if (region !== null) {
    // v1: everything devsite-rendered lives inside the region; foreign hosts'
    // blocks move to devsite.d byte-for-byte, own hosts re-render fresh.
    migrated = devsiteBlocks(region).filter((b) => !ownHosts.has(b.host));
  } else {
    // v0 (or a partial hand-rolled state): devsite-rendered blocks sit in the
    // open file, recognizable by their 503 placeholder.
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
    migrated = blocks.filter((b) => !ownHosts.has(b.host));
  }
  const kept = keptDirectivesIn(region);

  // The global options block lives in the Caddyfile — Caddy allows exactly
  // one, first in the file. Three cases:
  //   - none: devsite creates one with its two directives (plus any v1 "kept"
  //     user directives returning home).
  //   - purely devsite's own rendering (v0, or created by a previous run —
  //     nothing of the user's inside): re-render fresh, so a stale storage
  //     root can't survive a migration.
  //   - anything the user touched: preserved byte-for-byte; devsite only
  //     appends what's missing, once, and never rewrites it again.
  let globalWarning: string | null = null;
  const g = findGlobalBlock(outside);
  let needBlock = g === null;
  if (g !== null) {
    const leftover = foreignGlobalDirectives(g.inner);
    const hasOurs = hasLocalCerts(g.inner) || hasStoragePin(g.inner);
    if (leftover.length === 0 && hasOurs) {
      outside = outside.slice(0, g.start) + outside.slice(g.end);
      needBlock = true;
    } else {
      const blockLines = new Set(g.full.split("\n").map((l) => l.trim()));
      const additions = kept.filter((l) => !blockLines.has(l.trim()));
      if (!hasStoragePin(g.inner)) additions.push(...storagePinLines(pki));
      if (!hasLocalCerts(g.inner)) {
        additions.push("\tlocal_certs");
        globalWarning =
          "Your Caddyfile has its own global options block, so devsite adds its two " +
          "directives (pinned storage, local_certs) into that block, once — see the diff.";
      }
      if (additions.length > 0) {
        const closing = g.full.lastIndexOf("}");
        const augmented = `${g.full.slice(0, closing)}${additions.join("\n")}\n${g.full.slice(closing)}`;
        outside = outside.slice(0, g.start) + augmented + outside.slice(g.end);
      }
    }
  }
  if (needBlock) {
    if (kept.length > 0) {
      // v1 rescued these from the user's own block — give them a block back.
      globalWarning =
        "The old devsite region held global directives of your own; they return to " +
        "the Caddyfile's global options block, together with devsite's two " +
        "directives (pinned storage, local_certs) — see the diff.";
    }
    const block = ["{", ...kept, ...storagePinLines(pki), "\tlocal_certs", "}"].join("\n");
    outside = `${block}\n\n${outside.replace(/^(?:[ \t]*\n)+/, "")}`;
  }

  if (!IMPORT_RE.test(outside)) {
    const after = findGlobalBlock(outside);
    if (after !== null) {
      // Directly after the user's global block — the block must stay first.
      outside = `${outside.slice(0, after.end)}\n${IMPORT_LINE}\n${outside.slice(after.end)}`;
    } else {
      outside = `${IMPORT_LINE}\n\n${outside}`;
    }
  }

  const trimmed = outside.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
  return { next: `${trimmed}\n`, migrated, globalWarning };
}

// No argv knowledge here — run.ts parses flags and passes options plus the io
// context. Fatal conditions return 1 (after explaining themselves); unexpected
// errors throw and run.ts turns them into an exit code.
export async function init(
  { dryRun }: { dryRun: boolean },
  ctx: CliContext = processContext(),
): Promise<number> {
  // Installed under node_modules, so ctx.cwd is where the CLI is invoked — the
  // repo root. DEVSITE_CADDYFILE points tests at a scratch file.
  const cwd = ctx.cwd;
  const caddyfilePath = ctx.env.DEVSITE_CADDYFILE ?? "/opt/homebrew/etc/Caddyfile";
  const caddyDir = dirname(caddyfilePath);
  const devsiteDir = join(caddyDir, "devsite.d");
  const home = realUserHome(ctx);
  if (home === null) return 1;
  const storageRoot = join(home, "Library", "Application Support", "Caddy");
  const pki: Pki = {
    storageRoot,
    caRootCert: join(storageRoot, "pki", "authorities", "local", "root.crt"),
  };

  const routes = discoverRoutes(cwd);
  if (routes.length === 0) {
    ctx.stderr.write(
      `No package.json#devSite routes found in ${cwd} ` +
        "(checked package.json, apps/*/package.json, packages/*/package.json). " +
        "Run from the repo root.\n",
    );
    return 1;
  }
  const ownHosts = new Set(routes.map((r) => r.host));
  const ownProjects = new Set(routes.map((r) => r.project));

  const existing = existsSync(caddyfilePath) ? readFileSync(caddyfilePath, "utf8") : "";
  const plan = planCaddyfile(existing, ownHosts, pki);

  // The devsite.d tree this run wants: own hosts re-render fresh; migrated
  // foreign blocks land byte-for-byte, but never over a file that already
  // exists (an upgraded sibling project's own writes are newer than the block
  // still sitting in the old region).
  const desired = new Map<string, string>();
  for (const r of routes) desired.set(`${r.host}.caddy`, renderHostFile(r));
  for (const b of plan.migrated) {
    const name = `${b.host}.caddy`;
    if (!desired.has(name) && !existsSync(join(devsiteDir, name))) {
      desired.set(name, `${b.block}\n`);
    }
  }

  // Deletions: a stray 00-global.caddy (reserved name — see GLOBAL_FILE), and
  // — the rename cleanup — a host file whose `# <project>` header names a
  // project of THIS run but whose host is no longer declared. Files of other
  // projects are never touched.
  const deletions: string[] = [];
  if (existsSync(devsiteDir)) {
    for (const name of globSync("*.caddy", { cwd: devsiteDir })) {
      if (desired.has(name)) continue;
      if (name === GLOBAL_FILE) {
        deletions.push(name);
        continue;
      }
      const first = readFileSync(join(devsiteDir, name), "utf8").split("\n", 1)[0] ?? "";
      const project = first.match(/^# (.+)$/)?.[1]?.trim();
      if (project !== undefined && ownProjects.has(project)) deletions.push(name);
    }
  }

  const changes: Change[] = [];
  if (plan.next !== existing) {
    changes.push({ rel: basename(caddyfilePath), abs: caddyfilePath, next: plan.next });
  }
  for (const [name, content] of desired) {
    const abs = join(devsiteDir, name);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) {
      changes.push({ rel: `devsite.d/${name}`, abs, next: content });
    }
  }
  for (const name of deletions) {
    changes.push({ rel: `devsite.d/${name}`, abs: join(devsiteDir, name), next: null });
  }
  changes.sort((a, b) => a.rel.localeCompare(b.rel));

  ctx.stdout.write(`devsite init — ${routes.length} route(s):\n`);
  for (const r of routes) {
    ctx.stdout.write(`  ${r.host} → dev server's port at runtime  (${r.project})\n`);
  }
  if (plan.migrated.length > 0) {
    ctx.stdout.write(
      `  migrating ${plan.migrated.length} host file(s) from other repos into devsite.d/\n`,
    );
  }
  if (plan.globalWarning !== null) {
    ctx.stderr.write(
      `\n⚠ ${plan.globalWarning} ` +
        "Note: `local_certs` gives EVERY site on this Caddy an internal-CA cert; " +
        "a public site in this file will lose its real certificate.\n",
    );
  }

  // Each piece ends with its own newline; concatenation is one multi-file
  // unified diff that patch(1) applies with -p0 from the Caddyfile's dir.
  const diff = changes.map(unifiedDiff).join("");

  if (dryRun) {
    if (changes.length === 0) {
      ctx.stdout.write(
        `\n--dry-run: ${caddyfilePath} and devsite.d are already up to date; nothing to write.\n`,
      );
    } else {
      ctx.stdout.write(
        `\n--dry-run: would change ${changes.length} file(s) in ${caddyDir}; the diff:\n\n${diff}\n`,
      );
    }
    return 0;
  }

  if (changes.length === 0) {
    ctx.stdout.write(
      `\n${caddyfilePath} and devsite.d are already up to date — (re)starting the Caddy service (needs sudo)…\n`,
    );
  } else {
    ctx.stdout.write(`\nThe change (paths relative to ${caddyDir}):\n\n${diff}\n\n`);
    if (!ctx.stdin.isTTY) {
      ctx.stderr.write(
        "stdin is not a TTY — cannot ask for confirmation; nothing written. " +
          "Run interactively, or use --dry-run to inspect the diff.\n",
      );
      return 1;
    }
    if (!(await confirm("Apply this change? [y/N] ", ctx))) {
      ctx.stderr.write("Aborted — nothing written.\n");
      return 1;
    }
    ctx.stdout.write(
      `\nWriting ${changes.length} file(s) + (re)starting the always-on Caddy service (needs sudo)…\n`,
    );
  }
  applyPrivileged(changes, caddyfilePath, devsiteDir, ctx);
  ctx.stdout.write("\nVerifying:\n");
  verify(routes, pki, ctx);
  printChecklist(routes, pki, ctx);
  return 0;
}
