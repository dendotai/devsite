// Shared fixtures for the CLI and Vite-plugin test suites.
// The setup import is a belt-and-braces double of the bunfig.toml preload: its scratch home holds even when bun test runs from a cwd where bunfig.toml is not picked up.
import "./setup";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import type { Plugin } from "vite";
import { type CliContext, type CommandResult, processRunner } from "../src/context";
import { run } from "../src/run";

export function sink() {
  const chunks: string[] = [];
  return {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    text: () => chunks.join(""),
  };
}

// A stdin pre-loaded with `input`, posing as a TTY (or not) — what the interactive confirm flow reads. Each string of an array is one key press, read by one prompt.
export function fakeStdin(input: string | string[], isTTY: boolean) {
  const s = Readable.from(typeof input === "string" ? [input] : input) as Readable & {
    isTTY?: boolean;
  };
  s.isTTY = isTTY;
  Object.assign(s, { keys: typeof input === "string" ? [input] : input });
  return s;
}

export type IoOpts = {
  cwd?: string;
  // A Caddyfile at <prefix>/etc/Caddyfile: the run sees <prefix> as the Homebrew prefix.
  caddyfile?: string;
  // The home devsite's files hang from: ~/Library/Application Support/devsite/config.json and the rest.
  home?: string;
  stdin?: CliContext["stdin"];
  runCommand?: CliContext["runCommand"];
  env?: CliContext["env"];
};

// A CliContext over in-memory io. The env holds only the scratch prefix and the home tests/setup.ts points at, so an ambient DEVSITE_UID can never leak in.
export function makeIo(opts: IoOpts = {}) {
  const stdout = sink();
  const stderr = sink();
  const ctx: CliContext = {
    stdout,
    stderr,
    stdin: opts.stdin ?? fakeStdin("", false),
    cwd: opts.cwd ?? makeEmptyRepo(),
    env: {
      DEVSITE_BREW_PREFIX: dirname(dirname(opts.caddyfile ?? scratchCaddyfile())),
      DEVSITE_USER_HOME: opts.home ?? process.env.DEVSITE_USER_HOME,
      DEVSITE_NODE_PROGRAM: process.env.DEVSITE_NODE_PROGRAM,
      ...opts.env,
    },
    runCommand: opts.runCommand ?? quietRunner().runCommand,
  };
  return { ctx, stdout, stderr };
}

export type CommandCall = { cmd: string; args: string[]; capture: boolean; timeoutMs?: number };

// What spawnSync gives for a command that is not on PATH.
export const MISSING: Partial<CommandResult> = {
  status: 1,
  error: Object.assign(new Error("spawnSync ENOENT"), { code: "ENOENT" }),
};

// diff runs for real; every other command fails as if missing, so no test reads this Mac's processes, Homebrew, or Caddy.
export function quietRunner(
  answer: (call: CommandCall) => Partial<CommandResult> | null = () => null,
) {
  return scriptedRunner((c) => {
    const scripted = answer(c);
    if (scripted !== null) return scripted;
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    return MISSING;
  });
}

// Runs nothing and records each call; a field the answer leaves out reads as exit 0 with empty stdout.
export function scriptedRunner(answer: (call: CommandCall) => Partial<CommandResult>) {
  const calls: CommandCall[] = [];
  const runCommand: CliContext["runCommand"] = (cmd, args, { capture, timeoutMs }) => {
    const call = { cmd, args, capture, timeoutMs };
    calls.push(call);
    return { status: 0, stdout: "", ...answer(call) };
  };
  return { runCommand, calls };
}

