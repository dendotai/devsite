/**
 * devsite init — sets up this Mac once for every project's dev URLs (ADR 0005): installs the node, writes Caddy's one route to it, trusts Caddy's CA, and runs devsite's dnsmasq for the phone.
 *
 * Design notes:
 *   - devsite owns the `devsite.d/` directory next to the Caddyfile: the route for every devsite name (`node.caddy`) and the guard snippet a site of the user's own can import (`guard.caddy`). The user's Caddyfile gets a single `import devsite.d/*.caddy # devsite` line, once. devsite keeps the storage Caddy already uses: with no `storage` line it pins that storage in the Caddyfile's global options block, beside the `on_demand_tls` ask that lets Caddy sign a certificate only for a name the node knows. It creates the block (once) when the user has none, or adds its lines into the user's block (once). A block the user has touched is never rewritten — later runs only presence-check; a block that is purely devsite's own rendering re-renders fresh.
 *   - State-driven: init runs doctor's checks first and plans a fix only for each red one, so on a set-up Mac it asks nothing, runs no sudo, and leaves Caddy's live routes alone. Every plan shows one multi-file diff and asks first. The first Caddyfile write ever saves `Caddyfile.pre-devsite` and no code path touches it again; `.bak` holds the Caddyfile before the latest run.
 *   - Every step that needs root runs in one sudo call, so one password prompt covers the run whatever sudo's `timestamp_timeout` is.
 *
 * Run it as yourself, from any folder; a run as root is refused:
 *   bunx devsite init            # apply
 *   bunx devsite init --dry-run  # print the plan and the diff it would apply; touch nothing
 *
 * `bun dev` never needs sudo: it only tells the node which port the project runs on.
 */
// Adding a version-sensitive Node.js API here? Check engines.node in package.json, and consider a Node.js version matrix on the CI smoke step (ci.yml) — one version stops proving the floor.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
// bun-types types every .html import as an HTMLBundle for Bun.serve; the text attribute gives the file's text, which `bun build` inlines into dist, so the package ships no asset file.
import nodeDownPage from "../../assets/node-down.html" with { type: "text" };
import { type CaRoot, currentRootCert, describeRoot, importCaRoot, parseCaRoot } from "../ca";
import { adminBase, caddy } from "../caddy-admin";
import {
  type AdminOp,
  applyOp,
  type CaddyConfig,
  devsiteObjects,
  formatLike,
  initPrintsJson,
  planOps,
  readJsonConfig,
} from "../caddy-json";
import {
  type CaddyRoute,
  caddyChecks,
  certTarget,
  chainLabel,
  JSON_FIX_IN_INIT,
  nodeChecks,
  printSection,
  type Repair,
  type Result,
  readServers,
  type Servers,
} from "../checks";
import { callNode, NODE_PORT } from "../client.mjs";
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
import { SECRET_RE, storeSecret } from "../keychain";
import { installNode, readNode, readPeers } from "../node/install";
import type { RouteState } from "../node/main-mac";
import { RELAYED_HEADER } from "../node/relay";
import { nodeLog, supportDir } from "../paths";
import { readSettings, type Settings, settingsPath } from "../settings";
import { caRootFile, findStorage, rootCrtIn } from "../storage";
import { readSplitDns, TRUST_CREDENTIALS_URL, tailscaleChecks } from "../tailscale";

// Shorter than the 7-day intermediate, as Caddy's docs require (168h made each leaf end at the same second as its intermediate); 120h still outlasts a weekend with the Mac asleep.
const LEAF_LIFETIME = "120h";

