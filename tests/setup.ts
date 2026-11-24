// bunfig.toml preloads this module before every suite (and helpers.ts imports it), so the overrides hold in full runs, filtered runs, and watch mode alike. Unconditional on purpose: an inherited shell value would be the developer's real setup.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// devsite's files (settings, state, the node's program, logs, the LaunchAgent) hang from this home, so no test reads or writes the developer's real ones. Suites that need their own re-point it per test.
process.env.DEVSITE_USER_HOME = mkdtempSync(join(tmpdir(), "devsite-home-default-"));

// Tests run from source, so init's node install copies this stand-in for dist/cli.js.
const program = join(mkdtempSync(join(tmpdir(), "devsite-program-")), "cli.js");
writeFileSync(program, "");
process.env.DEVSITE_NODE_PROGRAM = program;

// init and doctor read Caddy's admin API; a closed port keeps every suite off this Mac's real Caddy. Suites that serve a mock re-point the var per test.
process.env.DEVSITE_CADDY_ADMIN = "http://127.0.0.1:9";

// The clients call the node; a closed port keeps every suite off this Mac's real node. Suites that start a test node re-point the var per test.
process.env.DEVSITE_NODE = "http://127.0.0.1:9";

// The node asks Tailscale for the tailnet; this stand-in answers from a folder each test fills, and an empty one means no tailnet, so no suite binds this Mac's real Tailscale IP.
process.env.DEVSITE_TAILSCALE = join(import.meta.dir, "bin", "tailscale");
process.env.DEVSITE_FAKE_TAILSCALE = mkdtempSync(join(tmpdir(), "devsite-tailnet-none-"));

// A node tries a taken peer port again at each refresh; a short one lets a test see it take the port once freed.
process.env.DEVSITE_TAILNET_REFRESH_MS = "200";

// The node reads the Tailscale OAuth client secret from the login Keychain; this stand-in answers from a folder a test fills, and an empty one means no secret. The closed port keeps every suite off Tailscale's real API.
process.env.DEVSITE_SECURITY = join(import.meta.dir, "bin", "security");
process.env.DEVSITE_FAKE_SECURITY = mkdtempSync(join(tmpdir(), "devsite-keychain-none-"));
process.env.DEVSITE_TAILSCALE_API = "http://127.0.0.1:9";

// The node hears macOS sleep from a listener process; this stand-in prints what a test writes, so no suite starts the real one or hears this Mac sleep.
process.env.DEVSITE_SLEEP_LISTENER = join(import.meta.dir, "bin", "sleep-listener");
process.env.DEVSITE_FAKE_SLEEP = mkdtempSync(join(tmpdir(), "devsite-sleep-none-"));

// Before a node takes the route it asks this Mac's dnsmasq and Caddy; closed ports keep every suite off the real ones. Suites that need a Mac that serves names re-point both (tests/serving.ts).
process.env.DEVSITE_DNSMASQ_AT = "127.0.0.1:9";
process.env.DEVSITE_CADDY_AT = "127.0.0.1:9";
