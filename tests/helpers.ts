// Shared fixtures for the CLI and Vite-plugin test suites.
// The setup import is a belt-and-braces double of the bunfig.toml preload: the DEVSITE_STATE_DIR guard holds even when bun test runs from a cwd where bunfig.toml is not picked up.
import "./setup";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

// A stdin pre-loaded with `input`, posing as a TTY (or not) — what the interactive confirm flow reads.
export function fakeStdin(input: string, isTTY: boolean) {
  const s = Readable.from([input]) as Readable & { isTTY?: boolean };
  s.isTTY = isTTY;
  return s;
}

export type IoOpts = {
  cwd?: string;
  // A Caddyfile at <prefix>/etc/Caddyfile: the run sees <prefix> as the Homebrew prefix.
  caddyfile?: string;
  // The dir that holds devsite/config.json.
  configHome?: string;
  stdin?: CliContext["stdin"];
  runCommand?: CliContext["runCommand"];
  env?: CliContext["env"];
};

// A CliContext over in-memory io. The env holds only the scratch prefix, the settings dir, and the state dir tests/setup.ts points at, so an ambient DEVSITE_UID can never leak in.
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
      XDG_CONFIG_HOME: opts.configHome ?? mkdtempSync(join(tmpdir(), "devsite-config-")),
      DEVSITE_STATE_DIR: process.env.DEVSITE_STATE_DIR,
      ...opts.env,
    },
    runCommand: opts.runCommand ?? quietRunner().runCommand,
  };
  return { ctx, stdout, stderr };
}

export type CommandCall = { cmd: string; args: string[]; capture: boolean };

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
  const runCommand: CliContext["runCommand"] = (cmd, args, { capture }) => {
    const call = { cmd, args, capture };
    calls.push(call);
    return { status: 0, stdout: "", ...answer(call) };
  };
  return { runCommand, calls };
}

// One in-process CLI invocation: argv in, exit code + captured output out.
export async function cli(argv: string[], opts: IoOpts = {}) {
  const { ctx, stdout, stderr } = makeIo(opts);
  const status = await run(argv, ctx);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

// A throwaway repo whose apps/web/package.json declares a devSite host. The project name matters to rename cleanup: same project + new host = rename; a different project name = an unrelated repo.
export function makeRepo(host = "web.test.internal", project = "web") {
  const repo = mkdtempSync(join(tmpdir(), "devsite-repo-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: project, devSite: { name: host.replace(/\.internal$/, "") } }),
  );
  return repo;
}

// A throwaway directory with no devSite route anywhere.
export function makeEmptyRepo() {
  return mkdtempSync(join(tmpdir(), "devsite-empty-"));
}

// A fresh scratch dir for suites that point DEVSITE_STATE_DIR per test.
export function makeStateDir() {
  return mkdtempSync(join(tmpdir(), "devsite-state-"));
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
