// End-to-end tests of the CLI surface. Runs that stop before init reads this Mac's Caddy spawn the bin shim (src/cli.ts): the real process boundary — exit codes, stdout/stderr routing. Dry runs go in-process through dryRun(), because a spawned run would read this Mac's running Caddy through ps. In-process coverage of parse/dispatch lives in run.test.ts (#9).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run";
import { makeEmptyRepo, makeIo, makeRepo, scratchCaddyfile } from "./helpers";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// One scratch Homebrew prefix for the whole suite — nothing ever writes it.
const SCRATCH = scratchCaddyfile();

function devsite(args: string[], opts: { cwd?: string } = {}) {
  // An ambient DEVSITE_UID must never leak into a run.
  const env: Record<string, string | undefined> = {
    ...process.env,
    DEVSITE_BREW_PREFIX: join(SCRATCH, "..", ".."),
  };
  delete env.DEVSITE_UID;
  const r = spawnSync("bun", [CLI, ...args], { cwd: opts.cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function dryRun(opts: { cwd: string; caddyfile?: string; uid?: string }) {
  const { ctx, stdout, stderr } = makeIo({ cwd: opts.cwd, caddyfile: opts.caddyfile });
  if (opts.uid !== undefined) ctx.env.DEVSITE_UID = opts.uid;
  const status = await run(["init", "--dry-run"], ctx);
  return { status, stdout: stdout.text(), stderr: stderr.text() };
}

function makeCaddyfile(content: string) {
  const p = scratchCaddyfile();
  writeFileSync(p, content);
  return p;
}

// --- dispatch: nothing but `init` may reach the bootstrap ---

test("bare run prints usage and exits 1", async () => {
  const r = devsite([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

test("--help prints help to stdout and exits 0", async () => {
  const r = devsite(["--help"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage: devsite");
  expect(r.stdout).toContain("init");
});

test("--version prints the version and exits 0", async () => {
  const r = devsite(["--version"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("unknown subcommand prints usage and exits 1", async () => {
  const r = devsite(["uninstall"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

test("unknown flag prints usage and exits 1 — a typo'd --dry-run must not apply", async () => {
  const r = devsite(["init", "--dyr-run"], { cwd: makeRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("--dyr-run");
  expect(r.stderr).toContain("Usage: devsite");
});

test("init passes the guard: no routes in cwd exits 1 with the discovery error", async () => {
  const r = devsite(["init"], { cwd: makeEmptyRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No package.json#devSite routes");
  // The message must name the searched folder — the wrong-cwd case must explain itself.
  expect(r.stderr).toContain("devsite-empty-");
});

test("init --dry-run renders the devsite.d tree and touches nothing", async () => {
  const r = await dryRun({ cwd: makeRepo() });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--dry-run: would change");
  expect(r.stdout).toContain("import devsite.d/*.caddy # devsite");
  expect(r.stdout).toContain("+++ devsite.d/web.test.internal.caddy");
  expect(r.stdout).toContain("web.test.internal, web.test.localhost {");
});

test("a single-package repo: root package.json#devSite is discovered", async () => {
  const repo = mkdtempSync(join(tmpdir(), "devsite-single-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "solo", devSite: { name: "solo.test" } }),
  );
  const r = await dryRun({ cwd: repo });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("solo.test.internal, solo.test.localhost {");
});

test("root and workspace devSite hosts are both discovered", async () => {
  const repo = makeRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "rootproj", devSite: { name: "root.test" } }),
  );
  const r = await dryRun({ cwd: repo });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("root.test.internal, root.test.localhost {");
  expect(r.stdout).toContain("web.test.internal, web.test.localhost {");
});

test("a host that is not a plain hostname is rejected at discovery", async () => {
  const r = await dryRun({ cwd: makeRepo("a.internal; touch pwned") });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("is not a plain hostname");
  expect(r.stderr).toContain("a.internal; touch pwned");
});

test("two packages declaring the same devSite name are rejected at discovery", async () => {
  const repo = makeRepo(); // apps/web → devSite.name "web.test"
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { name: "web.test" } }),
  );
  const r = await dryRun({ cwd: repo });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('devSite.name "web.test"');
  // The message must name both claimants so the fix is findable.
  expect(r.stderr).toContain("api");
  expect(r.stderr).toContain("web");
});

test("names differing only in case are still duplicates (DNS is case-insensitive)", async () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { name: "WEB.test" } }),
  );
  const r = await dryRun({ cwd: repo });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('devSite.name "web.test"');
});

// --- running as root: refuse, because `brew services` would install a root service (ADR 0002) ---
// DEVSITE_UID pretends the uid so these run without actually being root.

test("init as root refuses", async () => {
  const r = await dryRun({ cwd: makeRepo(), uid: "0" });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("devsite init is running as root");
  expect(r.stderr).toContain("without sudo");
});

test("an empty DEVSITE_UID export is not uid 0: the run stays a normal-user run", async () => {
  const r = await dryRun({ cwd: makeRepo(), uid: "" });
  expect(r.status).toBe(0);
});

// --- Caddyfile ownership: content devsite does not own is sacred ---

test("pre-existing non-devsite content is never deleted (Homebrew default shape)", async () => {
  const caddyfile = makeCaddyfile('# Welcome to Caddy!\n\n:80 {\n\trespond "hi"\n}\n');
  const r = await dryRun({ cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  // A unified diff always shows deletions as `-` lines; their absence proves survival.
  expect(r.stdout).not.toContain("-:80");
  expect(r.stdout).not.toContain('-\trespond "hi"');
  expect(r.stdout).toContain("+import devsite.d/*.caddy # devsite");
});

test("init names the default_bind line it deletes", async () => {
  const caddyfile = makeCaddyfile("{\n\tdefault_bind 127.0.0.1 100.64.0.9\n}\n");
  const r = await dryRun({ cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(
    'deletes "default_bind 127.0.0.1 100.64.0.9" from the Caddyfile: Caddy cannot run as you with it, and the guard keeps the LAN out',
  );
  expect(r.stdout).toContain("-\tdefault_bind 127.0.0.1 100.64.0.9");
});

// Idempotence against init's own output is pinned by the round-trip suite
// (roundtrip.test.ts), which applies the printed diff with patch(1) and
// asserts a second dry-run reports "already up to date".

test("a user's global options block with no storage gets devsite's pin, and never local_certs", async () => {
  const caddyfile = makeCaddyfile('{\n\temail den@example.com\n}\n\n:8080 {\n\trespond "ok"\n}\n');
  const r = await dryRun({ cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  expect(r.stderr).toBe("");
  // The pin lands inside the user's block; the block itself survives.
  expect(r.stdout).toContain("+\tstorage file_system {");
  expect(r.stdout).not.toContain("local_certs");
  expect(r.stdout).not.toContain("-\temail den@example.com");
  expect(r.stdout).not.toContain("-:8080");
});
