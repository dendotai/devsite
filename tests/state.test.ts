// The state-dir resolver (#48): DEVSITE_STATE_DIR wins, then the platform
// default. Pure function — env, platform, and home are injected so no test
// touches the real home directory.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveStateDir } from "../src/state.mjs";

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
