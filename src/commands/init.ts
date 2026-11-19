/**
 * devsite init — one-time machine bootstrap for *.internal dev URLs over Tailscale.
 *
 * Design notes:
 *   - No ports. `package.json#devSite` declares only a host; each host gets a `respond 503` placeholder, and the devsite Vite plugin (vite.mjs) swaps in a live `reverse_proxy` to a free ephemeral port at `bun dev` time via Caddy's admin API. Any number of projects can run at once.
 *   - devsite owns the `devsite.d/` directory next to the Caddyfile — one `<host>.caddy` file per host, first line `# <project>`. The user's Caddyfile is edited exactly once, ever: a single `import devsite.d/*.caddy # devsite` line (the glob covers future files). Registering or renaming hosts only writes `devsite.d/` files; nothing in the user's file is ever re-parsed or regenerated. Global options live in the Caddyfile's own global options block, where every Caddy user expects them: devsite creates the block (once) when the user has none, or adds its two directives into the user's block (once). A block the user has touched is never rewritten — later runs only presence-check; a block that is purely devsite's own rendering re-renders fresh.
 *   - Every write shows one multi-file diff and asks first. The first Caddyfile write ever saves `Caddyfile.pre-devsite` and no code path touches it again; `.bak` holds the Caddyfile before the latest run.
 *
 * Owns the Caddy setup so nobody has to assemble it by hand. It:
 *   - renders `devsite.d/` from every package.json#devSite (repo root, apps/*, packages/*) and imports it from /opt/homebrew/etc/Caddyfile,
 *   - pins Caddy's PKI storage to a fixed path so the local CA is identical no matter how Caddy runs (the service vs a foreground process) — the drift that silently broke phone cert-trust after a restart,
 *   - widens the internal leaf lifetime so certs don't lapse overnight,
 *   - runs Caddy as the user's always-on brew service, started at login, every route behind the LAN guard (ADR 0002).
 *
 * Run it as yourself; a run as root is refused. It calls sudo only for `caddy trust`, so the password prompt lands in your terminal:
 *   bunx devsite init            # apply
 *   bunx devsite init --dry-run  # print the diff it would apply; touch nothing
 *
 * `bun dev` never needs sudo: it only ever talks to Caddy's admin API on localhost.
 */
// Adding a version-sensitive node API here (fs.glob is the only one so far, Node 22+)? Check engines.node in package.json, and consider a node-version matrix on the CI smoke step (ci.yml) — one version stops proving the floor.
import {
  copyFileSync,
  existsSync,
  globSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { type CliContext, processContext } from "../context";
import { guardCaddyfileLines } from "../guard.mjs";
import { devSiteName, hostsOf } from "../names.mjs";
import { caddy } from "../vite.mjs";

const LEAF_LIFETIME = "168h"; // 7d — survives nights/weekends; Caddy renews it while running.

// The one line devsite ever puts in the user's Caddyfile. The trailing comment tags the line for humans; the presence check tolerates it moving or losing the comment.
const IMPORT_LINE = "import devsite.d/*.caddy # devsite";
const IMPORT_RE = /^import devsite\.d\/\*\.caddy(?:[ \t]+#.*)?$/m;

// Where the pinned PKI storage lives; derived from the *human's* home once per run.
type Pki = { storageRoot: string; caRootCert: string };

// Caddy runs as the user who runs init (ADR 0002): as root, `brew services` would install a root service and every write would be root-owned.
function refuseRoot(ctx: CliContext): boolean {
  // Overridable so tests can exercise the root path without actually being root.
  // An empty export must not count: Number("") is 0, which would read as root.
  const uid = ctx.env.DEVSITE_UID ? Number(ctx.env.DEVSITE_UID) : (process.getuid?.() ?? -1);
  if (uid !== 0) return false;
  ctx.stderr.write(
    "devsite init is running as root, but Caddy must run as you.\n" +
      "Run it as yourself, without sudo — it calls sudo itself for the steps that need it:\n" +
      "  bunx devsite init\n",
  );
  return true;
}

type Route = { host: string; project: string };

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
  // Keyed lowercase: DNS is case-insensitive, and Caddy refuses a config with two site blocks for one address — that refusal would land only after the write, as a dead always-on service.
  const claimed = new Map<string, string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const pkg = JSON.parse(readFileSync(path, "utf8")) as {
      name?: string;
      devSite?: { name?: unknown };
    };
    const name = devSiteName(pkg, path);
    if (name) {
      const host = hostsOf(name).internal;
      const project = pkg.name ?? relative(repoRoot, path);
      const owner = claimed.get(host.toLowerCase());
      if (owner !== undefined) {
        throw new Error(
          `devSite.name ${JSON.stringify(name.toLowerCase())} is declared by both ${owner} and ${project} — every project needs its own name`,
        );
      }
      claimed.set(host.toLowerCase(), project);
      routes.push({ host, project });
    }
  }
  return routes.sort((a, b) => a.host.localeCompare(b.host));
}

