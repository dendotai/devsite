/**
 * devsite init — machine bootstrap for *.internal dev URLs over Tailscale.
 *
 * Design notes:
 *   - No ports. `package.json#devSite` declares only a host; each host's site block imports a port file in devsite's state dir, which holds a placeholder until the devsite Vite plugin (vite.mjs) writes a live `reverse_proxy` to a free ephemeral port at `bun dev` time and swaps the same route in through Caddy's admin API. Any number of projects can run at once.
 *   - devsite owns the `devsite.d/` directory next to the Caddyfile — one `<host>.caddy` file per host, first line `# <project>`. The user's Caddyfile is edited exactly once, ever: a single `import devsite.d/*.caddy # devsite` line (the glob covers future files). Registering or renaming hosts only writes `devsite.d/` files; nothing in the user's file is ever re-parsed or regenerated. devsite keeps the storage Caddy already uses: with no `storage` line it pins that storage in the Caddyfile's global options block, creating the block (once) when the user has none, or adding the pin into the user's block (once). A block the user has touched is never rewritten — later runs only presence-check; a block that is purely devsite's own rendering re-renders fresh.
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
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
// bun-types types every .html import as an HTMLBundle for Bun.serve; the text attribute gives the file's text, which `bun build` inlines into dist, so the package ships no asset file.
import offlinePage from "../../assets/offline.html" with { type: "text" };
import {
  type CaddyRoute,
  caddyChecks,
  JSON_FIX_IN_INIT,
  machineHosts,
  offlinePageChecks,
  portFileChecks,
  printSection,
  type Repair,
  type Result,
  readServers,
  type Servers,
} from "../checks";
import { type CliContext, processContext } from "../context";
import { type DnsmasqPlan, digAnswer, planDnsmasq, probeDnsmasq } from "../dnsmasq";
import { ALLOWED_SOURCES, guardCaddyfileLines } from "../guard.mjs";
import { findCaddy, type KnownInstall, unknownFix } from "../install";
import {
  BOLD,
  CYAN,
  DIM,
  exec,
  GREEN,
  type Paint,
  painter,
  plural,
  RED,
  type RootCommand,
  YELLOW,
} from "../io";
import { devSiteName, hostsOf } from "../names.mjs";
import { readSettings, type Settings, settingsPath } from "../settings";
import { PORT_PLACEHOLDER, portFilePath, resolveStateDir, writePortFile } from "../state.mjs";
import { caRootFile, findStorage, rootCrtIn } from "../storage";
import {
  ADMIN_DNS_URL,
  probeTailscale,
  readSplitDns,
  type SplitDns,
  type SplitDnsRoute,
  splitDnsDetail,
  splitDnsValues,
  TWO_MACS_ISSUE,
} from "../tailscale";
import { adminBase, caddy } from "../vite.mjs";

// Shorter than the 7-day intermediate, as Caddy's docs require (168h made each leaf end at the same second as its intermediate); 120h still outlasts a weekend with the Mac asleep.
const LEAF_LIFETIME = "120h";

// The one line devsite ever puts in the user's Caddyfile. The trailing comment tags the line for humans; the presence check tolerates it moving or losing the comment.
const IMPORT_LINE = "import devsite.d/*.caddy # devsite";
const IMPORT_RE = /^import devsite\.d\/\*\.caddy(?:[ \t]+#.*)?$/m;

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
    .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
}

function storagePinLines(root: string): string[] {
  return [
    "\t# Pin PKI storage so Caddy's local CA is the SAME no matter how Caddy runs",
    "\t# it (the always-on service vs a foreground process). Every device trusts",
    `\t# this one CA root: ${rootCrtIn(root)}`,
    "\tstorage file_system {",
    `\t\troot "${root}"`,
    "\t}",
  ];
}

// The snippet a site block of the user's own imports to take devsite's LAN guard in place of a default_bind. Its matcher name is devsite's, so it cannot clash with one in the user's block.
const GUARD_FILE = "guard.caddy";
export function renderGuardFile(): string {
  return [
    "# devsite: `import devsite-guard` in a site block keeps the LAN out of it",
    "(devsite-guard) {",
    ...guardCaddyfileLines().map((l) => l.replace("@outside", "@devsite_outside")),
    "}",
    "",
  ].join("\n");
}

// Outside the `devsite.d/*.caddy` glob (`*` does not cross `/`), so Caddy loads it only through each host file's import, which passes the project as its argument. A named snippet would have to come before every host file in parse order.
export const OFFLINE_FRAGMENT = "fragments/offline.caddy";

// The files devsite writes whole, by file name, with what each one is: init names them in one line.
const OFFLINE_HEREDOC_END = "HTML";
const OFFLINE_PROJECT = "{args[0]}";

// The page shows these as text, and a `{` in them would be a Caddy placeholder (`{env.X}` prints an env var): every other character becomes an HTML character reference, which also keeps quotes and spaces out of the import argument.
function htmlText(s: string): string {
  return s.replace(/[^A-Za-z0-9@/._-]/g, (c) => `&#${c.codePointAt(0)};`);
}

// handle_errors answers the 503 of the port file's placeholder (a server never started) and the 502 of a dead dev server's route; the page picks its text from {http.error.status_code}. Caddy fills the visited host per request, so one fragment serves both of a host file's names.
export function renderOfflineFragment(page: string = offlinePage as unknown as string): string {
  page.split("\n").forEach((line, i) => {
    const brace = line.match(/\{\S/)?.[0];
    if (brace !== undefined) {
      throw new Error(
        `assets/offline.html line ${i + 1} holds \`${brace}\`, which Caddy reads as a placeholder`,
      );
    }
    if (line.trim() === OFFLINE_HEREDOC_END) {
      throw new Error(
        `assets/offline.html line ${i + 1} is \`${OFFLINE_HEREDOC_END}\`, which ends the page early`,
      );
    }
  });
  // The page's comments are notes for its editor (the token list), not for a visitor.
  const lines = page
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/\n$/, "")
    .split("\n");
  const body = lines.map((line) =>
    line === ""
      ? ""
      : `\t\t${line}`
          .replaceAll("__HOST__", "{http.request.host}")
          .replaceAll("__STATUS_CODE__", "{http.error.status_code}")
          .replaceAll("__PROJECT__", OFFLINE_PROJECT),
  );
  return [
    "# devsite: the offline page every host file imports. init renders it from its assets/offline.html, so an edit here is overwritten.",
    "handle_errors 502 503 {",
    "\theader {",
    '\t\tContent-Type "text/html; charset=utf-8"',
    "\t\tCache-Control no-store",
    "\t}",
    `\trespond <<${OFFLINE_HEREDOC_END}`,
    ...body,
    `\t\t${OFFLINE_HEREDOC_END} 503`,
    "}",
    "",
  ].join("\n");
}

// The handler comes from the host's port file, which the devsite Vite plugin keeps on the live port, so a `caddy reload` keeps a running dev server's route. portFile null inlines the placeholder, for the JSON printed to a Caddy with no Caddyfile; that JSON answers in one line of text, because the page inline makes that printout long (#86 loads the routes with no printout). The first line (`# <project>`) is the file's ownership record, read by rename cleanup. Each host file carries its own `issuer internal`, so no global local_certs moves the user's other sites off their real certificates.
export function renderHostFile(r: Route, portFile: string | null): string {
  const localhost = r.host.replace(/\.internal$/, ".localhost");
  if (portFile !== null && /["\\\n]/.test(portFile)) {
    throw new Error(
      `devsite's state dir cannot hold a quote, a backslash, or a newline: ${portFile}`,
    );
  }
  const offline =
    portFile === null
      ? [
          "\thandle_errors 502 503 {",
          `\t\trespond "devsite: dev server for ${r.host} is not running" 503`,
          "\t}",
        ]
      : [`\timport ${OFFLINE_FRAGMENT} "${htmlText(r.project)}"`];
  return [
    `# ${r.project}`,
    `${r.host}, ${localhost} {`,
    "\ttls {",
    "\t\tissuer internal {",
    `\t\t\tlifetime ${LEAF_LIFETIME}`,
    "\t\t}",
    "\t}",
    ...guardCaddyfileLines(),
    portFile === null ? `\t${PORT_PLACEHOLDER}` : `\timport "${portFile}"`,
    ...offline,
    "}",
    "",
  ].join("\n");
}

// One planned file operation; next === null deletes the file. rel is the diff's label: the path relative to the Caddyfile's directory, or the absolute path of a file outside it.
// generated: what a file devsite writes whole is; init names such a file in one line, and --dry-run prints its diff.
type Change = { rel: string; abs: string; next: string | null; generated?: string };

function dirsToMake(changes: Change[], caddyfilePath: string | null): string[] {
  return [
    ...new Set(
      changes.filter((c) => c.next !== null && c.abs !== caddyfilePath).map((c) => dirname(c.abs)),
    ),
  ].sort();
}

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

const CTRL_C = "\x03";

// One key answers, with no Enter: raw mode hands over each key press as it comes. Ctrl-C arrives as a plain byte in raw mode.
async function readKey(question: string, ctx: CliContext): Promise<string> {
  ctx.stdout.write(question);
  const stdin = ctx.stdin as CliContext["stdin"] & { setRawMode?: (on: boolean) => unknown };
  stdin.setRawMode?.(true);
  stdin.resume();
  // Paused inside the listener: a key typed ahead stays buffered for the next prompt instead of flowing out unheard.
  const key = await new Promise<string>((resolve) => {
    stdin.once("data", (d) => {
      stdin.pause();
      resolve(String(d));
    });
  });
  stdin.setRawMode?.(false);
  return key;
}

// Ctrl-C reads as "stop".
async function confirm(question: string, ctx: CliContext): Promise<boolean> {
  // Y is the default, as in apt: Enter applies too.
  const yes = /^(y|\r|\n)/i.test(await readKey(question, ctx));
  ctx.stdout.write(`${yes ? "y" : "n"}\n`);
  return yes;
}

// A (y/n) prompt has no default: only y is a yes. null for Ctrl-C.
async function yesNo(question: string, ctx: CliContext): Promise<boolean | null> {
  const key = await readKey(question, ctx);
  if (key.startsWith(CTRL_C)) {
    ctx.stdout.write("^C\n");
    return null;
  }
  const yes = /^y/i.test(key);
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
// A manual step is one only the user can do, in a web page; init guides it after the root steps.
// repair: the red check this step fixes, so a check still red after the run names the step.
// planNote: printed after the text in the plan only, where it points at what the plan prints below it.
type Step = { text: string; planNote?: string; details?: string[]; repair?: Repair } & (
  | { run: () => Promise<void>; root?: never; handedToUser?: never; manual?: never }
  | { root: RootCommand[]; run?: never; handedToUser?: never; manual?: never }
  | { handedToUser: string[]; run?: never; root?: never; manual?: never }
  | { manual: () => Promise<void>; run?: never; root?: never; handedToUser?: never }
);

type StepPlan = {
  changes: Change[];
  install: KnownInstall;
  settings: Settings;
  removedBinds: string[];
  guardedSites: string[];
  repairs: Set<Repair>;
  // The hosts with no port file yet. An existing one is never written: it can hold a running dev server's live port.
  missingPortFiles: string[];
  stateDir: string;
  // Shown under the load step: one line per live route the load drops, or one line that says init cannot list them.
  dropped: string[];
  // null when no check calls for devsite's dnsmasq.
  dnsmasq: DnsmasqPlan | null;
  // null with no Tailscale IP.
  splitDns: SplitDnsRoute | null;
};

// Under a root Caddy its files are root-owned: each file is staged in the temp dir and copied into place with sudo.
function rootWriteCommands(changes: Change[], caddyfilePath: string | null) {
  const commands: string[][] = [];
  if (
    caddyfilePath !== null &&
    changes.some((c) => c.abs === caddyfilePath) &&
    existsSync(caddyfilePath)
  ) {
    if (!existsSync(`${caddyfilePath}.pre-devsite`)) {
      commands.push(["cp", caddyfilePath, `${caddyfilePath}.pre-devsite`]);
    }
    commands.push(["cp", caddyfilePath, `${caddyfilePath}.bak`]);
  }
  for (const dir of dirsToMake(changes, caddyfilePath)) commands.push(["mkdir", "-p", dir]);
  for (const c of changes) {
    commands.push(c.next === null ? ["rm", "-f", c.abs] : ["cp", writeTmp(c.next), c.abs]);
  }
  return commands;
}

// Inside the one sudo call init cannot wait in-process, so the shell waits for the admin API the way waitForCaddyAdmin does: any HTTP answer means the listener is up.
function waitForAdminCommand(): RootCommand {
  const tries = ADMIN_WAIT_MS / 100;
  return Object.assign(
    [
      "sh",
      "-c",
      `i=0; until curl -so /dev/null ${adminBase()}/config/; do i=$((i+1)); [ $i -ge ${tries} ] && exit 1; sleep 0.1; done`,
    ],
    { shown: `wait up to ${ADMIN_WAIT_MS / 1000} s for Caddy's admin API` },
  );
}

function repairsOf(checks: Result[], install: KnownInstall): Set<Repair> {
  // A start would run Homebrew's Caddyfile and a reload would replace the config, so a Caddy with no Caddyfile gets neither: init prints the JSON for it instead.
  const loadable = install.configKind === "caddyfile";
  return new Set(
    checks.flatMap((r) =>
      r.state !== "green" && r.repair && (loadable || (r.repair !== "start" && r.repair !== "load"))
        ? [r.repair]
        : [],
    ),
  );
}

// A start reads the files written before it, so a run that starts Caddy needs no load.
function loadsConfig(
  install: KnownInstall,
  repairs: Set<Repair>,
  changes: Change[],
): install is KnownInstall & { configKind: "caddyfile"; config: string } {
  return (
    install.configKind === "caddyfile" &&
    !repairs.has("start") &&
    (changes.length > 0 || repairs.has("load"))
  );
}

// Empty for a route that matches every host: one with no match set, or with a match set that has no host matcher.
function routeHosts(route: CaddyRoute): string[] {
  const sets = route.match ?? [];
  if (sets.length === 0 || sets.some((m) => m.host === undefined)) return [];
  return sets.flatMap((m) => m.host ?? []).map((h) => h.toLowerCase());
}

function allRoutes(servers: Servers): CaddyRoute[] {
  return Object.values(servers).flatMap((s) => s.routes ?? []);
}

// A load replaces the live config with the adapted Caddyfile, so it drops each route another tool added through the admin API at runtime. devsite's own hosts are left out: their port files bring their routes back.
async function droppedRoutes(
  config: string,
  ownHosts: Set<string>,
  ctx: CliContext,
): Promise<string[]> {
  const live = await readServers();
  if (!live.ok) return [];
  let adapted: CaddyRoute[] = [];
  if (existsSync(config)) {
    const adapt = ["adapt", "--config", config, "--adapter", "caddyfile"];
    const r = exec("caddy", adapt, ctx, true);
    let parsed: { apps?: { http?: { servers?: Servers } } } | null = null;
    try {
      parsed = r.status === 0 ? JSON.parse(r.out) : null;
    } catch {}
    if (parsed === null) {
      return [
        `cannot list the routes this load drops: \`caddy ${adapt.join(" ")}\` failed; run it to see why`,
      ];
    }
    adapted = allRoutes(parsed.apps?.http?.servers ?? {});
  }
  const kept = new Set([...ownHosts, ...adapted.flatMap(routeHosts)]);
  const keptHostless = new Set(
    adapted.filter((r) => routeHosts(r).length === 0).map((r) => JSON.stringify(r)),
  );
  return allRoutes(live.servers).flatMap((route) => {
    const hosts = routeHosts(route);
    const lost =
      hosts.length > 0
        ? hosts.filter((h) => !kept.has(h))
        : keptHostless.has(JSON.stringify(route))
          ? []
          : ["every host"];
    if (lost.length === 0) return [];
    const what =
      hosts.length > 0 ? `the route for ${lost.join(", ")}` : "a route that matches every host";
    return [`drops ${what}, added at runtime by another tool`];
  });
}

// The steps in the order they run: the user's steps, then the root steps (one sudo call, so it runs back to back after the plan's y), then the steps a setting hands to the user.
function planSteps(p: StepPlan, ctx: CliContext): Step[] {
  const { install } = p;
  const caddyfilePath = install.config;
  const asRoot = install.user === "root";
  const { repairs } = p;
  const steps: Step[] = [];
  // Before the host files that import them, so no reload ever reads a host file whose port file is missing. User space, so no sudo even for a root Caddy.
  if (p.missingPortFiles.length > 0) {
    steps.push({
      text: `write the port file of ${p.missingPortFiles.join(", ")} in ${join(p.stateDir, "ports")}`,
      repair: "port-file",
      run: async () => {
        for (const host of p.missingPortFiles) writePortFile(host, PORT_PLACEHOLDER, p.stateDir);
      },
    });
  }
  if (repairs.has("install")) {
    steps.push({
      text: "install Caddy with Homebrew",
      repair: "install",
      run: async () => runInTerminal("brew", ["install", "caddy"], ctx),
    });
  }
  if (p.changes.length > 0) {
    const text = `write ${plural(p.changes.length, "file", "files")} in ${dirname(install.devsiteDir)}`;
    const planNote = ", as the diff below shows";
    const details = [
      ...p.guardedSites.map(
        (s) =>
          `adds \`import devsite-guard\` to your site ${s}: the guard keeps the LAN out of it in place of default_bind`,
      ),
      ...p.removedBinds.map(
        (b) =>
          `deletes ${JSON.stringify(b)} from the Caddyfile: Caddy cannot run as you with it, and the guard keeps the LAN out`,
      ),
      ...(p.guardedSites.length > 0
        ? [`to keep default_bind instead, answer n and ${keepBindsWithRoot(ctx)}`]
        : []),
    ];
    steps.push(
      asRoot
        ? {
            text,
            planNote,
            details,
            repair: "write",
            root: rootWriteCommands(p.changes, caddyfilePath),
          }
        : {
            text,
            planNote,
            repair: "write",
            details,
            run: async () => applyChanges(p.changes, caddyfilePath),
          },
    );
  }
  if (repairs.has("start")) {
    // Caddy serves nothing while its admin API is down, so the start drops no live route; the new process reads the files written above.
    steps.push(
      asRoot
        ? {
            text: "start Caddy as root",
            repair: "start",
            root: [["brew", "services", "start", "caddy"], waitForAdminCommand()],
          }
        : {
            text: "start Caddy as you",
            repair: "start",
            run: async () => {
              runInTerminal("brew", ["services", "start", "caddy"], ctx);
              if (!(await waitForCaddyAdmin())) {
                // `brew services start` does nothing for a service launchd still has loaded after Caddy crashed.
                throw new Error(
                  `the Caddy service did not start within ${ADMIN_WAIT_MS / 1000} s. See ${install.log ?? "Caddy's log"}.\n` +
                    "If `brew services start caddy` said the service is already started, Caddy crashed while loaded: run `brew services restart caddy`, then `bunx devsite init` again.",
                );
              }
            },
          },
    );
  } else if (loadsConfig(install, repairs, p.changes)) {
    // `caddy reload` adapts the Caddyfile and posts it to the running Caddy's admin API, whatever service manager runs Caddy.
    const reload = ["caddy", "reload", "--config", install.config, "--adapter", "caddyfile"];
    const text = "load the Caddy config through Caddy's admin API";
    if (p.settings.caddy.reload === "manual") {
      steps.push({
        text: "reload Caddy yourself, so it reads the files written above",
        details: [
          "caddy.reload is manual in your devsite settings, so init does not reload it",
          ...p.dropped,
        ],
        handedToUser: reload,
      });
    } else if (asRoot) {
      steps.push({ text, details: p.dropped, repair: "load", root: [reload] });
    } else {
      steps.push({
        text,
        details: p.dropped,
        repair: "load",
        run: async () => runInTerminal("caddy", reload.slice(1), ctx),
      });
    }
  }
  // Caddy's own auto-trust needs an interactive prompt it cannot get as a background service, so init runs `caddy trust`; it reads the CA from the admin API, which the steps above leave answering.
  if (repairs.has("trust")) {
    steps.push({ text: "trust Caddy's local CA", repair: "trust", root: [["caddy", "trust"]] });
  }
  if (p.dnsmasq !== null) steps.push(...dnsmasqSteps(p.dnsmasq, ctx));
  if (repairs.has("split-dns") && p.splitDns !== null) steps.push(splitDnsStep(p.splitDns, ctx));
  const rank = (s: Step) => (s.run ? 0 : s.root ? 1 : s.manual ? 2 : 3);
  return steps.sort((a, b) => rank(a) - rank(b));
}

function dnsmasqSteps(plan: DnsmasqPlan, ctx: CliContext): Step[] {
  const steps: Step[] = [];
  if (plan.install) {
    steps.push({
      text: "install dnsmasq with Homebrew",
      run: async () => runInTerminal("brew", ["install", "dnsmasq"], ctx),
    });
  }
  steps.push({
    text: plan.text,
    details: plan.details,
    repair: "run-dnsmasq",
    root: plan.rootCommands(writeTmp),
  });
  return steps;
}

const SPLIT_DNS_WAIT_MS = 10_000;

// Tailscale hands a new route to each device within seconds of the save in the admin console.
async function waitForSplitDns(ip: string, ctx: CliContext): Promise<SplitDns> {
  const set = Number(ctx.env.DEVSITE_SPLIT_DNS_WAIT_MS);
  const waitMs =
    ctx.env.DEVSITE_SPLIT_DNS_WAIT_MS && Number.isFinite(set) ? set : SPLIT_DNS_WAIT_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    const split = readSplitDns(ip, ctx);
    if (split.state === "this-mac" || Date.now() >= deadline) return split;
    await new Promise((r) => setTimeout(r, Math.min(1000, waitMs)));
  }
}

function splitDnsStep({ ip, split }: SplitDnsRoute, ctx: CliContext): Step {
  const elsewhere =
    split.state === "elsewhere"
      ? [
          `the route now points to ${split.others.join("; ")}: change it to ${ip}, and that device's projects stop opening on the phone (${TWO_MACS_ISSUE})`,
        ]
      : [];
  return {
    text: `${split.state === "elsewhere" ? "change" : "add"} the split DNS route for .internal in the Tailscale admin console, so the phone finds .internal names`,
    details: [...splitDnsValues(ip), ...elsewhere],
    manual: async () => {
      const open = await yesNo(`Open ${ADMIN_DNS_URL} in your browser? (y/n) `, ctx);
      if (open === null) return skipSplitDns(ip, ctx);
      if (open && exec("open", [ADMIN_DNS_URL], ctx, true).status !== 0) {
        ctx.stdout.write(`  Could not open it: open ${ADMIN_DNS_URL} yourself.\n`);
      }
      for (;;) {
        const done = await yesNo("Done? Press y to check, n to skip ", ctx);
        if (!done) return skipSplitDns(ip, ctx);
        const now = await waitForSplitDns(ip, ctx);
        if (now.state === "this-mac") {
          ctx.stdout.write(`  The split DNS route for .internal points to this Mac.\n`);
          return;
        }
        ctx.stdout.write(`  Not yet: \`tailscale dns status\` shows ${splitDnsDetail(now)}.\n`);
      }
    },
  };
}

function skipSplitDns(ip: string, ctx: CliContext) {
  ctx.stdout.write(
    `  Skipped: \`bunx devsite doctor\` stays red until the route for .internal points to ${ip}.\n`,
  );
}

function stepLine(step: Step, i: number, total: number, paint: Paint, inPlan = false): string {
  const tag = step.root
    ? `  ${paint(YELLOW, "[sudo]")}`
    : step.manual
      ? `  ${paint(CYAN, "[manual]")}`
      : "";
  const note = inPlan ? (step.planNote ?? "") : "";
  return `${paint(BOLD, `Step ${i + 1} of ${total}:`)} ${step.text}${note}${tag}`;
}

function printSteps(heading: string, steps: Step[], paint: Paint, ctx: CliContext) {
  ctx.stdout.write(`\n${paint(BOLD, heading)}\n`);
  steps.forEach((s, i) => {
    ctx.stdout.write(`  ${stepLine(s, i, steps.length, paint, true)}\n`);
    for (const d of s.details ?? []) ctx.stdout.write(`     ${paint(DIM, d)}\n`);
  });
}

// afterRoot runs between the sudo call and the manual steps.
async function runSteps(
  steps: Step[],
  paint: Paint,
  ctx: CliContext,
  afterRoot: () => Promise<void>,
) {
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
      for (const c of r.root) {
        ctx.stdout.write(`  ${c.shown ?? `sudo ${c.map(shellQuote).join(" ")}`}\n`);
      }
    }
    sudoAll(
      root.flatMap((r) => r.root),
      ctx,
    );
  }
  await afterRoot();
  for (const [i, s] of steps.entries()) {
    if (s.manual === undefined) continue;
    ctx.stdout.write(`\n${stepLine(s, i, steps.length, paint)}\n`);
    for (const d of s.details ?? []) ctx.stdout.write(`  ${d}\n`);
    await s.manual();
  }
  for (const [i, s] of steps.entries()) {
    if (s.handedToUser === undefined) continue;
    ctx.stdout.write(
      `\n${stepLine(s, i, steps.length, paint)}\n  ${s.handedToUser.map(shellQuote).join(" ")}\n`,
    );
  }
}

function applyChanges(changes: Change[], caddyfilePath: string | null) {
  if (
    caddyfilePath !== null &&
    changes.some((c) => c.abs === caddyfilePath) &&
    existsSync(caddyfilePath)
  ) {
    // The world before devsite ever touched it — created once, never written again.
    if (!existsSync(`${caddyfilePath}.pre-devsite`)) {
      copyFileSync(caddyfilePath, `${caddyfilePath}.pre-devsite`);
    }
    copyFileSync(caddyfilePath, `${caddyfilePath}.bak`);
  }
  for (const dir of dirsToMake(changes, caddyfilePath)) mkdirSync(dir, { recursive: true });
  for (const c of changes) {
    if (c.next === null) rmSync(c.abs);
    else writeFileSync(c.abs, c.next);
  }
}

const ADMIN_WAIT_MS = 5000;

const DNSMASQ_WAIT_MS = 3000;

// launchd returns before dnsmasq binds, and the checks after the run ask it.
async function waitForDnsmasq(ip: string, ctx: CliContext, timeoutMs = DNSMASQ_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (digAnswer(ip, ctx) !== ip && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
  }
}

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

// A phone trusts the CA once, so the steps show only on the run that set the CA up.
function printPhoneSteps(routes: Route[], caRoot: string | null, ctx: CliContext) {
  const host = routes[0]?.host;
  ctx.stdout.write(
    [
      "",
      "Manual, per-device (one-time — can't be automated from here):",
      `  • On each phone: install and trust the CA root, then reload https://${host}`,
      caRoot === null
        ? `      Caddy makes its CA when it first serves https://${host}; then save it with \`curl -s ${adminBase()}/pki/ca/local | jq -r .root_certificate > caddy-root.crt\``
        : `      ${caRoot}`,
      "      (iOS: install the profile, then turn it on in Settings → General → About →",
      "       Certificate Trust Settings.)",
      "",
    ].join("\n"),
  );
}

const DEFAULT_BIND_RE = /^\s*default_bind\b/;
const isBind = (l: string) => DEFAULT_BIND_RE.test(l);

function defaultBinds(text: string): string[] {
  return (findGlobalBlock(text)?.full.split("\n") ?? []).filter(isBind).map((l) => l.trim());
}

function hasStoragePin(inner: string): boolean {
  return inner.includes("storage file_system");
}

function planCaddyfile(
  existing: string,
  pinRoot: string | null,
  dropBinds: boolean,
): { next: string; removedBinds: string[] } {
  let text = existing;
  // The one exception to never rewriting the user's global block: Caddy as the user cannot start with a default_bind (ADR 0002), and the guard does its job.
  const userBlock = findGlobalBlock(text);
  const removedBinds = dropBinds ? defaultBinds(text) : [];
  if (userBlock !== null && removedBinds.length > 0) {
    const blockLines = userBlock.full.split("\n");
    const lines = blockLines.filter((l) => !isBind(l));
    text = text.slice(0, userBlock.start) + lines.join("\n") + text.slice(userBlock.end);
  }

  // The global options block lives in the Caddyfile — Caddy allows exactly one, first in the file. Three cases:
  //   - purely devsite's own rendering (nothing of the user's inside): re-render fresh, keeping the pinned storage.
  //   - anything the user touched: preserved byte-for-byte; devsite appends its pin when the block names no storage, once.
  //   - none: devsite creates one for its pin.
  const g = findGlobalBlock(text);
  let block: string[] | null = pinRoot === null ? null : storagePinLines(pinRoot);
  if (g !== null) {
    if (hasStoragePin(g.inner) && foreignGlobalDirectives(g.inner).length === 0) {
      const kept = g.inner.match(/^\s*root\s+"?([^"\n]+?)"?\s*$/m)?.[1];
      block = kept !== undefined ? storagePinLines(kept) : block;
      text = text.slice(0, g.start) + text.slice(g.end);
    } else {
      if (block !== null && !hasStoragePin(g.inner)) {
        const closing = g.full.lastIndexOf("}");
        const augmented = `${g.full.slice(0, closing)}${block.join("\n")}\n${g.full.slice(closing)}`;
        text = text.slice(0, g.start) + augmented + text.slice(g.end);
      }
      block = null;
    }
  }
  if (block !== null) {
    text = `${["{", ...block, "}"].join("\n")}\n\n${text.replace(/^(?:[ \t]*\n)+/, "")}`;
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
  return { next: `${trimmed}\n`, removedBinds };
}

// A top-level entry of the user's own that does not import devsite-guard, so a deleted default_bind would open it to the LAN. line is the index of a site block's opening line, where init can add the import; null for an entry init cannot guard: an import of the user's own (the sites it pulls in are not read here) or a site with no braces.
type UnguardedSite = { address: string; line: number | null };

// Quoted text and comments are dropped before braces are counted.
function unguardedSites(text: string): UnguardedSite[] {
  const out: UnguardedSite[] = [];
  let depth = 0;
  let site: (UnguardedSite & { guarded: boolean }) | null = null;
  let globalSeen = false;
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.replace(/"(?:[^"\\]|\\.)*"|`[^`]*`/g, '""').replace(/(^|\s)#.*$/, "$1");
    const t = line.trim();
    if (depth === 0) {
      if (site !== null) {
        if (!site.guarded) out.push({ address: site.address, line: site.line });
        site = null;
      }
      if (t === "" || IMPORT_RE.test(t)) continue;
      if (t === "{" && !globalSeen) {
        globalSeen = true;
      } else if (/^import\s/.test(t)) {
        out.push({ address: t, line: null });
      } else if (!/^\(.+\)\s*\{$/.test(t)) {
        const braces = t.endsWith("{");
        site = { address: t.replace(/\s*\{$/, ""), line: braces ? i : null, guarded: false };
        // A Caddyfile with one site may leave out the braces: the rest of the file is that site.
        if (!braces) depth = Number.POSITIVE_INFINITY;
      }
    } else if (site !== null && /^import\s+devsite-guard\b/.test(t)) {
      site.guarded = true;
    }
    if (depth !== Number.POSITIVE_INFINITY) {
      for (const ch of line) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    }
  }
  if (site !== null && !site.guarded) out.push({ address: site.address, line: site.line });
  return out;
}

// The import goes first in each block, so the guard runs before the site's own handlers.
function addGuardImports(text: string, sites: UnguardedSite[]): string {
  const lines = text.split("\n");
  const at = sites.flatMap((s) => (s.line === null ? [] : [s.line])).sort((a, b) => b - a);
  for (const i of at) lines.splice(i + 1, 0, "\timport devsite-guard");
  return lines.join("\n");
}

const guardSources = new BlockList();
for (const src of ALLOWED_SOURCES) {
  const [addr = "", bits] = src.split("/");
  const type = isIP(addr) === 6 ? "ipv6" : "ipv4";
  if (bits === undefined) guardSources.addAddress(addr, type);
  else guardSources.addSubnet(addr, Number(bits), type);
}

// A bind address the LAN guard also allows: a site that takes the guard in place of the default_bind keeps the same sources.
function guardAllows(bind: string): boolean {
  const addr = bind.replace(/^(?:tcp|udp)[46]?\//, "");
  if (addr === "localhost") return true;
  const version = isIP(addr);
  return version !== 0 && guardSources.check(addr, version === 6 ? "ipv6" : "ipv4");
}

const bindsGuardAllows = (binds: string[]) =>
  binds.flatMap((b) => b.split(/\s+/).slice(1)).every(guardAllows);

const keepBindsWithRoot = (ctx: CliContext) =>
  `set caddy.user to "root" in ${settingsPath(ctx)}; init then keeps default_bind`;

// init reaches this only when it cannot add the guard itself: a bind address the guard would cut off, or an entry with no block to add the import to.
function defaultBindStop(binds: string[], sites: UnguardedSite[], ctx: CliContext): string {
  const ways = [
    ...(bindsGuardAllows(binds)
      ? [
          "  - add `import devsite-guard` to each of those site blocks, and for an import, to the site blocks of the files it pulls in: init then deletes default_bind, and devsite's LAN guard keeps the LAN out of your sites",
        ]
      : []),
    `  - run Caddy as root: ${keepBindsWithRoot(ctx)}`,
  ];
  return [
    "Your Caddyfile has a default_bind line and site blocks of your own:",
    ...binds.map((b) => `  ${b}`),
    ...sites.map((s) => `  ${s.address}`),
    "Caddy cannot run as you with default_bind, and deleting the line would open your sites to the LAN. init changed nothing.",
    `To go on, do ${ways.length === 1 ? "this" : "one of these"}, then run \`bunx devsite init\` again:`,
    ...ways,
    "",
  ].join("\n");
}

// A Caddy with no Caddyfile cannot load devsite's files, so init prints them adapted to JSON. Caddy's adapter makes one server for the hosts and one TLS policy per host's `issuer internal`.
function adaptedJson(files: string[], ctx: CliContext): string {
  const r = exec(
    "caddy",
    ["adapt", "--config", writeTmp(files.join("\n")), "--adapter", "caddyfile"],
    ctx,
    true,
  );
  if (r.status !== 0) throw new Error("`caddy adapt` could not adapt devsite's host files");
  const config = JSON.parse(r.out) as {
    apps?: { http?: { servers?: unknown }; tls?: { automation?: { policies?: unknown } } };
  };
  const json = (v: unknown) => JSON.stringify(v ?? null, null, 2).replace(/^/gm, "    ");
  return [
    "",
    "Add devsite's hosts to your Caddy config, as JSON, then run `bunx devsite doctor`:",
    "  apps.http.servers — the routes go into your server that listens on :443:",
    json(config.apps?.http?.servers),
    "  apps.tls.automation.policies — append these policies:",
    json(config.apps?.tls?.automation?.policies),
    "",
  ].join("\n");
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
      `This Mac's Caddy is an install devsite does not know: ${install.why}.\n` +
        `To use it anyway, ${unknownFix(ctx)}.\n`,
    );
    return 1;
  }
  const caddyfilePath = install.configKind === "caddyfile" ? install.config : null;
  const caddyDir = dirname(install.devsiteDir);
  const devsiteDir = install.devsiteDir;
  const storage = await findStorage(install, ctx);

  const changes: Change[] = [];
  let removedBinds: string[] = [];
  let guardedSites: string[] = [];
  if (caddyfilePath !== null) {
    const existing = existsSync(caddyfilePath) ? readFileSync(caddyfilePath, "utf8") : "";
    let text = existing;
    const binds = defaultBinds(existing);
    // A root Caddy can listen on the default_bind addresses, so the line stays.
    const dropBinds = binds.length > 0 && install.user === "user";
    if (dropBinds) {
      const sites = unguardedSites(existing);
      if (sites.length > 0 && (!bindsGuardAllows(binds) || sites.some((s) => s.line === null))) {
        ctx.stderr.write(defaultBindStop(binds, sites, ctx));
        return 1;
      }
      text = addGuardImports(existing, sites);
      guardedSites = sites.map((s) => s.address);
    }
    const plan = planCaddyfile(text, storage.fromConfig ? null : storage.root, dropBinds);
    removedBinds = plan.removedBinds;
    if (plan.next !== existing) {
      changes.push({ rel: basename(caddyfilePath), abs: caddyfilePath, next: plan.next });
    }
  }

  const stateDir = resolveStateDir(ctx.env);
  const desired = new Map<string, string>([
    [GUARD_FILE, renderGuardFile()],
    [OFFLINE_FRAGMENT, renderOfflineFragment()],
  ]);
  for (const r of routes) {
    desired.set(`${r.host}.caddy`, renderHostFile(r, portFilePath(r.host, stateDir)));
  }
  const missingPortFiles = routes
    .map((r) => r.host)
    .filter((h) => !existsSync(portFilePath(h, stateDir)));

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

  for (const [name, content] of desired) {
    const abs = join(devsiteDir, name);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) {
      const generated = name === OFFLINE_FRAGMENT ? "devsite's offline page" : undefined;
      changes.push({ rel: `devsite.d/${name}`, abs, next: content, generated });
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

  const dns = probeDnsmasq(settings, ctx);
  const tailscale = probeTailscale(dns.tailscale, ctx);
  const runHosts = new Set(missingPortFiles);
  const fileChecks = () => [
    ...portFileChecks(devsiteDir, stateDir, runHosts),
    ...offlinePageChecks(devsiteDir, join(devsiteDir, OFFLINE_FRAGMENT), renderOfflineFragment()),
  ];
  const checks = [
    ...(await caddyChecks(install, storage, ctx, {
      pendingHost: routes[0]?.host,
      jsonFix: JSON_FIX_IN_INIT,
    })),
    ...fileChecks(),
    ...tailscale.checks,
    ...dns.checks,
  ];
  printSection("Checks", checks, paint, ctx);
  const ownHosts = new Set(
    [...machineHosts(devsiteDir), ...routes.map((r) => r.host)].flatMap((h) => {
      const { internal, localhost } = hostsOf(h.replace(/\.internal$/, ""));
      return [internal, localhost];
    }),
  );
  const repairs = repairsOf(checks, install);
  const dnsPlan =
    repairs.has("run-dnsmasq") && dns.dnsmasq !== null ? planDnsmasq(dns.dnsmasq) : null;
  const dropped = loadsConfig(install, repairs, changes)
    ? await droppedRoutes(install.config, ownHosts, ctx)
    : [];
  const steps = planSteps(
    {
      changes,
      install,
      settings,
      removedBinds,
      guardedSites,
      repairs,
      missingPortFiles,
      stateDir,
      dropped,
      dnsmasq: dnsPlan,
      splitDns: tailscale.route,
    },
    ctx,
  );
  // Printed until Caddy has the routes, so a set-up Mac prints nothing.
  const routesMissing = checks.some((r) => r.state === "red" && r.repair === "load");
  const jsonHelp =
    caddyfilePath === null && (changes.length > 0 || routesMissing)
      ? adaptedJson([renderGuardFile(), ...routes.map((r) => renderHostFile(r, null))], ctx)
      : "";

  // devsite's dnsmasq files sit outside the Caddy dir, so their diff labels are absolute paths.
  const dnsChanges: Change[] = (dnsPlan?.files ?? []).map((f) => ({
    rel: f.abs,
    abs: f.abs,
    next: f.next,
    generated: f.about,
  }));
  const allChanges = [...changes, ...dnsChanges];
  const relativeNote = (cs: Change[]) =>
    cs.some((c) => c.rel !== c.abs) ? ` (relative paths are in ${caddyDir})` : "";
  // Each piece ends with its own newline; concatenation is one multi-file unified diff, whose relative labels patch(1) applies with -p0 from the Caddyfile's dir.
  const diff = allChanges.map((c) => unifiedDiff(c, ctx)).join("");
  const fileCount = allChanges.length;

  if (dryRun) {
    if (steps.length === 0) ctx.stdout.write("\n--dry-run: nothing to do.\n");
    else printSteps("Plan", steps, paint, ctx);
    if (fileCount === 0) {
      ctx.stdout.write(
        `\n--dry-run: ${caddyfilePath ?? devsiteDir} and devsite.d are already up to date; nothing to write.\n`,
      );
    } else {
      ctx.stdout.write(`\n--dry-run: would change ${plural(fileCount, "file", "files")}.\n`);
      ctx.stdout.write(
        `\n${paint(BOLD, `The diff${relativeNote(allChanges)}`)}\n\n${paintDiff(diff, paint)}\n`,
      );
    }
    ctx.stdout.write(jsonHelp);
    return 0;
  }

  if (steps.length === 0) {
    ctx.stdout.write(`\n${paint(GREEN, "Nothing to do: init changed nothing.")}\n`);
    ctx.stdout.write(jsonHelp);
    return 0;
  }
  printSteps("Plan", steps, paint, ctx);
  // A file devsite writes whole holds nothing of the user's, so init names it in one line; --dry-run prints its diff.
  const shown = allChanges.filter((c) => c.generated === undefined);
  if (shown.length > 0) {
    ctx.stdout.write(`\n${paint(BOLD, `The diff${relativeNote(shown)}`)}\n\n`);
    ctx.stdout.write(`${paintDiff(shown.map((c) => unifiedDiff(c, ctx)).join(""), paint)}\n`);
  }
  const named = allChanges.flatMap((c) =>
    c.generated === undefined
      ? []
      : [`  ${c.rel} — ${c.generated}, ${existsSync(c.abs) ? "rewritten" : "new"}\n`],
  );
  if (named.length > 0) ctx.stdout.write(`\n${named.join("")}`);
  // A plan of manual steps only changes nothing on this Mac, so it needs no y: each manual step asks its own questions.
  const manualOnly = steps.every((s) => s.manual !== undefined);
  if (!ctx.stdin.isTTY) {
    if (manualOnly) {
      ctx.stdout.write("\nRun `bunx devsite init` in a terminal to be guided through it.\n");
      return 0;
    }
    ctx.stderr.write(
      "stdin is not a TTY — cannot ask for confirmation; nothing changed. " +
        "Run interactively, or use --dry-run to inspect the plan.\n",
    );
    return 1;
  }
  if (!manualOnly && !(await confirm(`\n${paint(BOLD, "Apply these changes? [Y/n]")} `, ctx))) {
    ctx.stderr.write("Stopped — nothing changed.\n");
    return 1;
  }
  // The split DNS step sends the phone to devsite's dnsmasq, so it waits until dnsmasq answers.
  await runSteps(steps, paint, ctx, async () => {
    if (dnsPlan !== null && dns.dnsmasq !== null) await waitForDnsmasq(dns.dnsmasq.ip, ctx);
  });
  const after = installAfter(settings, install, ctx);
  const storageAfter = await findStorage(after, ctx);
  const dnsAfter = probeDnsmasq(settings, ctx);
  const checksAfter = [
    ...(await caddyChecks(after, storageAfter, ctx, { jsonFix: JSON_FIX_IN_INIT })),
    ...fileChecks(),
    ...probeTailscale(dnsAfter.tailscale, ctx).checks,
    ...dnsAfter.checks,
  ];
  // A check the run just tried to fix points at that step: its fix line would send the user back to this same run.
  const ran = new Map(steps.flatMap((s) => (s.repair ? [[s.repair, s.text] as const] : [])));
  const stillRed = checksAfter.map((r): Result => {
    const step = r.state === "red" && r.repair ? ran.get(r.repair) : undefined;
    if (r.state !== "red" || step === undefined) return r;
    return {
      ...r,
      fix: `read the output of the step "${step}" above: it ran and this is still red`,
    };
  });
  printSection("Checks after this run", stillRed, paint, ctx);
  ctx.stdout.write(jsonHelp);
  if (steps.some((s) => s.repair === "trust")) {
    const phoneRoot = join(stateDir, "caddy-root.crt");
    printPhoneSteps(routes, await caRootFile(storageAfter, phoneRoot), ctx);
  }
  if (stillRed.every((r) => r.state !== "red")) {
    ctx.stdout.write("\nFrom now on, run `bun dev`; it needs no sudo.\n");
  }
  return 0;
}
