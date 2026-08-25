// Shared fixtures for the CLI test suites.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

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

// A path to a Caddyfile that does not exist, in its own scratch dir — dry
// runs only ever read it, so one can serve a whole suite.
export function scratchCaddyfile() {
  return join(mkdtempSync(join(tmpdir(), "devsite-none-")), "Caddyfile");
}