// A global options block is a bare `{` at column 0 (Caddy allows at most one, and it must precede every site block). Nested braces are indented in any conventionally formatted file, so the first column-0 `}` closes it.
function findGlobalBlock(
  text: string,
): { start: number; end: number; full: string; inner: string } | null {
  const m = text.match(/^\{[ \t]*\n([\s\S]*?)^\}[ \t]*(?:\n|$)/m);
  if (m?.index === undefined) return null;
  return { start: m.index, end: m.index + m[0].length, full: m[0], inner: m[1] ?? "" };
}

// What survives of a global options block once devsite's own directives and comments are dropped — empty means the block was devsite's own rendering.
function foreignGlobalDirectives(inner: string): string[] {
  const withoutStorage = inner.replace(/^[ \t]*storage file_system \{[\s\S]*?^[ \t]*\}\n?/m, "");
  return withoutStorage
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "" && l.trim() !== "local_certs" && !l.trim().startsWith("#"));
}

function storagePinLines(pki: Pki): string[] {
  return [
    "\t# Pin PKI storage so Caddy's local CA is the SAME no matter how Caddy runs",
    "\t# it (the always-on service vs a foreground process). Every device trusts",
    `\t# this one CA root: ${pki.caRootCert}`,
    "\tstorage file_system {",
    `\t\troot "${pki.storageRoot}"`,
    "\t}",
  ];
}

// Placeholder only — the devsite Vite plugin swaps in a reverse_proxy to the dev server's ephemeral port at runtime via the admin API. The first line (`# <project>`) is the file's ownership record, read by rename cleanup.
function renderHostFile(r: Route): string {
  return [
    `# ${r.project}`,
    `${r.host} {`,
    "\ttls {",
    "\t\tissuer internal {",
    `\t\t\tlifetime ${LEAF_LIFETIME}`,
    "\t\t}",
    "\t}",
    ...guardCaddyfileLines(),
    `\trespond "devsite: dev server for ${r.host} is not running (start it with bun dev)" 503`,
    "}",
    "",
  ].join("\n");
}

function exec(ctx: CliContext, cmd: string, args: string[], capture = false) {
  const r = ctx.runCommand(cmd, args, { capture });
  // outRaw exists for diff output, where trimming could eat a meaningful trailing context line (a lone space) and corrupt the patch.
  return { status: r.status, out: r.stdout.trim(), outRaw: r.stdout, error: r.error };
}

// One planned file operation; next === null deletes the file. rel is the path relative to the Caddyfile's directory — the label patch(1) applies against.
type Change = { rel: string; abs: string; next: string | null };

let tmpSeq = 0;
function writeTmp(content: string): string {
  const p = join(tmpdir(), `devsite.next.${process.pid}.${tmpSeq++}`);
  writeFileSync(p, content);
  return p;
}

