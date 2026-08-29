// The Vite plugin stamps a last-used date into the DEVSITE_STATE_DIR state
// file on every dev-server start (#48). bunfig.toml preloads this module
// before every suite (and helpers.ts imports it), so the override holds in
// full runs, filtered runs (`bun test tests/state.test.ts`), and watch mode
// alike — no test can ever write the real state file. Unconditional on
// purpose: an inherited shell value would be the developer's real dir.
// Suites that assert on the stamp re-point the var per test.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DEVSITE_STATE_DIR = mkdtempSync(join(tmpdir(), "devsite-state-default-"));
