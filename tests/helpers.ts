// Shared fixtures for the CLI and Vite-plugin test suites.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Plugin } from "vite";
import type { CliContext } from "../src/context";
import { run } from "../src/run";

// An in-memory Writer: records everything written, hands it back as one string.
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

// A stdin pre-loaded with `input`, posing as a TTY (or not) — what the
// interactive confirm flow reads.
export function fakeStdin(input: string, isTTY: boolean) {
  const s = Readable.from([input]) as Readable & { isTTY?: boolean };
  s.isTTY = isTTY;
  return s;
}

export type IoOpts = {
  cwd?: string;
  caddyfile?: string;
  stdin?: CliContext["stdin"];
};

// A CliContext over in-memory io. The env holds only DEVSITE_CADDYFILE, so
// the ambient identity variables (DEVSITE_UID, SUDO_USER) can never leak in.
export function makeIo(opts: IoOpts = {}) {
  const stdout = sink();
  const stderr = sink();
  const ctx: CliContext = {
    stdout,
    stderr,
    stdin: opts.stdin ?? fakeStdin("", false),
    cwd: opts.cwd ?? makeEmptyRepo(),
    env: { DEVSITE_CADDYFILE: opts.caddyfile ?? scratchCaddyfile() },
  };
  return { ctx, stdout, stderr };
}

// One in-process CLI invocation: argv in, exit code + captured output out.
export async function cli(argv: string[], opts: IoOpts = {}) {
  const { ctx, stdout, stderr } = makeIo(opts);
  const status = await run(argv, ctx);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

// A throwaway repo whose apps/web/package.json declares a devSite host. The
// project name matters to rename cleanup: same project + new host = rename;
// a different project name = an unrelated repo.
export function makeRepo(host = "web.test.internal", project = "web") {
  const repo = mkdtempSync(join(tmpdir(), "devsite-repo-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: project, devSite: { host } }),
  );
  return repo;
}

// A throwaway directory with no devSite route anywhere.
export function makeEmptyRepo() {
  return mkdtempSync(join(tmpdir(), "devsite-empty-"));
}

// A Caddyfile path in its own fresh scratch dir. Starts nonexistent; suites
// that only dry-run share one, the round-trip suite writes and patches it.
export function scratchCaddyfile() {
  return join(mkdtempSync(join(tmpdir(), "devsite-none-")), "Caddyfile");
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
  // The hook never reads `this`; bind once so call sites stay plain (its
  // declared thisArg is Vite's ConfigPluginContext, which no test builds).
  return hook.bind(plugin as never);
}

export function viteConfigureServerHook(plugin: Plugin) {
  const hook = plugin.configureServer;
  if (typeof hook !== "function") throw new Error("configureServer hook is not callable");
  return hook.bind(plugin as never);
}

// A fake Vite dev server: an EventEmitter posing as httpServer with a fixed
// bound port, plus the captured logger output.
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