// One in-process CLI invocation: argv in, exit code + captured output out.
export async function cli(argv: string[], opts: IoOpts = {}) {
  const { ctx, stdout, stderr } = makeIo(opts);
  const status = await runAndRecordScenario(argv, ctx);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

// run(), plus a record of the run in the file DEVSITE_SCENARIOS_FILE names (`bun run scenarios`), so every flow's words can be read as one transcript.
export async function runAndRecordScenario(argv: string[], ctx: CliContext): Promise<number> {
  const scenario = process.env.DEVSITE_SCENARIOS_FILE ? currentTest() : undefined;
  const status = await run(argv, ctx);
  const out = process.env.DEVSITE_SCENARIOS_FILE;
  if (out && scenario) {
    const keys = (ctx.stdin as { keys?: string[] }).keys?.filter((k) => k !== "");
    const text = [
      `## ${scenario}`,
      "",
      "```text",
      `$ devsite ${argv.join(" ")}${keys?.length ? `   (keys: ${keys.map((k) => JSON.stringify(k)).join(" ")})` : ""}`,
      (ctx.stdout as ReturnType<typeof sink>).text?.() ?? "",
      (ctx.stderr as ReturnType<typeof sink>).text?.() ?? "",
      `(exit ${status})`,
      "```",
      "",
    ].join("\n");
    appendFileSync(out, readablePaths(text));
  }
  return status;
}

// The title of the test that is running, read from its source: bun:test exposes no test name. The outermost frame in a test file is the test's own callback; the nearest `test(` above that line holds the title.
function currentTest(): string | undefined {
  const frames = [
    ...(new Error().stack ?? "").matchAll(/(\/[^\s()]+\/tests\/[^/]+\.test\.ts):(\d+)/g),
  ];
  const last = frames.at(-1);
  if (last === undefined) return undefined;
  const [, file, line] = last as unknown as [string, string, string];
  const lines = readFileSync(file, "utf8").split("\n");
  for (let i = Number(line) - 1; i >= 0; i--) {
    const m = /^\s*test\(\s*(?:["'`](.*)["'`],)?\s*$|^\s*test\(\s*["'`](.*?)["'`],/.exec(
      lines[i] ?? "",
    );
    if (m === null) continue;
    const title = m[2] ?? m[1] ?? lines[i + 1]?.trim().replace(/^["'`]|["'`],$/g, "");
    return `${basename(file)}: ${title}`;
  }
  return undefined;
}

// Scratch dirs read as the Mac paths they stand for.
function readablePaths(text: string): string {
  const names: Record<string, string> = {
    prefix: "/opt/homebrew",
    home: "~",
    repo: "~/Projects/web",
    empty: "~/Projects/empty",
    system: "",
  };
  return text
    .replace(
      /(?:\/private)?\/(?:var\/folders\/[^/\s]+\/[^/\s]+\/T|tmp)\/devsite-([a-z]+)(?:-default)?-[A-Za-z0-9]+/g,
      (_, kind: string) => names[kind] ?? `<${kind}>`,
    )
    .replace(/(?:\/private)?\/var\/folders\/[^/\s]+\/[^/\s]+\/T\//g, "$TMPDIR/");
}

// A throwaway repo whose apps/web/package.json declares a devSite name.
export function makeRepo(name = "web", project = "web") {
  const repo = mkdtempSync(join(tmpdir(), "devsite-repo-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: project, devSite: { name } }),
  );
  return repo;
}

// A throwaway directory with no devSite route anywhere.
export function makeEmptyRepo() {
  return mkdtempSync(join(tmpdir(), "devsite-empty-"));
}

// A fresh scratch home for a test that reads what devsite wrote there.
export function makeHome() {
  return mkdtempSync(join(tmpdir(), "devsite-home-"));
}

// A settings file in a home, as ~/Library/Application Support/devsite/config.json.
export function writeSettings(home: string, settings: object) {
  const dir = join(home, "Library", "Application Support", "devsite");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(settings));
}

// A Caddyfile path at etc/Caddyfile of a fresh scratch Homebrew prefix. Starts nonexistent; suites that only dry-run share one, the round-trip suite writes and patches it.
export function scratchCaddyfile() {
  const etc = join(mkdtempSync(join(tmpdir(), "devsite-prefix-")), "etc");
  mkdirSync(etc);
  return join(etc, "Caddyfile");
}

// A throwaway Vite root; pkg (when given) becomes its package.json.
export function makeViteRoot(pkg?: object) {
  const root = mkdtempSync(join(tmpdir(), "devsite-vite-"));
  if (pkg !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}

export function viteConfigHook(plugin: Plugin) {
  const hook = plugin.config;
  if (typeof hook !== "function") throw new Error("config hook is not callable");
  // The hook never reads `this`; bind once so call sites stay plain (its declared thisArg is Vite's ConfigPluginContext, which no test builds).
  return hook.bind(plugin as never);
}

export function viteConfigureServerHook(plugin: Plugin) {
  const hook = plugin.configureServer;
  if (typeof hook !== "function") throw new Error("configureServer hook is not callable");
  return hook.bind(plugin as never);
}

// A fake Vite dev server: an EventEmitter posing as httpServer with a fixed bound port, plus the captured logger output.
export function fakeViteServer(port: number) {
  const httpServer = new EventEmitter() as EventEmitter & { address: () => { port: number } };
  httpServer.address = () => ({ port });
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    httpServer,
    infos,
    warns,
    server: {
      httpServer,
      config: {
        logger: { info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m) },
      },
    },
  };
}
