/**
 * devsite init — machine bootstrap for *.internal dev URLs over Tailscale.
 *
 * Design notes:
 *   - No ports. `package.json#devSite` declares only a host; each host gets a `respond 503` placeholder, and the devsite Vite plugin (vite.mjs) swaps in a live `reverse_proxy` to a free ephemeral port at `bun dev` time via Caddy's admin API. Any number of projects can run at once.
 *   - devsite owns the `devsite.d/` directory next to the Caddyfile — one `<host>.caddy` file per host, first line `# <project>`. The user's Caddyfile is edited exactly once, ever: a single `import devsite.d/*.caddy # devsite` line (the glob covers future files). Registering or renaming hosts only writes `devsite.d/` files; nothing in the user's file is ever re-parsed or regenerated. Global options live in the Caddyfile's own global options block, where every Caddy user expects them: devsite creates the block (once) when the user has none, or adds its two directives into the user's block (once). A block the user has touched is never rewritten — later runs only presence-check; a block that is purely devsite's own rendering re-renders fresh.
 *   - State-driven: init runs doctor's Caddy checks first and plans a fix only for each red one, so on a set-up Mac it asks nothing, runs no sudo, and leaves Caddy's live routes alone. Every plan shows one multi-file diff and asks first. The first Caddyfile write ever saves `Caddyfile.pre-devsite` and no code path touches it again; `.bak` holds the Caddyfile before the latest run.
 *   - Every step that needs root runs in one sudo call, so one password prompt covers the run whatever sudo's `timestamp_timeout` is.
 *
 * Run it as yourself; a run as root is refused:
 *   bunx devsite init            # apply
 *   bunx devsite init --dry-run  # print the plan and the diff it would apply; touch nothing
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
import { caddyChecks, printSection, type Result, storageOf } from "../checks";
import { type CliContext, processContext } from "../context";
import { guardCaddyfileLines } from "../guard.mjs";
import { findCaddy, type KnownInstall, unknownFix } from "../install";
import { BOLD, CYAN, DIM, exec, GREEN, type Paint, painter, RED, YELLOW } from "../io";
import { devSiteName, hostsOf } from "../names.mjs";
import { readSettings, type Settings } from "../settings";
import { adminBase, caddy } from "../vite.mjs";

// Shorter than the 7-day intermediate, as Caddy's docs require (168h made each leaf end at the same second as its intermediate); 120h still outlasts a weekend with the Mac asleep.
const LEAF_LIFETIME = "120h";

// The one line devsite ever puts in the user's Caddyfile. The trailing comment tags the line for humans; the presence check tolerates it moving or losing the comment.
const IMPORT_LINE = "import devsite.d/*.caddy # devsite";
const IMPORT_RE = /^import devsite\.d\/\*\.caddy(?:[ \t]+#.*)?$/m;

// Where the pinned PKI storage lives; derived from the *human's* home once per run.
type Pki = { storageRoot: string; caRootCert: string };

const SUDO_NOTE = {
  init: "it calls sudo itself for the steps that need it",
  doctor: "it never needs sudo",
};

// init: as root, `brew services` would install a root service for a Caddy that runs as the user by default (ADR 0002), and every write would be root-owned; a root Caddy the user chose gets sudo for its own steps.
// doctor writes nothing, but as root it checks the wrong user: `security verify-cert` reads the trust settings of the user who runs it, and with no `storage` line the storage path comes from root's home. A script that runs doctor under sudo gets exit 1, not a gate on the wrong keychain.
export function refuseRoot(command: keyof typeof SUDO_NOTE, ctx: CliContext): boolean {
  // Overridable so tests can exercise the root path without actually being root.
  // An empty export must not count: Number("") is 0, which would read as root.
  const uid = ctx.env.DEVSITE_UID ? Number(ctx.env.DEVSITE_UID) : (process.getuid?.() ?? -1);
  if (uid !== 0) return false;
  ctx.stderr.write(
    `devsite ${command} is running as root.\n` +
      `Run it as yourself, without sudo — ${SUDO_NOTE[command]}:\n` +
      `  bunx devsite ${command}\n`,
  );
  return true;
}

export type Route = { host: string; project: string };

export function discoverRoutes(repoRoot: string): Route[] {
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
export function renderHostFile(r: Route): string {
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
  const r = exec("diff", ["-u", "-L", currentLabel, "-L", nextLabel, current, next], ctx, true);
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
  // Y is the default, as in apt: Enter applies too.
  const yes = /^(y|\r|\n)/i.test(key);
  ctx.stdout.write(`${yes ? "y" : "n"}\n`);
  return yes;
}

// Runs the command where the user sees it, sharing the terminal (a sudo password prompt needs it); a failure stops init.
function runInTerminal(cmd: string, args: string[], ctx: CliContext) {
  if (exec(cmd, args, ctx).status !== 0) throw new Error(`\`${[cmd, ...args].join(" ")}\` failed`);
}

const SHELL_SAFE = /^[\w@%+=:,./-]+$/;
function shellQuote(arg: string): string {
  return SHELL_SAFE.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

// Every root step in one sudo call, so sudo asks for the password at most once per run. sudo prints its prompt only when it asks; the blank line sets it apart from the steps above.
function sudoAll(commands: string[][], ctx: CliContext) {
  const script = commands.map((c) => c.map(shellQuote).join(" ")).join(" && ");
  runInTerminal("sudo", ["-p", "\n  Password for sudo (%u): ", "sh", "-c", script], ctx);
}

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

// A root step's commands join the run's one sudo call. A step handed to the user is a command init prints after the run instead of running it, because a setting handed that change to the user.
type Step = { text: string; details?: string[] } & (
  | { run: () => Promise<void>; root?: never; handedToUser?: never }
  | { root: string[][]; run?: never; handedToUser?: never }
  | { handedToUser: string[]; run?: never; root?: never }
);

type StepPlan = {
  changes: Change[];
  install: KnownInstall;
  settings: Settings;
  removedBinds: string[];
  checks: Result[];
};

// Under a root Caddy its files are root-owned: each file is staged in the temp dir and copied into place with sudo.
function rootWriteCommands(changes: Change[], caddyfilePath: string, devsiteDir: string) {
  const commands: string[][] = [];
  if (changes.some((c) => c.abs === caddyfilePath) && existsSync(caddyfilePath)) {
    if (!existsSync(`${caddyfilePath}.pre-devsite`)) {
      commands.push(["cp", caddyfilePath, `${caddyfilePath}.pre-devsite`]);
    }
    commands.push(["cp", caddyfilePath, `${caddyfilePath}.bak`]);
  }
  if (changes.some((c) => c.next !== null && c.abs !== caddyfilePath)) {
    commands.push(["mkdir", "-p", devsiteDir]);
  }
  for (const c of changes) {
    commands.push(c.next === null ? ["rm", "-f", c.abs] : ["cp", writeTmp(c.next), c.abs]);
  }
  return commands;
}

// Inside the one sudo call init cannot wait in-process, so the shell waits for the admin API the way waitForCaddyAdmin does: any HTTP answer means the listener is up.
function waitForAdminCommand(): string[] {
  const tries = ADMIN_WAIT_MS / 100;
  return [
    "sh",
    "-c",
    `i=0; until curl -so /dev/null ${adminBase()}/config/; do i=$((i+1)); [ $i -ge ${tries} ] && exit 1; sleep 0.1; done`,
  ];
}

// The steps in the order they run: the user's steps, then the root steps (one sudo call, so it runs back to back after the plan's y), then the steps a setting hands to the user.
function planSteps(p: StepPlan, ctx: CliContext): Step[] {
  const { install } = p;
  const caddyfilePath = install.config;
  const asRoot = install.user === "root";
  const repairs = new Set(
    p.checks.flatMap((r) => (r.state !== "green" && r.repair ? [r.repair] : [])),
  );
  const steps: Step[] = [];
  if (repairs.has("install")) {
    steps.push({
      text: "install Caddy with Homebrew",
      run: async () => runInTerminal("brew", ["install", "caddy"], ctx),
    });
  }
  if (p.changes.length > 0) {
    const text = `write ${p.changes.length} file(s) in ${dirname(caddyfilePath)}, as the diff below shows`;
    const details = p.removedBinds.map(
      (b) =>
        `deletes ${JSON.stringify(b)} from the Caddyfile: Caddy as you cannot start with it, and the guard keeps the LAN out`,
    );
    steps.push(
      asRoot
        ? { text, details, root: rootWriteCommands(p.changes, caddyfilePath, install.devsiteDir) }
        : {
            text,
            details,
            run: async () => applyChanges(p.changes, caddyfilePath, install.devsiteDir),
          },
    );
  }
  const reload = ["caddy", "reload", "--config", caddyfilePath, "--adapter", "caddyfile"];
  if (repairs.has("start")) {
    // Caddy serves nothing while its admin API is down, so the start drops no live route; the new process reads the files written above.
    steps.push(
      asRoot
        ? {
            text: "start Caddy as root",
            root: [["brew", "services", "start", "caddy"], waitForAdminCommand()],
          }
        : {
            text: "start Caddy as you",
            run: async () => {
              runInTerminal("brew", ["services", "start", "caddy"], ctx);
              if (!(await waitForCaddyAdmin())) {
                // `brew services start` does nothing for a service launchd still has loaded after Caddy crashed.
                throw new Error(
                  `the Caddy service did not start within ${ADMIN_WAIT_MS / 1000} s — see ${install.log ?? "Caddy's log"}.\n` +
                    "If `brew services start caddy` said the service is already started, Caddy crashed while loaded; run `brew services restart caddy`, then `bunx devsite init` again",
                );
              }
            },
          },
    );
  } else if (p.changes.length > 0 || repairs.has("load")) {
    // `caddy reload` adapts the Caddyfile and posts it to the running Caddy's admin API, whatever service manager runs Caddy.
    const text = "load the Caddy config through Caddy's admin API";
    if (p.settings.caddy.reload === "manual") {
      steps.push({
        text: "reload Caddy yourself, so it reads the files written above",
        details: ["caddy.reload is manual in your devsite settings, so init does not reload it"],
        handedToUser: reload,
      });
    } else if (asRoot) {
      steps.push({ text, root: [reload] });
    } else {
      steps.push({
        text,
        run: async () => runInTerminal("caddy", reload.slice(1), ctx),
      });
    }
  }
  // Caddy's own auto-trust needs an interactive prompt it cannot get as a background service, so init runs `caddy trust`; it reads the CA from the admin API, which the steps above leave answering.
  if (repairs.has("trust")) {
    steps.push({ text: "trust Caddy's local CA", root: [["caddy", "trust"]] });
  }
  const rank = (s: Step) => (s.run ? 0 : s.root ? 1 : 2);
  return steps.sort((a, b) => rank(a) - rank(b));
}

function stepLine(step: Step, i: number, total: number, paint: Paint): string {
  const tag = step.root ? `  ${paint(YELLOW, "[sudo]")}` : "";
  return `${paint(BOLD, `Step ${i + 1} of ${total}:`)} ${step.text}${tag}`;
}

function printSteps(heading: string, steps: Step[], paint: Paint, ctx: CliContext) {
  ctx.stdout.write(`\n${paint(BOLD, heading)}\n`);
  steps.forEach((s, i) => {
    ctx.stdout.write(`  ${stepLine(s, i, steps.length, paint)}\n`);
    for (const d of s.details ?? []) ctx.stdout.write(`     ${paint(DIM, d)}\n`);
  });
}

async function runSteps(steps: Step[], paint: Paint, ctx: CliContext) {
  for (const [i, s] of steps.entries()) {
    if (s.run === undefined) continue;
    ctx.stdout.write(`\n${stepLine(s, i, steps.length, paint)}\n`);
    await s.run();
  }
  const root = steps.flatMap((s, i) => (s.root ? [{ s, i, root: s.root }] : []));
  if (root.length > 0) {
    ctx.stdout.write("\n");
    for (const r of root) {
      ctx.stdout.write(`${stepLine(r.s, r.i, steps.length, paint)}\n`);
      for (const c of r.root) ctx.stdout.write(`  sudo ${c.map(shellQuote).join(" ")}\n`);
    }
    sudoAll(
      root.flatMap((r) => r.root),
      ctx,
    );
  }
  for (const [i, s] of steps.entries()) {
    if (s.handedToUser === undefined) continue;
    ctx.stdout.write(
      `\n${stepLine(s, i, steps.length, paint)}\n  ${s.handedToUser.map(shellQuote).join(" ")}\n`,
    );
  }
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

const ADMIN_WAIT_MS = 5000;

// Starting the service returns before the new Caddy listens; `caddy trust` and the checks after the run both need its admin API. Any HTTP answer means the listener is up.
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

// The run can install and start Caddy, so the checks after it read the install again.
function installAfter(settings: Settings, before: KnownInstall, ctx: CliContext): KnownInstall {
  const after = findCaddy(settings, ctx);
  return after.kind === "unknown" ? before : after;
}

// No argv knowledge here — run.ts parses flags and passes options plus the io context. Fatal conditions return 1 (after explaining themselves); unexpected errors throw and run.ts turns them into an exit code.
export async function init(
  { dryRun }: { dryRun: boolean },
  ctx: CliContext = processContext(),
): Promise<number> {
  // Installed under node_modules, so ctx.cwd is where the CLI is invoked — the repo root.
  const cwd = ctx.cwd;
  if (refuseRoot("init", ctx)) return 1;
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

  const read = readSettings(ctx);
  if (!read.ok) {
    ctx.stderr.write(`${read.error}\n`);
    return 1;
  }
  const settings = read.settings;
  const install = findCaddy(settings, ctx);
  if (install.kind === "unknown") {
    ctx.stderr.write(
      `devsite does not know this Mac's Caddy install: ${install.why}.\n` +
        `To use it anyway, ${unknownFix(ctx)}.\n`,
    );
    return 1;
  }
  const caddyfilePath = install.config;
  const caddyDir = dirname(caddyfilePath);
  const devsiteDir = install.devsiteDir;

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

  const checks = await caddyChecks(install, storageOf(caddyfilePath), ctx);
  printSection("Checks", checks, paint, ctx);
  const steps = planSteps(
    { changes, install, settings, removedBinds: plan.removedBinds, checks },
    ctx,
  );

  // Each piece ends with its own newline; concatenation is one multi-file unified diff that patch(1) applies with -p0 from the Caddyfile's dir.
  const diff = changes.map((c) => unifiedDiff(c, ctx)).join("");

  if (dryRun) {
    if (steps.length === 0) ctx.stdout.write("\n--dry-run: nothing to do.\n");
    else printSteps("Plan:", steps, paint, ctx);
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

  if (steps.length === 0) {
    ctx.stdout.write(`\n${paint(GREEN, "Nothing to do: init changed nothing.")}\n`);
    return 0;
  }
  printSteps("Plan:", steps, paint, ctx);
  if (changes.length > 0) {
    ctx.stdout.write(`\n${paint(BOLD, `The diff (paths relative to ${caddyDir}):`)}\n\n`);
    ctx.stdout.write(`${paintDiff(diff, paint)}\n`);
  }
  if (!ctx.stdin.isTTY) {
    ctx.stderr.write(
      "stdin is not a TTY — cannot ask for confirmation; nothing changed. " +
        "Run interactively, or use --dry-run to inspect the plan.\n",
    );
    return 1;
  }
  if (!(await confirm(`\n${paint(BOLD, "Apply these changes? [Y/n]")} `, ctx))) {
    ctx.stderr.write("Stopped — nothing changed.\n");
    return 1;
  }
  await runSteps(steps, paint, ctx);
  printSection(
    "Checks after this run",
    await caddyChecks(installAfter(settings, install, ctx), storageOf(caddyfilePath), ctx),
    paint,
    ctx,
  );
  printChecklist(routes, pki, ctx);
  return 0;
}
