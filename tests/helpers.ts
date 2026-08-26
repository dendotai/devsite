// Shared fixtures for the CLI test suites.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
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

// A throwaway repo whose apps/web/package.json declares a devSite host.
export function makeRepo(host = "web.test.internal") {
  const repo = mkdtempSync(join(tmpdir(), "devsite-repo-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: "web", devSite: { host } }),
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
