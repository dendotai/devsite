// Round-trip tests pinning `devsite init`'s ownership contract (#27, #47): everything devsite does not own survives a re-init byte-for-byte, and devsite's own state lives in devsite.d/ — the user's Caddyfile carries one import line and nothing else of devsite's.
//
// The suite observes init only through its public surface — an in-process run(["init", "--dry-run"]) and the multi-file unified diff it prints — applies that diff to a scratch tree with patch(1), and asserts the resulting tree's bytes. No init internals are imported, so the suite survives (and guards) an ownership rewrite. patch(1) is exact: the patched tree holds the same bytes a confirmed real run would write.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cli, makeRepo, scratchCaddyfile } from "./helpers";

// Run a dry-run and extract its unified diff; null = already up to date.
async function dryRunDiff(cwd: string, caddyfile: string): Promise<string | null> {
  const r = await cli(["init", "--dry-run"], { cwd, caddyfile });
  if (r.status !== 0) throw new Error(`dry-run failed:\n${r.stderr}`);
  if (r.stdout.includes("already up to date")) return null;
  const m = r.stdout.match(/\nThe diff[^\n]*\n\n([\s\S]*)$/);
  if (!m?.[1]) throw new Error(`no diff in dry-run output:\n${r.stdout}`);
  return m[1];
}

