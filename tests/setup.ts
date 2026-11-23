// bunfig.toml preloads this module before every suite (and helpers.ts imports it), so the overrides hold in full runs, filtered runs, and watch mode alike. Unconditional on purpose: an inherited shell value would be the developer's real setup.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// devsite's files (settings, state, the node's program, logs, the LaunchAgent) hang from this home, so no test reads or writes the developer's real ones. Suites that need their own re-point it per test.
process.env.DEVSITE_USER_HOME = mkdtempSync(join(tmpdir(), "devsite-home-default-"));

// init and doctor read Caddy's admin API; a closed port keeps every suite off this Mac's real Caddy. Suites that serve a mock re-point the var per test.
process.env.DEVSITE_CADDY_ADMIN = "http://127.0.0.1:9";

// The clients call the node; a closed port keeps every suite off this Mac's real node. Suites that start a test node re-point the var per test.
process.env.DEVSITE_NODE = "http://127.0.0.1:9";
