// In-process tests of the CLI surface: run(argv, ctx) → exit code (#9).
// The io context (#26) makes these pure: output lands in in-memory sinks, cwd
// and env are plain values, stdin is a pre-loaded stream — no console spies,
// no chdir, no env mutation. Spawn-based end-to-end coverage of the bin shim
// stays in cli.test.ts.
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { init } from "../src/commands/init";
import type { CliContext } from "../src/context";
import { run } from "../src/run";
import { fakeStdin, makeEmptyRepo, makeRepo, scratchCaddyfile, sink } from "./helpers";

// One scratch Caddyfile path for the whole suite — nothing ever writes it.
const SCRATCH = scratchCaddyfile();
// Default cwd for invocations that never look at it.
const NOWHERE = makeEmptyRepo();

type IoOpts = {
  cwd?: string;
  caddyfile?: string;
  stdin?: CliContext["stdin"];
};

function makeIo(opts: IoOpts = {}) {
  const stdout = sink();
  const stderr = sink();
  const ctx: CliContext = {
    stdout,
    stderr,
    stdin: opts.stdin ?? fakeStdin("", false),
    cwd: opts.cwd ?? NOWHERE,
    env: { DEVSITE_CADDYFILE: opts.caddyfile ?? SCRATCH },
  };
  return { ctx, stdout, stderr };
}

async function cli(argv: string[], opts: IoOpts = {}) {
  const { ctx, stdout, stderr } = makeIo(opts);
  const status = await run(argv, ctx);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

test("--help prints help to stdout and exits 0", async () => {
  const r = await cli(["--help"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage: devsite");
  expect(r.stdout).toContain("init");
  expect(r.stderr).toBe("");
});

test("-h is --help", async () => {
  const r = await cli(["-h"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage: devsite");
});

test("help as a word is a command too (the git/cargo convention)", async () => {
  const r = await cli(["help"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage: devsite");
  expect(r.stderr).toBe("");
});

test("--version prints package.json's version and exits 0", async () => {
  const pkg = (await Bun.file(join(import.meta.dir, "..", "package.json")).json()) as {
    version: string;
  };
  const r = await cli(["--version"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toBe(pkg.version);
});

test("-v is --version", async () => {
  const r = await cli(["-v"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("version as a word is a command too", async () => {
  const r = await cli(["version"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("bare run prints usage to stderr and exits 1", async () => {
  const r = await cli([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

test("an unknown command exits 1 and names the command", async () => {
  const r = await cli(["frobnicate"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("frobnicate");
  expect(r.stderr).toContain("Usage: devsite");
});

test("an unknown flag exits 1 and names the flag — no silent real apply", async () => {
  const r = await cli(["init", "--dyr-run"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("--dyr-run");
  expect(r.stderr).toContain("Usage: devsite");
});

test("a command flag outside its command is rejected: --dry-run needs init", async () => {
  const r = await cli(["--version", "--dry-run"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("--dry-run");
  expect(r.stderr).toContain("Usage: devsite");
});

test("an extra positional after init exits 1 with usage", async () => {
  const r = await cli(["init", "extra"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

test("init is dispatched: no routes in cwd returns 1 with the discovery error", async () => {
  const r = await cli(["init"], { cwd: makeEmptyRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No package.json#devSite routes");
});

test("init --dry-run through the io context: renders the region, returns 0", async () => {
  const { ctx, stdout } = makeIo({ cwd: makeRepo(), caddyfile: scratchCaddyfile() });
  const status = await init({ dryRun: true }, ctx);
  expect(status).toBe(0);
  expect(stdout.text()).toContain("--dry-run: would write");
  expect(stdout.text()).toContain("web.test.internal {");
});

test("--dry-run without a command is not an init: usage, exit 1", async () => {
  const r = await cli(["--dry-run"], { cwd: makeRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

// --- the confirm flow (#26): refusal paths must never reach a write ---

test("a non-TTY run with a pending diff refuses and writes nothing", async () => {
  const caddyfile = scratchCaddyfile();
  const r = await cli(["init"], {
    cwd: makeRepo(),
    caddyfile,
    stdin: fakeStdin("", false),
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("stdin is not a TTY");
  expect(existsSync(caddyfile)).toBe(false);
});

test('a declined confirm ("n") aborts with exit 1 and writes nothing', async () => {
  const caddyfile = scratchCaddyfile();
  const r = await cli(["init"], {
    cwd: makeRepo(),
    caddyfile,
    stdin: fakeStdin("n\n", true),
  });
  expect(r.status).toBe(1);
  expect(r.stdout).toContain("Apply this change?");
  expect(r.stderr).toContain("Aborted — nothing written");
  expect(existsSync(caddyfile)).toBe(false);
});