// The one line devsite ever puts in the user's Caddyfile. The trailing comment tags the line for humans; the presence check tolerates it moving or losing the comment.
const IMPORT_LINE = "import devsite.d/*.caddy # devsite";
const IMPORT_RE = /^import devsite\.d\/\*\.caddy(?:[ \t]+#.*)?$/m;

const SUDO_NOTE = {
  init: "it calls sudo itself for the steps that need it",
  doctor: "it never needs sudo",
  "ca export": "it never needs sudo",
};

// init: as root, `brew services` would install a root service for a Caddy that runs as the user by default (ADR 0002), and every write would be root-owned; a root Caddy the user chose gets sudo for its own steps.
// doctor writes nothing, but as root it checks the wrong user: `security verify-cert` reads the trust settings of the user who runs it, and with no `storage` line the storage path comes from root's home. A script that runs doctor under sudo gets exit 1, not a gate on the wrong keychain.
// ca export, as root, reads root's own Caddy storage when the Caddyfile has no `storage` line, and prints a root no device trusts.
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
  const withoutOwn = inner
    .replace(/^[ \t]*storage file_system \{[\s\S]*?^[ \t]*\}\n?/m, "")
    .replace(ASK_BLOCK_RE, "");
  return withoutOwn
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

// Caddy reads it on every machine: to-main on the pass through the Caddy's own route, passed on the request the main Mac gets, which is never passed again.
const PASS_HEADER = "Devsite-Pass";

// Caddy signs a certificate for a devsite name at its first TLS handshake (`on_demand` in the route); it asks the node first, so a LAN host cannot make it sign one per name it sends.
const ASK_URL = `http://127.0.0.1:${NODE_PORT}/tls-allowed`;
const ASK_BLOCK_RE = /^[ \t]*on_demand_tls \{[\s\S]*?^[ \t]*\}\n?/m;
function askLines(): string[] {
  return [
    "\t# devsite: Caddy asks the devsite node before it signs a certificate for a name.",
    "\ton_demand_tls {",
    `\t\task ${ASK_URL}`,
    "\t}",
  ];
}
const hasAsk = (inner: string) => ASK_BLOCK_RE.test(inner);

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

export const NODE_ROUTE_FILE = "node.caddy";

const HEREDOC_END = "HTML";

// The page goes into a Caddyfile heredoc that Caddy fills with placeholders, so a `{` followed by a name (`{env.X}` prints an env var) or a line equal to the heredoc's end must never reach it.
function heredocLines(page: string, indent: string): string[] {
  page.split("\n").forEach((line, i) => {
    const brace = line.match(/\{\S/)?.[0];
    if (brace !== undefined) {
      throw new Error(
        `assets/node-down.html line ${i + 1} holds \`${brace}\`, which Caddy reads as a placeholder`,
      );
    }
    if (line.trim() === HEREDOC_END) {
      throw new Error(
        `assets/node-down.html line ${i + 1} is \`${HEREDOC_END}\`, which ends the page early`,
      );
    }
  });
  // The page's comments are notes for its editor, not for a visitor.
  return page
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => (line === "" ? "" : `${indent}${line}`));
}

// Caddy's one route for every devsite name: the LAN guard, then the node; when the node does not answer, Caddy passes the request to the main Mac or answers the "node not running" page itself. page null answers one line of text, for the JSON printed to a Caddy with no Caddyfile. The page closes the connection: a browser keeps an open one whatever the DNS now says, so a phone would stay on this machine after another one took over (#110). Caddy closes HTTP/1.1 and HTTP/2 on that header but not HTTP/3, so Alt-Svc tells browsers not to use HTTP/3 for these names.
// A phone keeps the old DNS answer for up to about 20 s, so a machine whose node refused the connection passes the request to the machine Tailscale's DNS names. The pass goes through this Caddy's own route (Devsite-Pass: to-main), because an error inside handle_errors shows no page. A request that may have run is not passed: Caddy itself sends only a safe one (a GET) to the node again, and passes it when that try is refused. A passed answer other than a 502 keeps the connection open, because Chrome loses modules of a page when each answer closes it.
export function renderNodeRoute(page: string | null = nodeDownPage as unknown as string): string {
  const down =
    page === null
      ? [
          "\t\theader {",
          "\t\t\tAlt-Svc clear",
          "\t\t\tConnection close",
          "\t\t}",
          '\t\trespond "devsite: the node does not answer — run bunx devsite doctor" 502',
        ]
      : [
          "\t\theader {",
          '\t\t\tContent-Type "text/html; charset=utf-8"',
          "\t\t\tCache-Control no-store",
          "\t\t\tAlt-Svc clear",
          "\t\t\tConnection close",
          "\t\t}",
          `\t\trespond <<${HEREDOC_END}`,
          ...heredocLines(page, "\t\t\t"),
          `\t\t\t${HEREDOC_END} 502`,
        ];
  return [
    "# devsite: the route for every devsite name, to the devsite node. init writes this file whole.",
    "*.internal, *.localhost {",
    "\ttls {",
    "\t\tissuer internal {",
    `\t\t\tlifetime ${LEAF_LIFETIME}`,
    "\t\t}",
    "\t\ton_demand",
    "\t}",
    ...guardCaddyfileLines(),
    `\t@to-main header ${PASS_HEADER} to-main`,
    "\treverse_proxy @to-main {",
    "\t\tdynamic a {",
    // The dot at the end: with no search domains, a DNS server that never replies costs 10 s for each nameserver in /etc/resolv.conf (20 s with Tailscale's two), not a minute.
    "\t\t\tname {host}.",
    "\t\t\tport 443",
    "\t\t\tresolvers 100.100.100.100",
    "\t\t\trefresh 1s",
    "\t\t\tversions ipv4",
    "\t\t}",
    "\t\theader_up Host {host}",
    `\t\theader_up ${PASS_HEADER} passed`,
    "\t\ttransport http {",
    "\t\t\ttls_server_name {host}",
    "\t\t\tdial_timeout 1500ms",
    "\t\t\ttls_timeout 1500ms",
    "\t\t}",
    "\t}",
    // Inside reverse_proxy, because Caddy runs a bare header line before the guard. A 101 goes past it, so a WebSocket still opens.
    `\treverse_proxy 127.0.0.1:${NODE_PORT} {`,
    "\t\t@answer status 2xx 3xx 4xx 5xx",
    "\t\thandle_response @answer {",
    "\t\t\theader >Alt-Svc clear",
    "\t\t\tcopy_response",
    "\t\t}",
    "\t}",
    "\thandle_errors 502 503 504 {",
    "\t\t@pass {",
    "\t\t\thost *.internal",
    `\t\t\tnot header ${PASS_HEADER} *`,
    `\t\t\tnot header ${RELAYED_HEADER} *`,
    `\t\t\texpression \`{http.error.message}.startsWith("dial tcp 127.0.0.1:${NODE_PORT}")\``,
    "\t\t}",
    "\t\thandle @pass {",
    "\t\t\treverse_proxy 127.0.0.1:443 {",
    "\t\t\t\theader_up Host {host}",
    `\t\t\t\theader_up ${PASS_HEADER} to-main`,
    "\t\t\t\ttransport http {",
    "\t\t\t\t\ttls_server_name {host}",
    "\t\t\t\t\ttls_insecure_skip_verify",
    "\t\t\t\t}",
    "\t\t\t\t@down status 502",
    "\t\t\t\thandle_response @down {",
    "\t\t\t\t\theader {",
    "\t\t\t\t\t\t>Alt-Svc clear",
    "\t\t\t\t\t\t>Connection close",
    "\t\t\t\t\t}",
    "\t\t\t\t\tcopy_response",
    "\t\t\t\t}",
    "\t\t\t\t@answer status 2xx 3xx 4xx 5xx",
    "\t\t\t\thandle_response @answer {",
    "\t\t\t\t\theader >Alt-Svc clear",
    "\t\t\t\t\tcopy_response",
    "\t\t\t\t}",
    "\t\t\t}",
    "\t\t}",
    "\t\thandle {",
    ...down.map((l) => (l === "" ? l : `\t${l}`)),
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");
}

// One planned file operation; next === null deletes the file. rel is the diff's label: the path relative to the Caddyfile's directory, or the absolute path of a file outside it.
// generated: what a file devsite writes whole is; init names such a file in one line, and --dry-run prints its diff.
type Change = { rel: string; abs: string; next: string | null; generated?: string };

function dirsToMake(changes: Change[], userFile: string | null): string[] {
  return [
    ...new Set(
      changes.filter((c) => c.next !== null && c.abs !== userFile).map((c) => dirname(c.abs)),
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

const LAYOUT_HINT =
  "Press y or n. A non-Latin layout types another letter, so switch to a Latin layout.";

// y or n, read through the layout map, so the Y key answers on any layout. Any other key asks again.
async function readAnswer(
  question: string,
  ctx: CliContext,
): Promise<"y" | "n" | "enter" | "stop"> {
  // The lookup runs while the question waits for a key: its cold start is about a second.
  const letters = ctx.latinLetters();
  for (;;) {
    const key = await readKey(question, ctx);
    if (key.startsWith(CTRL_C)) return "stop";
    if (/^[\r\n]/.test(key)) return "enter";
    const typed = ([...key][0] ?? "").toLowerCase();
    const letter = (await letters).get(typed) ?? typed;
    if (letter === "y" || letter === "n") return letter;
    ctx.stdout.write(`\n${LAYOUT_HINT}\n`);
  }
}

// Ctrl-C reads as "stop".
async function confirm(question: string, ctx: CliContext): Promise<boolean> {
  // Y is the default, as in apt: Enter applies too.
  const answer = await readAnswer(question, ctx);
  const yes = answer === "y" || answer === "enter";
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

// A CA root from `init --ca -` that differs from the one in Caddy's storage; replaces is the old root's description, null for a storage with none.
type CaImport = { root: CaRoot; storageRoot: string; replaces: string | null };

type StepPlan = {
  changes: Change[];
  // The config file of the user's that init edits and reloads: a Caddyfile, or a JSON file; null for a Caddy with no file.
  userFile: string | null;
  // The admin API requests that put devsite's objects into a Caddy with no config file.
  adminOps: AdminOp[];
  // Why a restart of that Caddy drops what the requests add; null when it keeps it.
  restartNote: string | null;
  caImport: CaImport | null;
  // `init --ca -` restarts a running Caddy after an import, and again on a rerun while Caddy still serves another root.
  restartCaddy: boolean;
  install: KnownInstall;
  settings: Settings;
  removedBinds: string[];
  guardedSites: string[];
  repairs: Set<Repair>;
  // Shown under the load step: one line per live route the load drops, or one line that says init cannot list them.
  dropped: string[];
  // null when no check calls for devsite's dnsmasq.
  dnsmasq: DnsmasqPlan | null;
  // From `init --tailscale-secret -`; null when the step asks for it.
  pipedSecret: string | null;
};

// Under a root Caddy its files are root-owned: each file is staged in the temp dir and copied into place with sudo.
function rootWriteCommands(changes: Change[], userFile: string | null) {
  const commands: string[][] = [];
  if (userFile !== null && changes.some((c) => c.abs === userFile) && existsSync(userFile)) {
    if (!existsSync(`${userFile}.pre-devsite`)) {
      commands.push(["cp", userFile, `${userFile}.pre-devsite`]);
    }
    commands.push(["cp", userFile, `${userFile}.bak`]);
  }
  for (const dir of dirsToMake(changes, userFile)) commands.push(["mkdir", "-p", dir]);
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

// A start would run Homebrew's Caddyfile, so a Caddy with no Caddyfile gets none; one init prints the JSON for gets no load either.
function repairsOf(checks: Result[], install: KnownInstall, printsJson: boolean): Set<Repair> {
  const skip = (r: Repair) =>
    (r === "start" && install.configKind !== "caddyfile") || (r === "load" && printsJson);
  return new Set(
    checks.flatMap((r) => (r.state !== "green" && r.repair && !skip(r.repair) ? [r.repair] : [])),
  );
}

// A start reads the files written before it, so a run that starts Caddy needs no load.
function loadsConfig(
  userFile: string | null,
  repairs: Set<Repair>,
  changes: Change[],
): userFile is string {
  return userFile !== null && !repairs.has("start") && (changes.length > 0 || repairs.has("load"));
}

function reloadCommand(install: KnownInstall, userFile: string): string[] {
  const adapter = install.configKind === "caddyfile" ? ["--adapter", "caddyfile"] : [];
  return ["caddy", "reload", "--config", userFile, ...adapter];
}

// The live config, for the admin API requests planned against it: null for a Caddy with no config yet, undefined when the admin API does not answer.
async function readLiveConfig(): Promise<CaddyConfig | null | undefined> {
  try {
    const res = await caddy("/config/", { signal: AbortSignal.timeout(2000) });
    return res.ok ? ((await res.json()) as CaddyConfig | null) : undefined;
  } catch {
    return undefined;
  }
}

async function sendOps(ops: AdminOp[]) {
  for (const op of ops) {
    const res = await caddy(op.path, {
      method: op.method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(op.body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(
        `Caddy's admin API refused ${op.method} ${op.path} (HTTP ${res.status}): ${(await res.text()).trim()}`,
      );
    }
  }
}

// Caddy saves each config pushed to its admin API to autosave.json, and only `caddy run --resume` loads that file at start.
function restartNoteOf(install: KnownInstall, live: CaddyConfig | null): string | null {
  const admin = live?.admin as { config?: { persist?: boolean } } | undefined;
  if (admin?.config?.persist === false) {
    return "Caddy's config turns admin.config.persist off: a restart drops devsite's route; run bunx devsite init after each restart.";
  }
  if (install.running?.resume !== true) {
    return "Caddy runs with no --config and no --resume: a restart drops devsite's route; start Caddy with --resume, or run bunx devsite init after each restart.";
  }
  return null;
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

// A load replaces the live config with the adapted Caddyfile, or with the JSON file, so it drops each route another tool added through the admin API at runtime.
async function droppedRoutes(
  from: { caddyfile: string } | { json: unknown },
  ctx: CliContext,
): Promise<string[]> {
  const live = await readServers();
  if (!live.ok) return [];
  let adapted: CaddyRoute[] = [];
  if ("json" in from) {
    const json = from.json as { apps?: { http?: { servers?: Servers } } };
    adapted = allRoutes(json.apps?.http?.servers ?? {});
  } else if (existsSync(from.caddyfile)) {
    const config = from.caddyfile;
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
  const kept = new Set(adapted.flatMap(routeHosts));
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
  const { install, userFile } = p;
  const asRoot = install.user === "root";
  const { repairs } = p;
  const steps: Step[] = [];
  // User space, so no sudo even for a root Caddy. It installs the devsite version init runs from.
  if (repairs.has("node")) {
    steps.push({
      text: "install the node and start it at login, as you",
      repair: "node",
      run: async () => installNode(ctx),
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
            root: rootWriteCommands(p.changes, userFile),
          }
        : {
            text,
            planNote,
            repair: "write",
            details,
            run: async () => applyChanges(p.changes, userFile),
          },
    );
  }
  const { caImport } = p;
  if (caImport !== null) {
    const name = describeRoot(caImport.root.cert);
    const run = async () => importCaRoot(caImport.storageRoot, caImport.root);
    steps.push(
      caImport.replaces === null
        ? {
            text: "put the imported CA root into Caddy's storage",
            details: [`${name}, in ${caImport.storageRoot}`],
            run,
          }
        : {
            text: "replace Caddy's CA root",
            details: [
              `replaces ${caImport.replaces} with ${name}, in ${caImport.storageRoot}`,
              "deletes the intermediate and the certificates the old root signed; Caddy signs new ones at the next visit",
              "a phone or browser that trusts only the old root needs the new one: init prints the phone's steps",
            ],
            run,
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
  } else if (loadsConfig(userFile, repairs, p.changes)) {
    // `caddy reload` adapts a Caddyfile and posts the config to the running Caddy's admin API, whatever service manager runs Caddy.
    const reload = reloadCommand(install, userFile);
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
  if (p.adminOps.length > 0) {
    steps.push({
      text: "add devsite's route to Caddy through its admin API",
      details: [
        ...p.adminOps.map((o) => o.planLine),
        ...(p.restartNote === null ? [] : [p.restartNote]),
      ],
      repair: "load",
      run: () => sendOps(p.adminOps),
    });
  }
  // A reload makes a new intermediate but keeps serving the certificates Caddy holds in memory, so only a restart serves the imported root.
  if (p.restartCaddy && install.running !== null && !repairs.has("start")) {
    steps.push({
      text: "restart Caddy, so it serves certificates from the imported root",
      run: async () => {
        runInTerminal("brew", ["services", "restart", "caddy"], ctx);
        if (!(await waitForCaddyAdmin())) {
          throw new Error(
            `Caddy did not answer within ${ADMIN_WAIT_MS / 1000} s of its restart. See ${install.log ?? "Caddy's log"}, then pipe the root into \`bunx devsite init --ca -\` again: it restarts Caddy.`,
          );
        }
      },
    });
  }
  // Caddy's own auto-trust needs an interactive prompt it cannot get as a background service, so init runs `caddy trust`; it reads the CA from the admin API, which the steps above leave answering.
  if (repairs.has("trust")) {
    steps.push({ text: "trust Caddy's local CA", repair: "trust", root: [["caddy", "trust"]] });
  }
  if (p.dnsmasq !== null) steps.push(...dnsmasqSteps(p.dnsmasq, ctx));
  if (repairs.has("tailscale-secret")) steps.push(secretStep(p.pipedSecret, ctx));
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

const ROUTE_WAIT_MS = 10_000;

const SECRET_STEP =
  "store the Tailscale OAuth client secret in the login Keychain, so the node writes the split DNS route";

// piped: the secret from `init --tailscale-secret -`; null asks for it at a prompt that shows nothing typed.
function secretStep(piped: string | null, ctx: CliContext): Step {
  const store = async (secret: string) => {
    if (!storeSecret(secret, ctx)) {
      throw new Error("`security` could not store the secret in the login Keychain");
    }
    ctx.stdout.write("  Stored in the login Keychain.\n");
  };
  // The node takes the route only once dnsmasq answers, which a sudo step may still set up, so init reports the route after that step.
  if (piped !== null) {
    return { text: SECRET_STEP, repair: "tailscale-secret", run: () => store(piped) };
  }
  return {
    text: SECRET_STEP,
    details: [
      `Create a Tailscale OAuth client: ${TRUST_CREDENTIALS_URL}`,
      "Choose Credential, then OAuth, then tick Write next to DNS.",
      "Don't forget to back up the secret. Tailscale won't show it again.",
    ],
    repair: "tailscale-secret",
    manual: async () => {
      for (;;) {
        const secret = await readHidden("Tailscale OAuth client secret: ", ctx);
        if (secret === null || secret === "") {
          ctx.stdout.write(
            "  Skipped. This Mac won't write the .internal route until you add the secret.\n",
          );
          return;
        }
        if (SECRET_RE.test(secret)) {
          await store(secret);
          return reportRoute(ctx);
        }
        ctx.stdout.write(
          "  That doesn't look like an OAuth client secret. It should start with tskey-client-.\n",
        );
      }
    },
  };
}

// Tailscale hands a new route to each device within seconds, and the checks at the end of the run read it there.
async function waitForRoute(ip: string, ctx: CliContext) {
  const deadline = Date.now() + ROUTE_WAIT_MS;
  while (readSplitDns(ip, ctx).state !== "this-mac" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
}

// The node reads the route as soon as init asks, so init says at once which Mac it names.
async function reportRoute(ctx: CliContext) {
  let route: RouteState;
  try {
    const res = await callNode("/route", { method: "POST", signal: AbortSignal.timeout(15_000) });
    route = (await res.json()) as RouteState;
  } catch {
    ctx.stdout.write(`  The node did not answer; its log: ${nodeLog(ctx.env)}\n`);
    return;
  }
  switch (route.role) {
    case "main":
      await waitForRoute(route.ip, ctx);
      ctx.stdout.write(`  The split DNS route for .internal names this Mac (${route.ip}).\n`);
      return;
    case "follower": {
      // A route to a device that is no Mac of this user names only its IP.
      ctx.stdout.write(
        route.mac === route.ip
          ? `  The split DNS route for .internal names ${route.ip}, which is none of your Macs; this Mac takes it over in about 6 s if no node answers there.\n`
          : `  The split DNS route for .internal names ${route.mac} (${route.ip}); another Mac takes it over when ${route.mac} goes.\n`,
      );
      return;
    }
    case "no-secret":
      ctx.stdout.write(
        `  The node reads no secret from the login Keychain; its log: ${nodeLog(ctx.env)}\n`,
      );
      return;
    case "unknown":
      ctx.stdout.write(
        `  The node did not write the route: ${route.why}. Its log: ${nodeLog(ctx.env)}\n`,
      );
  }
}

// A line typed with nothing shown, as a password prompt reads it; null for Ctrl-C or the end of the input.
async function readHidden(question: string, ctx: CliContext): Promise<string | null> {
  ctx.stdout.write(question);
  const stdin = ctx.stdin as CliContext["stdin"] & { setRawMode?: (on: boolean) => unknown };
  stdin.setRawMode?.(true);
  stdin.resume();
  let line = "";
  const answer = await new Promise<string | null>((resolve) => {
    const onData = (d: unknown) => {
      for (const c of String(d)) {
        if (c === CTRL_C) return finish(null);
        if (c === "\r" || c === "\n") return finish(line.trim());
        if (c === "\x7f" || c === "\b") line = line.slice(0, -1);
        else line += c;
      }
    };
    const finish = (value: string | null) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.pause();
      resolve(value);
    };
    const onEnd = () => finish(null);
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
  stdin.setRawMode?.(false);
  ctx.stdout.write("\n");
  return answer;
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

function applyChanges(changes: Change[], userFile: string | null) {
  if (userFile !== null && changes.some((c) => c.abs === userFile) && existsSync(userFile)) {
    // The world before devsite ever touched it — created once, never written again.
    if (!existsSync(`${userFile}.pre-devsite`)) {
      copyFileSync(userFile, `${userFile}.pre-devsite`);
    }
    copyFileSync(userFile, `${userFile}.bak`);
  }
  for (const dir of dirsToMake(changes, userFile)) mkdirSync(dir, { recursive: true });
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
function printPhoneSteps(caRoot: string | null, ctx: CliContext) {
  ctx.stdout.write(
    [
      "",
      "Manual, per-device (one-time — can't be automated from here):",
      "  • On each phone: install and trust the CA root, then open a project at https://<name>.internal",
      caRoot === null
        ? `      Caddy makes its CA when it first serves a project; then save it with \`curl -s ${adminBase()}/pki/ca/local | jq -r .root_certificate > caddy-root.crt\``
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
  //   - anything the user touched: preserved byte-for-byte; devsite appends each of its lines the block lacks, once.
  //   - none: devsite creates one for its lines.
  const g = findGlobalBlock(text);
  const pin = pinRoot === null ? [] : storagePinLines(pinRoot);
  let block: string[] | null = [...pin, ...askLines()];
  if (g !== null) {
    if (foreignGlobalDirectives(g.inner).length === 0) {
      const kept = g.inner.match(/^\s*root\s+"?([^"\n]+?)"?\s*$/m)?.[1];
      block = [...(kept !== undefined ? storagePinLines(kept) : pin), ...askLines()];
      text = text.slice(0, g.start) + text.slice(g.end);
    } else {
      const add = [...(hasStoragePin(g.inner) ? [] : pin), ...(hasAsk(g.inner) ? [] : askLines())];
      if (add.length > 0) {
        const closing = g.full.lastIndexOf("}");
        const augmented = `${g.full.slice(0, closing)}${add.join("\n")}\n${g.full.slice(closing)}`;
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

// devsite's files as Caddy's adapter makes them into JSON: one server for the route and its error route, one TLS policy for its `issuer internal`, and the ask from the global block.
// withPage false answers one line of text in place of the "node not running" page.
function adaptDevsite(withPage: boolean, ctx: CliContext): unknown {
  const route = withPage ? renderNodeRoute() : renderNodeRoute(null);
  const files = [["{", ...askLines(), "}"].join("\n"), renderGuardFile(), route];
  const r = exec(
    "caddy",
    ["adapt", "--config", writeTmp(files.join("\n")), "--adapter", "caddyfile"],
    ctx,
    true,
  );
  if (r.status !== 0) throw new Error("`caddy adapt` could not adapt devsite's route");
  return JSON.parse(r.out);
}

// For a Caddy init cannot put devsite's objects into, init prints them; the page is one line of text, because the "node not running" page would add several KB to the printout.
function adaptedJson(ctx: CliContext): string {
  const config = adaptDevsite(false, ctx) as {
    apps?: {
      http?: { servers?: unknown };
      tls?: { automation?: { policies?: unknown; on_demand?: unknown } };
    };
  };
  const json = (v: unknown) => JSON.stringify(v ?? null, null, 2).replace(/^/gm, "    ");
  return [
    "",
    "Add devsite's route to your Caddy config, as JSON, then run `bunx devsite doctor`:",
    "  apps.http.servers — the routes go into your server that listens on :443:",
    json(config.apps?.http?.servers),
    "  apps.tls.automation.policies — append these policies:",
    json(config.apps?.tls?.automation?.policies),
    "  apps.tls.automation.on_demand — set it to:",
    json(config.apps?.tls?.automation?.on_demand),
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
  { dryRun, ca, tailscaleSecret }: { dryRun: boolean; ca?: string; tailscaleSecret?: string },
  given: CliContext = processContext(),
): Promise<number> {
  let ctx = given;
  if (refuseRoot("init", ctx)) return 1;
  let imported: CaRoot | null = null;
  let pipedSecret: string | null = null;
  if (ca !== undefined && tailscaleSecret !== undefined) {
    ctx.stderr.write(
      "--ca - and --tailscale-secret - both read standard input: run init once for each\n",
    );
    return 1;
  }
  if (tailscaleSecret !== undefined) {
    if (tailscaleSecret !== "-") {
      ctx.stderr.write(
        "--tailscale-secret takes only -, which reads the secret from standard input, so it stays out of your shell history\n",
      );
      return 1;
    }
    if (ctx.stdin.isTTY) {
      ctx.stderr.write(
        "--tailscale-secret - reads the secret from standard input. Pipe it in, for example from your password manager's command line.\n",
      );
      return 1;
    }
    let text = "";
    for await (const chunk of ctx.stdin) text += chunk;
    if (!SECRET_RE.test(text.trim())) {
      ctx.stderr.write(
        "standard input needs one Tailscale OAuth client secret, which starts with tskey-client-; nothing changed.\n",
      );
      return 1;
    }
    pipedSecret = text.trim();
    ctx = { ...ctx, stdin: ctx.terminal() ?? Object.assign(Readable.from([]), { isTTY: false }) };
  }
  if (ca !== undefined) {
    if (ca !== "-") {
      ctx.stderr.write("--ca takes only -, which reads the CA root from standard input\n");
      return 1;
    }
    if (ctx.stdin.isTTY) {
      ctx.stderr.write(
        "--ca - reads the CA root from standard input: pipe it in, as `devsite ca export` on another Mac prints it\n",
      );
      return 1;
    }
    let text = "";
    for await (const chunk of ctx.stdin) text += chunk;
    const parsed = parseCaRoot(text);
    if (typeof parsed === "string") {
      ctx.stderr.write(`${parsed}; nothing changed.\n`);
      return 1;
    }
    imported = parsed;
    // stdin was the pipe, so the questions go to the terminal.
    ctx = { ...ctx, stdin: ctx.terminal() ?? Object.assign(Readable.from([]), { isTTY: false }) };
  }

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
  let caImport: CaImport | null = null;
  if (imported !== null) {
    const refusal =
      storage.root === null
        ? `devsite cannot read Caddy's storage (${storage.source})`
        : install.user === "root"
          ? "init --ca imports only into a Caddy that runs as you; this one runs as root"
          : install.running !== null && install.manager !== "brew services"
            ? `Caddy runs under ${install.manager}, which init cannot restart: stop Caddy, run init --ca - again, then start Caddy`
            : null;
    if (storage.root === null || refusal !== null) {
      ctx.stderr.write(`${refusal}; nothing changed.\n`);
      return 1;
    }
    const current = currentRootCert(storage.root);
    if (current?.fingerprint256 !== imported.cert.fingerprint256) {
      caImport = {
        root: imported,
        storageRoot: storage.root,
        replaces: current === null ? null : describeRoot(current),
      };
    }
  }

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

  // Only a Caddyfile imports devsite.d.
  const desired = new Map<string, string>(
    caddyfilePath === null
      ? []
      : [
          [GUARD_FILE, renderGuardFile()],
          [NODE_ROUTE_FILE, renderNodeRoute()],
        ],
  );
  for (const [name, content] of desired) {
    const abs = join(devsiteDir, name);
    if (!existsSync(abs) || readFileSync(abs, "utf8") !== content) {
      const generated = name === NODE_ROUTE_FILE ? "devsite's route to the node" : undefined;
      changes.push({ rel: `devsite.d/${name}`, abs, next: content, generated });
    }
  }

  // A Caddy with no Caddyfile takes devsite's objects into its JSON file, or through its admin API when it has no file.
  const jsonFile = install.configKind === "json" ? readJsonConfig(install.config) : null;
  const printsJson = initPrintsJson(install, settings, jsonFile);
  const userFile = caddyfilePath ?? (jsonFile === null ? null : install.config);
  let nextJson: unknown = jsonFile?.config ?? null;
  let adminOps: AdminOp[] = [];
  let restartNote: string | null = null;
  if (install.configKind !== "caddyfile" && !printsJson) {
    const objects = devsiteObjects(adaptDevsite(true, ctx));
    if (install.configKind === "json" && jsonFile !== null) {
      const ops = planOps(jsonFile.config, objects);
      if (ops.length > 0) {
        nextJson = ops.reduce<unknown>(applyOp, jsonFile.config);
        const next = formatLike(jsonFile.text, nextJson);
        changes.push({ rel: basename(install.config), abs: install.config, next });
      }
    } else {
      const live = await readLiveConfig();
      if (live !== undefined) {
        adminOps = planOps(live, objects);
        restartNote = adminOps.length > 0 ? restartNoteOf(install, live) : null;
      }
    }
  }
  changes.sort((a, b) => a.rel.localeCompare(b.rel));

  const paint = painter(ctx.stdout, ctx);
  ctx.stdout.write(`${paint(BOLD, "devsite init")}\n`);

  const node = await readNode();
  const dns = probeDnsmasq(settings, ctx);
  const tailscale = tailscaleChecks(dns.tailscale, node.ok ? await readPeers() : [], ctx);
  const checks = [
    ...nodeChecks(node, ctx),
    ...(await caddyChecks(install, storage, ctx, {
      cert: certTarget(node),
      jsonFix: printsJson ? JSON_FIX_IN_INIT : undefined,
    })),
    ...tailscale,
    ...dns.checks,
  ];
  printSection("Checks", checks, paint, ctx);
  const repairs = repairsOf(checks, install, printsJson);
  // A piped secret replaces the one in the Keychain, as for a secret made anew.
  if (pipedSecret !== null) repairs.add("tailscale-secret");
  // The trust check above read the old root; the imported root decides the trust step.
  if (caImport !== null) {
    const cert = writeTmp(caImport.root.certPem);
    const trusted = exec("security", ["verify-cert", "-c", cert, "-p", "ssl"], ctx, true);
    rmSync(cert, { force: true });
    if (trusted.status === 0) repairs.delete("trust");
    else repairs.add("trust");
  }
  const restartCaddy =
    imported !== null &&
    (caImport !== null || checks.some((r) => r.state === "red" && r.label === chainLabel));
  const dnsPlan =
    repairs.has("run-dnsmasq") && dns.dnsmasq !== null ? planDnsmasq(dns.dnsmasq) : null;
  const dropped = loadsConfig(userFile, repairs, changes)
    ? await droppedRoutes(
        caddyfilePath !== null ? { caddyfile: caddyfilePath } : { json: nextJson },
        ctx,
      )
    : [];
  const steps = planSteps(
    {
      changes,
      userFile,
      adminOps,
      restartNote,
      caImport,
      restartCaddy,
      install,
      settings,
      removedBinds,
      guardedSites,
      repairs,
      dropped,
      dnsmasq: dnsPlan,
      pipedSecret,
    },
    ctx,
  );
  // Printed until Caddy has the route, so a set-up Mac prints nothing.
  const routeMissing = checks.some((r) => r.state === "red" && r.repair === "load");
  const jsonHelp = printsJson && (changes.length > 0 || routeMissing) ? adaptedJson(ctx) : "";

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
        caddyfilePath !== null
          ? `\n--dry-run: ${caddyfilePath} and devsite.d are already up to date; nothing to write.\n`
          : `\n--dry-run: ${userFile === null ? "no file" : `${userFile} is already up to date`}; nothing to write.\n`,
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
    const piped = imported !== null ? "--ca" : pipedSecret !== null ? "--tailscale-secret" : null;
    ctx.stderr.write(
      piped === null
        ? "stdin is not a TTY — cannot ask for confirmation; nothing changed. " +
            "Run interactively, or use --dry-run to inspect the plan.\n"
        : "no terminal to ask on — cannot ask for confirmation; nothing changed. " +
            `Run \`init ${piped} -\` in a terminal, or add --dry-run to inspect the plan.\n`,
    );
    return 1;
  }
  if (!manualOnly && !(await confirm(`\n${paint(BOLD, "Apply these changes? [Y/n]")} `, ctx))) {
    ctx.stderr.write("Stopped — nothing changed.\n");
    return 1;
  }
  // The node takes the route only when dnsmasq answers, so the secret prompt and the report on a piped secret wait for dnsmasq.
  await runSteps(steps, paint, ctx, async () => {
    if (dnsPlan !== null && dns.dnsmasq !== null) await waitForDnsmasq(dns.dnsmasq.ip, ctx);
    if (pipedSecret !== null) await reportRoute(ctx);
  });
  const after = installAfter(settings, install, ctx);
  const storageAfter = await findStorage(after, ctx);
  const nodeAfter = await readNode();
  const dnsAfter = probeDnsmasq(settings, ctx);
  const checksAfter = [
    ...nodeChecks(nodeAfter, ctx),
    ...(await caddyChecks(after, storageAfter, ctx, {
      cert: certTarget(nodeAfter),
      jsonFix: printsJson ? JSON_FIX_IN_INIT : undefined,
    })),
    ...tailscaleChecks(dnsAfter.tailscale, nodeAfter.ok ? await readPeers() : [], ctx),
    ...dnsAfter.checks,
  ];
  // A check the run just tried to fix points at that step: its fix line would send the user back to this same run. A manual step that failed stopped the run, so one that is still red was skipped and keeps its fix.
  const ran = new Map(
    steps.flatMap((s) => (s.repair && !s.manual ? [[s.repair, s.text] as const] : [])),
  );
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
  if (steps.some((s) => s.repair === "trust") || caImport?.replaces) {
    const phoneRoot = join(supportDir(ctx.env), "caddy-root.crt");
    printPhoneSteps(await caRootFile(storageAfter, phoneRoot), ctx);
  }
  if (stillRed.every((r) => r.state !== "red")) {
    ctx.stdout.write("\nFrom now on, run `bun dev` in any project; it needs no sudo.\n");
  }
  return 0;
}
