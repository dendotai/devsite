// In-process tests of the CLI surface: run(argv) → exit code (#9).
// Spawn-based end-to-end coverage of the bin shim stays in cli.test.ts.
import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run";

// Capture console output around a run() call; console and cwd/env are restored
// even when the assertion throws.
async function cli(argv: string[], opts: { cwd?: string; caddyfile?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  const warnSpy = spyOn(console, "warn").mockImplementation((...a) => void err.push(a.join(" ")));
  const errSpy = spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
  const prevCwd = process.cwd();
  const prevCaddyfile = process.env.DEVSITE_CADDYFILE;
  try {
    if (opts.cwd) process.chdir(opts.cwd);
    process.env.DEVSITE_CADDYFILE =
      opts.caddyfile ?? join(mkdtempSync(join(tmpdir(), "devsite-none-")), "Caddyfile");
    const status = await run(argv);
    return { status, stdout: out.join("\n"), stderr: err.join("\n") };
  } finally {
    process.chdir(prevCwd);
    if (prevCaddyfile === undefined) delete process.env.DEVSITE_CADDYFILE;
    else process.env.DEVSITE_CADDYFILE = prevCaddyfile;
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errSpy.mockRestore();
  }
}

function makeRepo(host = "web.test.internal") {
  const repo = mkdtempSync(join(tmpdir(), "devsite-repo-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: "web", devSite: { host } }),
  );
  return repo;
}

test("--help prints help to stdout and exits 0", async () => {
  const r = await cli(["--help"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage: devsite");
  expect(r.stdout).toContain("init");
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

test("an extra positional after init exits 1 with usage", async () => {
  const r = await cli(["init", "extra"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

test("init is dispatched: no routes in cwd returns 1 with the discovery error", async () => {
  const empty = mkdtempSync(join(tmpdir(), "devsite-empty-"));
  const r = await cli(["init"], { cwd: empty });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No package.json#devSite routes");
});

test("init --dry-run runs in-process: renders the region, returns 0", async () => {
  const r = await cli(["init", "--dry-run"], { cwd: makeRepo() });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--dry-run: would write");
  expect(r.stdout).toContain("web.test.internal {");
});

test("--dry-run without a command is not an init: usage, exit 1", async () => {
  const r = await cli(["--dry-run"], { cwd: makeRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});
