// The state-dir resolver and the last-used stamp (#48). Everything is
// injected — env/platform/home for the resolver, the target dir for the
// stamp — so no test touches the real home directory.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir, stampLastUsed } from "../src/state.mjs";
import { makeStateDir } from "./helpers";

test("DEVSITE_STATE_DIR overrides everything, on any platform", () => {
  expect(resolveStateDir({ DEVSITE_STATE_DIR: "/custom/state" }, "darwin", "/Users/x")).toBe(
    "/custom/state",
  );
  expect(resolveStateDir({ DEVSITE_STATE_DIR: "/custom/state" }, "linux", "/home/x")).toBe(
    "/custom/state",
  );
});

test("darwin default: ~/Library/Application Support/devsite", () => {
  expect(resolveStateDir({}, "darwin", "/Users/x")).toBe(
    join("/Users/x", "Library", "Application Support", "devsite"),
  );
});

test("linux honors XDG_STATE_HOME", () => {
  expect(resolveStateDir({ XDG_STATE_HOME: "/xdg/state" }, "linux", "/home/x")).toBe(
    join("/xdg/state", "devsite"),
  );
});

test("linux default without XDG_STATE_HOME: ~/.local/state/devsite", () => {
  expect(resolveStateDir({}, "linux", "/home/x")).toBe(
    join("/home/x", ".local", "state", "devsite"),
  );
});

test("an empty DEVSITE_STATE_DIR does not override", () => {
  expect(resolveStateDir({ DEVSITE_STATE_DIR: "" }, "linux", "/home/x")).toBe(
    join("/home/x", ".local", "state", "devsite"),
  );
});

test("any host name lands in the stamp file, __proto__ included", async () => {
  const dir = makeStateDir();
  await stampLastUsed("__proto__", dir);
  const stamps = JSON.parse(readFileSync(join(dir, "last-used.json"), "utf8"));
  expect(Object.keys(stamps)).toContain("__proto__");
});

test("concurrent stamps in one process never corrupt the file", async () => {
  const dir = makeStateDir();
  await Promise.all([stampLastUsed("a.internal", dir), stampLastUsed("b.internal", dir)]);
  // One date may lose to the other (advisory data); the file must stay
  // parseable and non-empty.
  const stamps = JSON.parse(readFileSync(join(dir, "last-used.json"), "utf8"));
  expect(Object.keys(stamps).length).toBeGreaterThanOrEqual(1);
});
