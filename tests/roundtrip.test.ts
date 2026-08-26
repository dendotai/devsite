// Round-trip tests pinning `devsite init`'s ownership contract (#27):
// everything devsite does not own survives a re-init byte-for-byte.
//
// The suite observes init only through its public surface — an in-process
// run(["init", "--dry-run"]) and the unified diff it prints — applies that
// diff to the scratch file with patch(1), and asserts the resulting file
// bytes. No init internals are imported, so the suite survives (and guards)
// an ownership rewrite. patch(1) is exact: the patched file holds the same
// bytes a confirmed real run would write.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { cli, makeRepo, scratchCaddyfile } from "./helpers";

// Run a dry-run and extract its unified diff; null = already up to date.
async function dryRunDiff(cwd: string, caddyfile: string): Promise<string | null> {
  const r = await cli(["init", "--dry-run"], { cwd, caddyfile });
  if (r.status !== 0) throw new Error(`dry-run failed:\n${r.stderr}`);
  if (r.stdout.includes("already up to date")) return null;
  const m = r.stdout.match(/the diff:\n\n([\s\S]*)$/);
  if (!m?.[1]) throw new Error(`no diff in dry-run output:\n${r.stdout}`);
  return m[1];
}

// One round trip: dry-run, apply the diff, return the file's final bytes and
// whether anything was pending — callers that spliced the file assert
// `changed` so a false "already up to date" can never pass vacuously.
async function reInit(cwd: string, caddyfile: string) {
  const diff = await dryRunDiff(cwd, caddyfile);
  if (diff !== null) {
    const r = spawnSync("patch", ["-s", caddyfile], { input: diff, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`patch failed: ${r.stderr}`);
    // Fidelity anchor: after applying, init must report nothing left to
    // write — diff(1)'s exit 0 proves the patched bytes are exactly what a
    // confirmed real run would render, not merely what the printed diff said.
    if ((await dryRunDiff(cwd, caddyfile)) !== null) {
      throw new Error("patched file does not converge to init's own rendering");
    }
  }
  return { content: readFileSync(caddyfile, "utf8"), changed: diff !== null };
}

// A Caddyfile whose target exists from the start — patch needs a file to
// patch, and an empty file renders identically to a missing one.
function makeCaddyfile(content = "") {
  const p = scratchCaddyfile();
  writeFileSync(p, content);
  return p;
}

// A foreign site block in devsite's own rendered shape — what another repo's
// `devsite init` left in the managed region. Deliberately hand-written, not
// imported: the black-box claim above forbids reaching into the renderer, so
// this shape must track renderRegion in src/commands/init.ts by hand.
function foreignBlock(host: string, project: string) {
  return [
    `# ${project}`,
    `${host} {`,
    "\ttls {",
    "\t\tissuer internal {",
    "\t\t\tlifetime 168h",
    "\t\t}",
    "\t}",
    `\trespond "devsite: dev server for ${host} is not running (start it with bun dev)" 503`,
    "}",
  ].join("\n");
}

test("foreign blocks survive byte-for-byte: first, last, and adjacent positions", async () => {
  const repo = makeRepo(); // own host: web.test.internal, project "web"
  const caddyfile = makeCaddyfile();
  const { content: rendered } = await reInit(repo, caddyfile);

  // Splice foreign blocks into the rendered region: one before the own block
  // (first), two directly abutting each other after it (last, adjacent).
  const first = foreignBlock("aaa.test.internal", "aaa");
  const adjacent1 = foreignBlock("bbb.test.internal", "bbb");
  const adjacent2 = foreignBlock("ccc.test.internal", "ccc");
  const spliced = rendered
    .replace("\n# web\n", `\n${first}\n\n# web\n`)
    .replace("\n# <<< devsite <<<", `\n${adjacent1}\n${adjacent2}\n# <<< devsite <<<`);
  writeFileSync(caddyfile, spliced);

  const { content: result, changed } = await reInit(repo, caddyfile);
  expect(changed).toBe(true);
  // Each block survives byte-for-byte, exactly once — the own block included.
  expect(result.split(first).length).toBe(2);
  expect(result.split(adjacent1).length).toBe(2);
  expect(result.split(adjacent2).length).toBe(2);
  expect(result.split("# web\nweb.test.internal {").length).toBe(2);
});

test("hosts that prefix each other stay distinct: neither absorbs the other", async () => {
  const repo = makeRepo(); // own host: web.test.internal
  const caddyfile = makeCaddyfile();
  const { content: rendered } = await reInit(repo, caddyfile);

  // One foreign host is a prefix of the own host, one extends it.
  const prefix = foreignBlock("web.test", "shorter");
  const extension = foreignBlock("web.test.internal2", "longer");
  writeFileSync(
    caddyfile,
    rendered.replace("\n# <<< devsite <<<", `\n${prefix}\n\n${extension}\n# <<< devsite <<<`),
  );

  const { content: result, changed } = await reInit(repo, caddyfile);
  expect(changed).toBe(true);
  expect(result.split(prefix).length).toBe(2);
  expect(result.split(extension).length).toBe(2);
  expect(result.split("# web\nweb.test.internal {").length).toBe(2);
});

test("content outside the devsite region survives byte-for-byte", async () => {
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
  // The chunk may move below the managed region, but its bytes are intact.
  expect(first.content).toContain(outside);

  // A later re-init from a different repo re-renders the existing region for
  // real (new own host, old block kept as foreign) — the chunk still survives.
  const again = await reInit(makeRepo("other.test.internal"), caddyfile);
  expect(again.changed).toBe(true);
  expect(again.content).toContain(outside);
});

test("re-running init on its own output is byte-identical", async () => {
  const repo = makeRepo();
  const caddyfile = makeCaddyfile();
  const first = await reInit(repo, caddyfile);
  expect(first.changed).toBe(true);

  const second = await reInit(repo, caddyfile);
  expect(second.changed).toBe(false);
  expect(second.content).toBe(first.content);
});

test("re-running after a foreign-block splice is also idempotent", async () => {
  const repo = makeRepo();
  const caddyfile = makeCaddyfile();
  const { content: rendered } = await reInit(repo, caddyfile);
  writeFileSync(
    caddyfile,
    rendered.replace(
      "\n# <<< devsite <<<",
      `\n${foreignBlock("other.test.internal", "other")}\n# <<< devsite <<<`,
    ),
  );

  const settled = await reInit(repo, caddyfile);
  expect(settled.changed).toBe(true);

  const again = await reInit(repo, caddyfile);
  expect(again.changed).toBe(false);
  expect(again.content).toBe(settled.content);
});

test("v0-format migration keeps every foreign block byte-for-byte", async () => {
  const foreign1 = foreignBlock("other1.internal", "otherproj1");
  const foreign2 = foreignBlock("other2.internal", "otherproj2");
  const v0 = [
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
    foreign1,
    "",
    foreign2,
    "",
  ].join("\n");
  const repo = makeRepo();
  const caddyfile = makeCaddyfile(v0);

  const { content: result, changed } = await reInit(repo, caddyfile);
  expect(changed).toBe(true);
  expect(result.split(foreign1).length).toBe(2);
  expect(result.split(foreign2).length).toBe(2);
  expect(result).toContain("# web\nweb.test.internal {");
  // The migrated file is stable from the first re-render on.
  expect(await dryRunDiff(repo, caddyfile)).toBeNull();
});