// diff's contract: exit 0 identical, exit 1 different — a failed spawn or any other exit is trouble, and must never read as "there is a change" and walk toward a write over a diff nobody saw.
function unifiedDiff(c: Change, ctx: CliContext): string {
  const current = existsSync(c.abs) ? c.abs : "/dev/null";
  const currentLabel = current === "/dev/null" ? "/dev/null" : c.rel;
  const next = c.next === null ? "/dev/null" : writeTmp(c.next);
  const nextLabel = c.next === null ? "/dev/null" : c.rel;
  const r = exec(ctx, "diff", ["-u", "-L", currentLabel, "-L", nextLabel, current, next], true);
  if (r.error || r.status > 1) {
    throw new Error(`could not diff ${c.rel}: ${r.error?.message ?? `diff exited ${r.status}`}`);
  }
  return r.outRaw;
}

// One key answers, with no Enter: raw mode hands over each key press as it comes. Ctrl-C arrives as a plain byte in raw mode, and reads as "stop".
async function confirm(question: string, ctx: CliContext): Promise<boolean> {
  ctx.stdout.write(question);
  const stdin = ctx.stdin as CliContext["stdin"] & { setRawMode?: (on: boolean) => unknown };
  stdin.setRawMode?.(true);
  stdin.resume();
  const key = await new Promise<string>((resolve) => {
    stdin.once("data", (d) => resolve(String(d)));
  });
  stdin.setRawMode?.(false);
  stdin.pause();
  const yes = /^y/i.test(key);
  ctx.stdout.write(`${yes ? "y" : "n"}\n`);
  return yes;
}

// Prints the command, then runs it; a failure stops init.
function runShown(shown: string[], cmd: string, args: string[], ctx: CliContext) {
  ctx.stdout.write(`  ${shown.join(" ")}\n`);
  if (exec(ctx, cmd, args).status !== 0) throw new Error(`\`${shown.join(" ")}\` failed`);
}

function sudo(args: string[], ctx: CliContext) {
  // sudo prints its prompt only when it asks; the blank line sets it apart from the command above.
  runShown(["sudo", ...args], "sudo", ["-p", "\n  Password for sudo (%u): ", ...args], ctx);
}

function asUser(args: string[], ctx: CliContext) {
  const [cmd = "", ...rest] = args;
  runShown(args, cmd, rest, ctx);
}

