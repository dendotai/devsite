// Regression tests for the subcommand guard: nothing but `init` may reach the
// privileged bootstrap. Spawn-based because init.ts runs on import; in-process
// coverage arrives with the run() split (#9).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INIT = join(import.meta.dir, "..", "src", "init.ts");

function devsite(args: string[], cwd?: string) {
  const r = spawnSync("bun", [INIT, ...args], { cwd, encoding: "utf8" });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("bare run prints usage and exits 1", () => {
  const r = devsite([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite init");
});

test("--help does not reach the bootstrap", () => {
  const r = devsite(["--help"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite init");
});

test("unknown subcommand prints usage and exits 1", () => {
  const r = devsite(["uninstall"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite init");
});

test("init passes the guard: no routes in cwd exits 1 with the discovery error", () => {
  const empty = mkdtempSync(join(tmpdir(), "devsite-empty-"));
  const r = devsite(["init"], empty);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No package.json#devSite routes");
});

test("init --dry-run renders the Caddyfile and touches nothing", () => {
  const repo = mkdtempSync(join(tmpdir(), "devsite-repo-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: "web", devSite: { host: "web.test.internal" } }),
  );
  const r = devsite(["init", "--dry-run"], repo);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--dry-run: would write");
  expect(r.stdout).toContain("web.test.internal {");
});
