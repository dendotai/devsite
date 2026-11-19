// Spawn-based end-to-end tests of the bin shim (src/cli.ts): the real process boundary — exit codes, stdout/stderr routing. In-process coverage of parse/dispatch lives in run.test.ts (#9).
// DEVSITE_CADDYFILE points every run at a scratch file so no test ever reads or races the machine-global Caddyfile.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEmptyRepo, makeRepo, scratchCaddyfile } from "./helpers";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// One scratch Caddyfile path for the whole suite — nothing ever writes it.
const SCRATCH = scratchCaddyfile();

function devsite(
  args: string[],
  opts: { cwd?: string; caddyfile?: string; env?: Record<string, string> } = {},
) {
  // An ambient DEVSITE_UID must never leak into a run; a test sets it via opts.env.
  const env: Record<string, string | undefined> = {
    ...process.env,
    DEVSITE_CADDYFILE: opts.caddyfile ?? SCRATCH,
  };
  delete env.DEVSITE_UID;
  Object.assign(env, opts.env);
  const r = spawnSync("bun", [CLI, ...args], { cwd: opts.cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeCaddyfile(content: string) {
  const p = join(mkdtempSync(join(tmpdir(), "devsite-caddy-")), "Caddyfile");
  writeFileSync(p, content);
  return p;
}

// --- dispatch: nothing but `init` may reach the bootstrap ---

test("bare run prints usage and exits 1", () => {
  const r = devsite([]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

test("--help prints help to stdout and exits 0", () => {
  const r = devsite(["--help"]);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Usage: devsite");
  expect(r.stdout).toContain("init");
});

test("--version prints the version and exits 0", () => {
  const r = devsite(["--version"]);
  expect(r.status).toBe(0);
  expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
});

test("unknown subcommand prints usage and exits 1", () => {
  const r = devsite(["uninstall"]);
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Usage: devsite");
});

test("unknown flag prints usage and exits 1 — a typo'd --dry-run must not apply", () => {
  const r = devsite(["init", "--dyr-run"], { cwd: makeRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("--dyr-run");
  expect(r.stderr).toContain("Usage: devsite");
});

test("init passes the guard: no routes in cwd exits 1 with the discovery error", () => {
  const r = devsite(["init"], { cwd: makeEmptyRepo() });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("No package.json#devSite routes");
  // The message must name the searched folder — the wrong-cwd case must explain itself.
  expect(r.stderr).toContain("devsite-empty-");
});

test("init --dry-run renders the devsite.d tree and touches nothing", () => {
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo() });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--dry-run: would change");
  expect(r.stdout).toContain("import devsite.d/*.caddy # devsite");
  expect(r.stdout).toContain("+++ devsite.d/web.test.internal.caddy");
  expect(r.stdout).toContain("web.test.internal {");
});

test("a single-package repo: root package.json#devSite is discovered", () => {
  const repo = mkdtempSync(join(tmpdir(), "devsite-single-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "solo", devSite: { name: "solo.test" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("solo.test.internal {");
});

test("root and workspace devSite hosts are both discovered", () => {
  const repo = makeRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "rootproj", devSite: { name: "root.test" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("root.test.internal {");
  expect(r.stdout).toContain("web.test.internal {");
});

test("a host that is not a plain hostname is rejected at discovery", () => {
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo("a.internal; touch pwned") });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("is not a plain hostname");
  expect(r.stderr).toContain("a.internal; touch pwned");
});

test("two packages declaring the same devSite name are rejected at discovery", () => {
  const repo = makeRepo(); // apps/web → devSite.name "web.test"
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { name: "web.test" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('devSite.name "web.test"');
  // The message must name both claimants so the fix is findable.
  expect(r.stderr).toContain("api");
  expect(r.stderr).toContain("web");
});

test("names differing only in case are still duplicates (DNS is case-insensitive)", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { name: "WEB.test" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain('devSite.name "web.test"');
});

test("the old devSite.host field is refused with the field that replaced it", () => {
  const repo = makeRepo();
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: "web", devSite: { host: "web.test.internal" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("devSite.host");
  expect(r.stderr).toContain("devSite.name");
});

// --- running as root: refuse, because Caddy runs as the user (ADR 0002) ---
// DEVSITE_UID pretends the uid so these run without actually being root.

test("init as root refuses: Caddy must run as the user", () => {
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), env: { DEVSITE_UID: "0" } });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("Caddy must run as you");
  expect(r.stderr).toContain("without sudo");
});

test("an empty DEVSITE_UID export is not uid 0: the run stays a normal-user run", () => {
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), env: { DEVSITE_UID: "" } });
  expect(r.status).toBe(0);
});

// --- Caddyfile ownership: content outside the managed region is sacred ---

test("pre-existing non-devsite content is never deleted (Homebrew default shape)", () => {
  const caddyfile = makeCaddyfile('# Welcome to Caddy!\n\n:80 {\n\trespond "hi"\n}\n');
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  // A unified diff always shows deletions as `-` lines; their absence proves survival.
  expect(r.stdout).not.toContain("-:80");
  expect(r.stdout).not.toContain('-\trespond "hi"');
  expect(r.stdout).toContain("+import devsite.d/*.caddy # devsite");
});

test("init names the default_bind line it deletes", () => {
  const caddyfile = makeCaddyfile("{\n\tdefault_bind 127.0.0.1 100.64.0.9\n}\n");
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(
    'deletes "default_bind 127.0.0.1 100.64.0.9" from the Caddyfile: Caddy as you cannot start with it, and the guard keeps the LAN out',
  );
  expect(r.stdout).toContain("-\tdefault_bind 127.0.0.1 100.64.0.9");
});

test("pre-region (v0) devsite files migrate: other repos' blocks move into devsite.d", () => {
  const caddyfile = makeCaddyfile(
    [
      "# Generated by `devsite init` — do not edit by hand.",
      "# Change a project's package.json#devSite and re-run `devsite init`.",
      "",
      "{",
      "\tstorage file_system {",
      '\t\troot "/somewhere"',
      "\t}",
      "\tlocal_certs",
      "}",
      "",
      "# otherproj",
      "other.internal {",
      '\trespond "devsite: dev server for other.internal is not running (start it with bun dev)" 503',
      "}",
      "",
    ].join("\n"),
  );
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("migrating 1 host file(s) from other repos into devsite.d/");
  expect(r.stdout).toContain("+++ devsite.d/other.internal.caddy");
  // The old file's global block is devsite's own — no user directives, so no warning.
  expect(r.stderr).not.toContain("global options block");
});

// Idempotence against init's own output is pinned by the round-trip suite
// (roundtrip.test.ts), which applies the printed diff with patch(1) and
// asserts a second dry-run reports "already up to date".

test("a user's global options block gets devsite's directives added, with a warning", () => {
  const caddyfile = makeCaddyfile('{\n\temail den@example.com\n}\n\n:8080 {\n\trespond "ok"\n}\n');
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("global options block");
  // The directives land inside the user's block; the block itself survives.
  expect(r.stdout).toContain("+\tlocal_certs");
  expect(r.stdout).not.toContain("-\temail den@example.com");
  expect(r.stdout).not.toContain("-:8080");
  // The user owns the global block — devsite must not also create its own.
  expect(r.stdout).not.toContain("00-global.caddy");
});
