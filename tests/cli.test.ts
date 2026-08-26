// Spawn-based end-to-end tests of the bin shim (src/cli.ts): the real process
// boundary — exit codes, stdout/stderr routing. In-process coverage of
// parse/dispatch lives in run.test.ts (#9).
// DEVSITE_CADDYFILE points every run at a scratch file so no test ever reads
// or races the machine-global Caddyfile.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { makeEmptyRepo, makeRepo, scratchCaddyfile } from "./helpers";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

// One scratch Caddyfile path for the whole suite — nothing ever writes it.
const SCRATCH = scratchCaddyfile();

function devsite(
  args: string[],
  opts: { cwd?: string; caddyfile?: string; env?: Record<string, string> } = {},
) {
  // Strip the identity variables from the inherited env so a test controls them
  // fully via opts.env — an ambient SUDO_USER must never leak into a run.
  const env: Record<string, string | undefined> = {
    ...process.env,
    DEVSITE_CADDYFILE: opts.caddyfile ?? SCRATCH,
  };
  delete env.DEVSITE_UID;
  delete env.SUDO_USER;
  Object.assign(env, opts.env);
  const r = spawnSync("bun", [CLI, ...args], { cwd: opts.cwd, encoding: "utf8", env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeCaddyfile(content: string) {
  const p = join(mkdtempSync(join(tmpdir(), "devsite-caddy-")), "Caddyfile");
  writeFileSync(p, content);
  return p;
}

// --- dispatch: nothing but `init` may reach the privileged bootstrap ---

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

test("init --dry-run renders the managed region and touches nothing", () => {
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo() });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("--dry-run: would write");
  expect(r.stdout).toContain("web.test.internal {");
  expect(r.stdout).toContain(">>> devsite v1");
});

test("a single-package repo: root package.json#devSite is discovered", () => {
  const repo = mkdtempSync(join(tmpdir(), "devsite-single-"));
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "solo", devSite: { host: "solo.test.internal" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("solo.test.internal {");
});

test("root and workspace devSite hosts are both discovered", () => {
  const repo = makeRepo();
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({ name: "rootproj", devSite: { host: "root.test.internal" } }),
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

test("two packages declaring the same devSite host are rejected at discovery", () => {
  const repo = makeRepo(); // apps/web → web.test.internal
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { host: "web.test.internal" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("web.test.internal");
  // The message must name both claimants so the fix is findable.
  expect(r.stderr).toContain("api");
  expect(r.stderr).toContain("web");
});

test("hosts differing only in case are still duplicates (DNS is case-insensitive)", () => {
  const repo = makeRepo();
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { host: "WEB.test.internal" } }),
  );
  const r = devsite(["init", "--dry-run"], { cwd: repo });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("web.test.internal");
});

// --- running as root: resolve the real user behind sudo, or refuse (#12) ---
// DEVSITE_UID pretends the uid so these run without actually being root.

test("root with no SUDO_USER refuses: a true root shell cannot pin a wrong CA path", () => {
  const r = devsite(["init"], { cwd: makeRepo(), env: { DEVSITE_UID: "0" } });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("without sudo");
});

// darwin-only: the happy path resolves SUDO_USER's home through dscl (macOS
// Directory Services), which Linux CI runners don't have — there the run
// correctly refuses, which is the adjacent tests' territory.
test.skipIf(process.platform !== "darwin")(
  "under sudo the pinned storage is the real user's home, not root's",
  () => {
    const r = devsite(["init", "--dry-run"], {
      cwd: makeRepo(),
      env: { DEVSITE_UID: "0", SUDO_USER: userInfo().username },
    });
    expect(r.status).toBe(0);
    // The rendered region pins the storage; it must show the human's home.
    expect(r.stdout).toContain(
      `root "${join(homedir(), "Library", "Application Support", "Caddy")}"`,
    );
    // The substitution announces itself.
    expect(r.stdout).toContain(userInfo().username);
    expect(r.stdout.toLowerCase()).toContain("sudo");
  },
);

test("root with an unresolvable SUDO_USER refuses instead of guessing", () => {
  const r = devsite(["init"], {
    cwd: makeRepo(),
    env: { DEVSITE_UID: "0", SUDO_USER: "devsite-no-such-user" },
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("without sudo");
});

test("root sudo'ing (SUDO_USER=root) is still a root shell: refuse", () => {
  const r = devsite(["init"], {
    cwd: makeRepo(),
    env: { DEVSITE_UID: "0", SUDO_USER: "root" },
  });
  expect(r.status).toBe(1);
  expect(r.stderr).toContain("without sudo");
});

test("an empty DEVSITE_UID export is not uid 0: the run stays a normal-user run", () => {
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), env: { DEVSITE_UID: "" } });
  expect(r.status).toBe(0);
  expect(r.stdout).not.toContain("Running under sudo");
});

test("a non-root run ignores a stray SUDO_USER (nested shells keep it exported)", () => {
  const r = devsite(["init", "--dry-run"], {
    cwd: makeRepo(),
    env: { SUDO_USER: "devsite-no-such-user" },
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain(
    `root "${join(homedir(), "Library", "Application Support", "Caddy")}"`,
  );
  expect(r.stdout).not.toContain("Running under sudo");
});

// --- Caddyfile ownership: content outside the managed region is sacred ---

test("pre-existing non-devsite content is never deleted (Homebrew default shape)", () => {
  const caddyfile = makeCaddyfile('# Welcome to Caddy!\n\n:80 {\n\trespond "hi"\n}\n');
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  // A unified diff always shows deletions as `-` lines; their absence proves survival.
  expect(r.stdout).not.toContain("-:80");
  expect(r.stdout).not.toContain('-\trespond "hi"');
  expect(r.stdout).toContain(">>> devsite v1");
});

test("pre-region (v0) devsite files migrate: other repos' blocks are kept", () => {
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
  expect(r.stdout).toContain("1 block(s) from other repos kept");
  // The old file's global block is devsite's own — nothing foreign to keep.
  expect(r.stdout).not.toContain(">>> kept");
});

test("re-running against devsite's own output is a no-op", () => {
  const repo = makeRepo();
  const first = devsite(["init", "--dry-run"], { cwd: repo });
  expect(first.status).toBe(0);
  // Reconstruct the rendered file from the diff's added lines (fresh file → all `+`).
  const content = first.stdout
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .map((l) => l.slice(1))
    .join("\n");
  const caddyfile = makeCaddyfile(`${content}\n`);
  const again = devsite(["init", "--dry-run"], { cwd: repo, caddyfile });
  expect(again.status).toBe(0);
  expect(again.stdout).toContain("already up to date");
});

test("a foreign global options block is merged into the region with a warning", () => {
  const caddyfile = makeCaddyfile('{\n\temail den@example.com\n}\n\n:8080 {\n\trespond "ok"\n}\n');
  const r = devsite(["init", "--dry-run"], { cwd: makeRepo(), caddyfile });
  expect(r.status).toBe(0);
  expect(r.stderr).toContain("global options block");
  expect(r.stdout).toContain(">>> kept");
  expect(r.stdout).not.toContain("-:8080");
});