// One round trip: dry-run, apply the diff to the tree, report whether anything was pending — callers that spliced state assert `changed` so a false "already up to date" can never pass vacuously.
async function reInit(cwd: string, caddyfile: string) {
  const diff = await dryRunDiff(cwd, caddyfile);
  if (diff !== null) {
    const dir = dirname(caddyfile);
    // patch(1) applies bytes; creating devsite.d/ itself is the CLI's job at apply time,
    // so the harness pre-creates it.
    mkdirSync(join(dir, "devsite.d"), { recursive: true });
    const r = spawnSync("patch", ["-p0", "-s", "-E", "-d", dir], {
      input: diff,
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`patch failed: ${r.stderr}`);
    // Fidelity anchor: after applying, init must report nothing left to write — proving the patched tree is exactly what a confirmed real run would render, not merely what the printed diff said.
    if ((await dryRunDiff(cwd, caddyfile)) !== null) {
      throw new Error("patched tree does not converge to init's own rendering");
    }
  }
  return { changed: diff !== null };
}

// Every file in the tree, keyed by path relative to the Caddyfile's dir.
function readTree(caddyfile: string): Record<string, string> {
  const dir = dirname(caddyfile);
  const tree: Record<string, string> = {};
  if (existsSync(caddyfile)) tree.Caddyfile = readFileSync(caddyfile, "utf8");
  for (const name of globSync("devsite.d/*.caddy", { cwd: dir })) {
    tree[name] = readFileSync(join(dir, name), "utf8");
  }
  return tree;
}

// A Caddyfile whose target exists from the start — patch needs a file to patch, and an empty file renders identically to a missing one.
function makeCaddyfile(content = "") {
  const p = scratchCaddyfile();
  writeFileSync(p, content);
  return p;
}

const IMPORT_LINE = "import devsite.d/*.caddy # devsite";

// The global options block devsite creates in the Caddyfile when the user has none — hand-written to track planCaddyfile in src/commands/init.ts, for the same black-box reason.
function devsiteGlobalBlock(storageRoot: string) {
  return [
    "{",
    "\t# Pin PKI storage so Caddy's local CA is the SAME no matter how Caddy runs",
    "\t# it (the always-on service vs a foreground process). Every device trusts",
    `\t# this one CA root: ${join(storageRoot, "pki", "authorities", "local", "root.crt")}`,
    "\tstorage file_system {",
    `\t\troot "${storageRoot}"`,
    "\t}",
    "\t# devsite: Caddy asks the devsite node before it signs a certificate for a name.",
    "\ton_demand_tls {",
    "\t\task http://127.0.0.1:47380/tls-allowed",
    "\t}",
    "}",
  ].join("\n");
}

test("fresh init: the Caddyfile gets the global block and the import line; devsite's route lands in devsite.d", async () => {
  const repo = makeRepo();
  const caddyfile = makeCaddyfile();

  const first = await reInit(repo, caddyfile);
  expect(first.changed).toBe(true);
  const tree = readTree(caddyfile);
  // No user global block, so devsite creates one — in the Caddyfile, where global options normally live; the import line follows it.
  // Caddy is stopped, so the pin is the data dir `brew services` starts it with.
  const brewData = join(dirname(dirname(caddyfile)), "var", "lib", "caddy");
  expect(tree.Caddyfile).toBe(`${devsiteGlobalBlock(brewData)}\n\n${IMPORT_LINE}\n`);
  expect(tree["devsite.d/node.caddy"]).toContain(
    "*.internal, *.localhost {\n\ttls {\n\t\tissuer internal {\n\t\t\tlifetime 120h\n\t\t}\n\t\ton_demand\n\t}\n",
  );
  expect(tree["devsite.d/guard.caddy"]).toBe(
    [
      "# devsite: `import devsite-guard` in a site block keeps the LAN out of it",
      "(devsite-guard) {",
      "\t@devsite_outside not remote_ip 127.0.0.1 ::1 100.64.0.0/10",
      "\tabort @devsite_outside",
      "}",
      "",
    ].join("\n"),
  );
  // devsite's route carries its own `issuer internal`, so nothing gives the user's other sites internal certificates.
  expect(Object.values(tree).join("\n")).not.toContain("local_certs");

  const second = await reInit(repo, caddyfile);
  expect(second.changed).toBe(false);
  expect(readTree(caddyfile)).toEqual(tree);
});

test("a second run from another folder changes nothing: init sets up the Mac, not a repo", async () => {
  const caddyfile = makeCaddyfile();
  await reInit(makeRepo(), caddyfile);
  const before = readTree(caddyfile);
  const other = await reInit(makeRepo("other", "otherproj"), caddyfile);
  expect(other.changed).toBe(false);
  expect(readTree(caddyfile)).toEqual(before);
});

test("content outside devsite's ownership survives byte-for-byte", async () => {
  const outside = [
    "# Welcome to Caddy!",
    "",
    ":80 {",
    '\trespond "hi"',
    "}",
    "",
    ":8081 {",
    '    respond "spaces, not tabs"',
    "}",
  ].join("\n");
  const caddyfile = makeCaddyfile(`${outside}\n`);

  const first = await reInit(makeRepo(), caddyfile);
  expect(first.changed).toBe(true);
  const content = readTree(caddyfile).Caddyfile;
  expect(content).toContain(outside);
  expect(content).toContain(IMPORT_LINE);

  // A later run from a different folder writes nothing.
  const again = await reInit(makeRepo("other"), caddyfile);
  expect(again.changed).toBe(false);
  expect(readTree(caddyfile).Caddyfile).toBe(content);
});

test("a user-owned global options block is kept in place and gets devsite's directives once", async () => {
  const caddyfile = makeCaddyfile(
    [
      "# my note",
      "{",
      "\temail den@example.com",
      "}",
      "",
      ":8080 {",
      '\trespond "ok"',
      "}",
      "",
    ].join("\n"),
  );
  const repo = makeRepo();
  const first = await reInit(repo, caddyfile);
  expect(first.changed).toBe(true);
  const tree = readTree(caddyfile);

  // The user's block stays theirs (comment above it included), augmented in place.
  expect(tree.Caddyfile).toContain("# my note");
  expect(tree.Caddyfile).toContain("\temail den@example.com");
  expect(tree.Caddyfile).not.toContain("local_certs");
  expect(tree.Caddyfile).toContain("storage file_system");
  // The import line sits directly after the user's block — never before it.
  expect(tree.Caddyfile?.indexOf(IMPORT_LINE)).toBeGreaterThan(
    tree.Caddyfile?.indexOf("}") ?? Number.NaN,
  );

  const second = await reInit(repo, caddyfile);
  expect(second.changed).toBe(false);
  expect(readTree(caddyfile)).toEqual(tree);
});

// Caddy as the user can listen below 1024 only on all addresses, so a default_bind stops it from starting (ADR 0002).
test("a default_bind line leaves the user's global block; the rest of the block stays", async () => {
  const caddyfile = makeCaddyfile(
    ["{", "\temail den@example.com", "\tdefault_bind 127.0.0.1 100.64.0.9", "}", ""].join("\n"),
  );
  const repo = makeRepo();
  expect((await reInit(repo, caddyfile)).changed).toBe(true);
  const tree = readTree(caddyfile);
  expect(tree.Caddyfile).not.toContain("default_bind");
  expect(tree.Caddyfile).toContain("\temail den@example.com");
  expect((await reInit(repo, caddyfile)).changed).toBe(false);
});

test("a global block left with only devsite's directives once default_bind goes re-renders fresh", async () => {
  const caddyfile = makeCaddyfile(
    [
      "{",
      "\tstorage file_system {",
      '\t\troot "/somewhere"',
      "\t}",
      "\t# keep off the Wi-Fi",
      "\tdefault_bind 127.0.0.1",
      "}",
      "",
    ].join("\n"),
  );
  expect((await reInit(makeRepo(), caddyfile)).changed).toBe(true);
  // The pinned storage is the one Caddy already uses, so it survives the re-render.
  expect(readTree(caddyfile).Caddyfile).toBe(
    `${devsiteGlobalBlock("/somewhere")}\n\n${IMPORT_LINE}\n`,
  );
});
