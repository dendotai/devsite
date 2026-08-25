// In-process tests of the CLI surface: run(argv) → exit code (#9).
// Spawn-based end-to-end coverage of the bin shim stays in cli.test.ts.
import { expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { init } from "../src/commands/init";
import { run } from "../src/run";
import { makeEmptyRepo, makeRepo, scratchCaddyfile } from "./helpers";

// One scratch Caddyfile path for the whole suite — nothing ever writes it.
const SCRATCH = scratchCaddyfile();

// Capture console output around an in-process CLI call; console, cwd, and env
// are restored even when the assertion throws. The identity variables are
// stripped so an ambient DEVSITE_UID/SUDO_USER (the documented knobs for
// exercising the root paths) never leaks into a run — mirrors cli.test.ts.
async function invoke(fn: () => Promise<number>, opts: { cwd?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const warnSpy = spyOn(console, "warn").mockImplementation((...a) => void err.push(a.join(" ")));
  const errSpy = spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  const prevCwd = process.cwd();
  const prevEnv = {
    DEVSITE_CADDYFILE: process.env.DEVSITE_CADDYFILE,
    DEVSITE_UID: process.env.DEVSITE_UID,
    SUDO_USER: process.env.SUDO_USER,
  };
  try {
    if (opts.cwd) process.chdir(opts.cwd);
    process.env.DEVSITE_CADDYFILE = SCRATCH;
    delete process.env.DEVSITE_UID;
    delete process.env.SUDO_USER;
    const status = await fn();
    return { status, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    process.chdir(prevCwd);
    for (const [name, value] of Object.entries(prevEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  }
}

const cli = (argv: string[], opts: { cwd?: string } = {}) => invoke(() => run(argv), opts);

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

test("init --dry-run through the explicit seam: renders the region, returns 0", async () => {
  const r = await invoke(() =>
    init({ dryRun: true, cwd: makeRepo(), caddyfilePath: scratchCaddyfile() }),
  );
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--dry-run: would write");
  expect(r.stdout).toContain("web.test.internal {");
});

test("--dry-run without a command is not an init: usage, exit 1", async () => {
  const r = await cli(["--dry-run"], { cwd: makeRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});