// NO_COLOR: https://no-color.org. The basic 8 colours take the terminal theme's palette.
type Paint = (code: number, text: string) => string;
function painter(stream: CliContext["stdout"], ctx: CliContext): Paint {
  const on = (stream as { isTTY?: boolean }).isTTY === true && !ctx.env.NO_COLOR;
  return (code, text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
}
const BOLD = 1;
const DIM = 2;
const RED = 31;
const GREEN = 32;
const YELLOW = 33;
const CYAN = 36;

function paintDiff(diff: string, paint: Paint): string {
  return diff
    .split("\n")
    .map((l) => {
      if (l.startsWith("+++ ") || l.startsWith("--- ")) return paint(BOLD, l);
      if (l.startsWith("@@")) return paint(CYAN, l);
      if (l.startsWith("+")) return paint(GREEN, l);
      if (l.startsWith("-")) return paint(RED, l);
      return l;
    })
    .join("\n");
}

type Step = { text: string; sudo?: boolean; details?: string[] };

function planSteps(changes: Change[], caddyDir: string, removedBinds: string[]): Step[] {
  const steps: Step[] = [];
  if (changes.length > 0) {
    steps.push({
      text: `write ${changes.length} file(s) in ${caddyDir}, as the diff below shows`,
      details: removedBinds.map(
        (b) =>
          `deletes ${JSON.stringify(b)} from the Caddyfile: Caddy as you cannot start with it, and the guard keeps the LAN out`,
      ),
    });
  }
  steps.push({ text: "restart Caddy as you" });
  steps.push({ text: "trust Caddy's local CA", sudo: true });
  return steps;
}

function printSteps(heading: string, steps: Step[], paint: Paint, ctx: CliContext) {
  ctx.stdout.write(`\n${paint(BOLD, heading)}\n`);
  steps.forEach((s, i) => {
    const tag = s.sudo ? `  ${paint(YELLOW, "[sudo]")}` : "";
    ctx.stdout.write(`  ${i + 1}. ${s.text}${tag}\n`);
    for (const d of s.details ?? []) ctx.stdout.write(`     ${paint(DIM, d)}\n`);
  });
}

function applyChanges(changes: Change[], caddyfilePath: string, devsiteDir: string) {
  if (changes.some((c) => c.abs === caddyfilePath) && existsSync(caddyfilePath)) {
    // The world before devsite ever touched it — created once, never written again.
    if (!existsSync(`${caddyfilePath}.pre-devsite`)) {
      copyFileSync(caddyfilePath, `${caddyfilePath}.pre-devsite`);
    }
    copyFileSync(caddyfilePath, `${caddyfilePath}.bak`);
  }
  if (changes.some((c) => c.next !== null && c.abs !== caddyfilePath)) {
    mkdirSync(devsiteDir, { recursive: true });
  }
  for (const c of changes) {
    if (c.next === null) rmSync(c.abs);
    else writeFileSync(c.abs, c.next);
  }
}

function restartService(ctx: CliContext) {
  exec(ctx, "pkill", ["-x", "caddy"]); // the user's own foreground Caddy, if any
  asUser(["brew", "services", "restart", "caddy"], ctx);
}

const ADMIN_WAIT_MS = 5000;
const CADDY_LOG = "/opt/homebrew/var/log/caddy.log";

// `brew services restart` returns before the new Caddy listens; `caddy trust` and verify both need its admin API. Any HTTP answer means the listener is up.
export async function waitForCaddyAdmin(timeoutMs = ADMIN_WAIT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await caddy("/config/", { signal: AbortSignal.timeout(500) });
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function tailscale(args: string[], ctx: CliContext): string | null {
  for (const bin of ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "tailscale"]) {
    const r = exec(ctx, bin, args, true);
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

function servedIntermediateFp(host: string, ctx: CliContext): string | null {
  const r = exec(
    ctx,
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

function pinnedIntermediateFp(storageRoot: string, ctx: CliContext): string | null {
  const p = join(storageRoot, "pki", "authorities", "local", "intermediate.crt");
  if (!existsSync(p)) return null;
  const r = exec(ctx, "openssl", ["x509", "-in", p, "-noout", "-fingerprint", "-sha256"], true);
  return r.status === 0 ? sha256Fp(r.out) : null;
}

function verify(routes: Route[], pki: Pki, ctx: CliContext) {
  const host = routes[0]?.host;
  if (!host) return;
  // curl on macOS uses its own trust store, not the keychain devices trust, so check reachability with -k and verify trust separately via the cert chain.
  // Any HTTP status counts: with no dev server running the placeholder answers 503; the Vite plugin swaps in the real upstream at `bun dev` time.
  // curl prints "000" as the http_code when the connection itself fails, so success needs both a zero exit status and a real status code.
  const r = exec(
    ctx,
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

  const served = servedIntermediateFp(host, ctx);
  const pinned = pinnedIntermediateFp(pki.storageRoot, ctx);
  check(
    Boolean(served && pinned && served === pinned),
    "served cert chains to the pinned CA (what every trusting device sees)",
    served && pinned ? (served === pinned ? "match" : "MISMATCH") : "could not compare",
    ctx,
  );

  const tsIp = tailscale(["ip", "-4"], ctx)?.split("\n")[0]?.trim();
  check(Boolean(tsIp), "Tailscale up on this Mac", tsIp ?? "tailscale not reachable", ctx);
  if (tsIp) {
    const answered = exec(
      ctx,
      "dig",
      ["+short", "+time=3", "+tries=1", `@${tsIp}`, host],
      true,
    ).out;
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

// The planned end state of the user's Caddyfile, plus what the planning learned along the way (whether the local_certs warning applies, which default_bind lines go).
type CaddyfilePlan = {
  next: string;
  // Non-null when the plan puts local_certs into a block the user owns — the path-specific first half of the warning; init appends the blast radius.
  globalWarning: string | null;
  removedBinds: string[];
};

const DEFAULT_BIND_RE = /^\s*default_bind\b/;

// devsite's two global directives, as presence checks on a block's inner text.
function hasLocalCerts(inner: string): boolean {
  return /^\s*local_certs\s*$/m.test(inner);
}
function hasStoragePin(inner: string): boolean {
  return inner.includes("storage file_system");
}

function planCaddyfile(existing: string, pki: Pki): CaddyfilePlan {
  let text = existing;
  const isBind = (l: string) => DEFAULT_BIND_RE.test(l);
  // The one exception to never rewriting the user's global block: Caddy as the user cannot start with a default_bind (ADR 0002), and the guard does its job.
  const userBlock = findGlobalBlock(text);
  const blockLines = userBlock?.full.split("\n") ?? [];
  const removedBinds = blockLines.filter(isBind).map((l) => l.trim());
  if (userBlock !== null) {
    const lines = blockLines.filter((l) => !isBind(l));
    text = text.slice(0, userBlock.start) + lines.join("\n") + text.slice(userBlock.end);
  }

  // The global options block lives in the Caddyfile — Caddy allows exactly one, first in the file. Three cases:
  //   - none: devsite creates one with its two directives.
  //   - purely devsite's own rendering (nothing of the user's inside): re-render fresh, so a stale storage root can't survive.
  //   - anything the user touched: preserved byte-for-byte; devsite only appends what's missing, once, and never rewrites it again.
  let globalWarning: string | null = null;
  const g = findGlobalBlock(text);
  let needBlock = g === null;
  if (g !== null) {
    const leftover = foreignGlobalDirectives(g.inner);
    const hasOurs = hasLocalCerts(g.inner) || hasStoragePin(g.inner);
    if (leftover.length === 0 && hasOurs) {
      text = text.slice(0, g.start) + text.slice(g.end);
      needBlock = true;
    } else {
      const additions: string[] = [];
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
        text = text.slice(0, g.start) + augmented + text.slice(g.end);
      }
    }
  }
  if (needBlock) {
    const block = ["{", ...storagePinLines(pki), "\tlocal_certs", "}"].join("\n");
    text = `${block}\n\n${text.replace(/^(?:[ \t]*\n)+/, "")}`;
  }

  if (!IMPORT_RE.test(text)) {
    const after = findGlobalBlock(text);
    if (after !== null) {
      // Directly after the user's global block — the block must stay first.
      text = `${text.slice(0, after.end)}\n${IMPORT_LINE}\n${text.slice(after.end)}`;
    } else {
      text = `${IMPORT_LINE}\n\n${text}`;
    }
  }

  const trimmed = text.replace(/^(?:[ \t]*\n)+/, "").replace(/(?:\n[ \t]*)+$/, "");
  return { next: `${trimmed}\n`, globalWarning, removedBinds };
}

// No argv knowledge here — run.ts parses flags and passes options plus the io context. Fatal conditions return 1 (after explaining themselves); unexpected errors throw and run.ts turns them into an exit code.
export async function init(
  { dryRun }: { dryRun: boolean },
  ctx: CliContext = processContext(),
): Promise<number> {
  // Installed under node_modules, so ctx.cwd is where the CLI is invoked — the repo root. DEVSITE_CADDYFILE points tests at a scratch file.
  const cwd = ctx.cwd;
  const caddyfilePath = ctx.env.DEVSITE_CADDYFILE ?? "/opt/homebrew/etc/Caddyfile";
  const caddyDir = dirname(caddyfilePath);
  const devsiteDir = join(caddyDir, "devsite.d");
  if (refuseRoot(ctx)) return 1;
  const storageRoot = join(homedir(), "Library", "Application Support", "Caddy");
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
  const ownProjects = new Set(routes.map((r) => r.project));

  const existing = existsSync(caddyfilePath) ? readFileSync(caddyfilePath, "utf8") : "";
  const plan = planCaddyfile(existing, pki);

  const desired = new Map<string, string>();
  for (const r of routes) desired.set(`${r.host}.caddy`, renderHostFile(r));

  // The rename cleanup: a host file whose `# <project>` header names a project of THIS run but whose host is no longer declared. Files of other projects are never touched.
  const deletions: string[] = [];
  if (existsSync(devsiteDir)) {
    for (const name of globSync("*.caddy", { cwd: devsiteDir })) {
      if (desired.has(name)) continue;
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

  const paint = painter(ctx.stdout, ctx);
  ctx.stdout.write(`${paint(BOLD, "devsite init")}\n`);
  for (const r of routes) {
    ctx.stdout.write(`  https://${r.host}  ${paint(DIM, `(${r.project})`)}\n`);
  }
  if (plan.globalWarning !== null) {
    ctx.stderr.write(
      painter(ctx.stderr, ctx)(
        YELLOW,
        `\n⚠ ${plan.globalWarning} ` +
          "Note: `local_certs` gives EVERY site on this Caddy an internal-CA cert; " +
          "a public site in this file will lose its real certificate.\n",
      ),
    );
  }

  const steps = planSteps(changes, caddyDir, plan.removedBinds);

  // Each piece ends with its own newline; concatenation is one multi-file unified diff that patch(1) applies with -p0 from the Caddyfile's dir.
  const diff = changes.map((c) => unifiedDiff(c, ctx)).join("");

  if (dryRun) {
    printSteps("Without --dry-run, this run would:", steps, paint, ctx);
    if (changes.length === 0) {
      ctx.stdout.write(
        `\n--dry-run: ${caddyfilePath} and devsite.d are already up to date; nothing to write.\n`,
      );
    } else {
      ctx.stdout.write(
        `\n--dry-run: would change ${changes.length} file(s) in ${caddyDir}; the diff:\n\n${paintDiff(diff, paint)}\n`,
      );
    }
    return 0;
  }

  // A run with nothing to write only restarts Caddy and re-trusts the CA, so it asks nothing.
  const asks = changes.length > 0;
  printSteps(asks ? "On y, this run will:" : "This run will:", steps, paint, ctx);
  if (changes.length > 0) {
    ctx.stdout.write(`\n${paint(BOLD, `The diff (paths relative to ${caddyDir}):`)}\n\n`);
    ctx.stdout.write(`${paintDiff(diff, paint)}\n`);
  }
  if (asks) {
    if (!ctx.stdin.isTTY) {
      ctx.stderr.write(
        "stdin is not a TTY — cannot ask for confirmation; nothing written. " +
          "Run interactively, or use --dry-run to inspect the diff.\n",
      );
      return 1;
    }
    if (!(await confirm(`\n${paint(BOLD, "Press y to apply, any other key to stop:")} `, ctx))) {
      ctx.stderr.write("Stopped — nothing changed.\n");
      return 1;
    }
  }
  ctx.stdout.write("\n");
  applyChanges(changes, caddyfilePath, devsiteDir);
  restartService(ctx);
  if (!(await waitForCaddyAdmin())) {
    ctx.stderr.write(
      `\nThe Caddy service did not start within ${ADMIN_WAIT_MS / 1000} s — see ${CADDY_LOG}\n`,
    );
    return 1;
  }
  // Trust the pinned CA in the Mac keychain. Caddy's own auto-trust needs an interactive prompt it can't get as a background service, so do it explicitly. An already-trusted CA exits 0.
  sudo(["caddy", "trust"], ctx);
  ctx.stdout.write("\nVerifying:\n");
  verify(routes, pki, ctx);
  printChecklist(routes, pki, ctx);
  return 0;
}
