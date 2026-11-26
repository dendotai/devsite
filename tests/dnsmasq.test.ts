// devsite's own dnsmasq on the Tailscale IP (ADR 0003): run(["init"]) and run(["doctor"]) on a set-up Caddy, per Tailscale and dnsmasq scenario. Each test reads what the command printed, which commands it ran, and its exit code; the sudo call runs nothing.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processRunner } from "../src/context";
import { renderConf, renderPlist, renderWatcher } from "../src/dnsmasq";
import {
  type CommandCall,
  cli,
  fakeStdin,
  MISSING,
  makeRepo,
  scriptedRunner,
  writeSettings,
} from "./helpers";
import {
  mockAdmin,
  nodeRoute,
  pki,
  setUpMachine,
  snapshot,
  USER_CADDYFILE,
  useMachine,
  useNodeWith,
} from "./machine";
import { serving } from "./serving";
import { fakeSplitDnsApi, type Route, SECRET } from "./split-dns-api";
import { freePort, statusJson } from "./two-macs";

useMachine();

const IP = "100.90.1.2";
const OLD_IP = "100.90.9.9";
const LABEL = "ai.den.devsite.dnsmasq";
const SET_UP_CADDYFILE = USER_CADDYFILE;
const USER_CONF = "address=/lan/192.168.1.10\n";

// tailscale: what Tailscale's app CLI gives; onPath: a `tailscale` on PATH gives the same. dig: what answers .internal on the Tailscale IP before init's sudo call and after it: an address, a reply status with no address (NXDOMAIN), or null for no reply. mac: what the Mac's resolver gives.
type Net = {
  tailscale: "absent" | "no-ip" | string;
  onPath?: boolean;
  // Tailscale is switched off (`tailscale down`): it still reports its IP, with BackendState Stopped.
  stopped?: boolean;
  dig?: string | null;
  digAfter?: string | null;
  mac?: string | null;
  loaded?: boolean;
  // The nameservers of the split DNS route for .internal (default: this Mac's IP), or null when `tailscale dns status` fails. devices: what `tailscale status` lists.
  route?: string[] | null;
  devices?: string;
  // The login Keychain holds no OAuth client secret until init stores one (default: it holds one). keychain: the folder the node's stand-in `security` reads, where init's store lands. api: the fake split DNS API, whose route `tailscale dns status` then shows.
  noSecret?: boolean;
  keychain?: string;
  api?: { state: { route: string[] | null } };
};

type Mac = {
  prefix: string;
  dir: string;
  caddyfile: string;
  systemRoot: string;
  conf: string;
  watcher: string;
  plist: string;
  binary: string;
};

// A set-up Caddy, a scratch root for devsite's root-owned files, and a dnsmasq of the user's own config in the Homebrew prefix. dnsmasq: the formula is installed; files: devsite's dnsmasq files as init writes them for that IP; oldBinary: the LaunchDaemon names that dnsmasq binary instead; noWatcher: the watcher file is missing.
async function setUp(
  opts: { dnsmasq?: boolean; files?: string; oldBinary?: string; noWatcher?: boolean } = {},
): Promise<Mac> {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const systemRoot = mkdtempSync(join(tmpdir(), "devsite-system-"));
  const conf = join(systemRoot, "Library", "Application Support", "devsite", "dnsmasq.conf");
  const watcher = join(dirname(conf), "dnsmasq-watcher.zsh");
  const plist = join(systemRoot, "Library", "LaunchDaemons", `${LABEL}.plist`);
  const binary = join(m.prefix, "opt", "dnsmasq", "sbin", "dnsmasq");
  writeFileSync(join(m.dir, "dnsmasq.conf"), USER_CONF);
  if (opts.dnsmasq) {
    mkdirSync(dirname(binary), { recursive: true });
    writeFileSync(binary, "");
  }
  if (opts.files !== undefined) {
    mkdirSync(dirname(conf), { recursive: true });
    mkdirSync(dirname(plist), { recursive: true });
    writeFileSync(conf, renderConf(opts.files));
    if (!opts.noWatcher) writeFileSync(watcher, renderWatcher());
    writeFileSync(plist, renderPlist(opts.oldBinary ?? binary, conf, watcher));
  }
  return {
    prefix: m.prefix,
    dir: m.dir,
    caddyfile: m.caddyfile,
    systemRoot,
    conf,
    watcher,
    plist,
    binary,
  };
}

// `tailscale dns status` with one `internal` line per nameserver.
function dnsStatus(...nameservers: string[]): string {
  return [
    "=== MagicDNS configuration ===",
    "",
    "Split DNS Routes:",
    ...nameservers.map((n) => `  - internal                       -> ${n}`),
    "  - ts.net.                        -> 199.247.155.53",
    "",
    "Search Domains:",
    "  - example.ts.net",
    "",
  ].join("\n");
}

function runner(net: Net) {
  let sudoRan = false;
  let stored = false;
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "openssl") return { stdout: pki.served };
    if (c.cmd === "security" && c.args[0] === "find-generic-password") {
      return { status: net.noSecret && !stored ? 44 : 0 };
    }
    if (c.cmd === "security" && c.args[0] === "-i") {
      stored = true;
      const secret = c.input?.trim().split(" ").at(-1) ?? "";
      if (net.keychain !== undefined) writeFileSync(join(net.keychain, "secret"), secret);
      return {};
    }
    if (c.cmd === "security") return {};
    if (c.cmd === "tailscale" && !net.onPath) return MISSING;
    if (c.cmd === "tailscale" || c.cmd === "/Applications/Tailscale.app/Contents/MacOS/Tailscale") {
      if (net.tailscale === "absent") return MISSING;
      if (net.tailscale === "no-ip") return { status: 1 };
      if (c.args[0] === "status" && c.args[1] === "--json") {
        const BackendState = net.stopped ? "Stopped" : "Running";
        return {
          stdout: JSON.stringify({
            BackendState,
            Self: { TailscaleIPs: [net.tailscale, "fd7a::1"] },
          }),
        };
      }
      if (c.args[0] === "status") return { stdout: net.devices ?? "" };
      if (c.args[0] === "dns") {
        const route = net.api ? (net.api.state.route ?? []) : net.route;
        if (route === null) return { status: 1 };
        return { stdout: dnsStatus(...(route ?? [net.tailscale])) };
      }
      return { stdout: `${net.tailscale}\n` };
    }
    if (c.cmd === "dig") {
      const answer = sudoRan && net.digAfter !== undefined ? net.digAfter : net.dig;
      if (answer == null) {
        return { status: 9, stdout: ";; connection timed out; no servers could be reached\n" };
      }
      const address = /^[\d.]+$/.test(answer);
      return {
        stdout: [
          `;; ->>HEADER<<- opcode: QUERY, status: ${address ? "NOERROR" : answer}, id: 1`,
          ";devsite-check.internal.\t\tIN\tA",
          ...(address ? [`devsite-check.internal.\t0\tIN\tA\t${answer}`] : []),
          "",
        ].join("\n"),
      };
    }
    if (c.cmd === "dscacheutil") {
      return { stdout: net.mac == null ? "" : `name: x\nip_address: ${net.mac}\n\n` };
    }
    if (c.cmd === "launchctl") return { status: net.loaded ? 0 : 113 };
    if (c.cmd === "sudo") sudoRan = true;
    return {};
  });
}

// noBrew: `brew --prefix` gives nothing, as on a Mac with no Homebrew. settings: the content of devsite's settings file.
async function devsite(
  argv: string[],
  m: Mac,
  net: Net,
  opts: {
    noBrew?: boolean;
    settings?: object;
    keys?: string[];
    tty?: boolean;
    // Standard input carries this text; the keys are pressed on the terminal.
    piped?: string;
    // The port the node calls other Macs' nodes on.
    peerPort?: number;
  } = {},
) {
  const { runCommand, calls } = runner(net);
  const home = process.env.DEVSITE_USER_HOME ?? "";
  if (opts.settings !== undefined) writeSettings(home, opts.settings);
  const cwd = makeRepo();
  await useNodeWith({ web: { folder: join(cwd, "apps", "web") } }, { peerPort: opts.peerPort });
  const r = await cli(argv, {
    home,
    cwd,
    caddyfile: m.caddyfile,
    runCommand,
    stdin:
      opts.piped === undefined
        ? fakeStdin(opts.keys ?? "y", opts.tty ?? true)
        : fakeStdin(opts.piped, false),
    terminal: opts.piped === undefined ? null : fakeStdin(opts.keys ?? "y", true),
    env: {
      DEVSITE_SYSTEM_ROOT: m.systemRoot,
      ...(opts.noBrew ? { DEVSITE_BREW_PREFIX: "" } : {}),
    },
  });
  const ran = calls.filter((c) => c.cmd !== "diff").map((c) => [c.cmd, ...c.args].join(" "));
  // No scenario touches the user's dnsmasq config or /etc/resolver.
  for (const c of ran) {
    expect(c).not.toContain("/etc/resolver");
    expect(c).not.toContain(join(m.dir, "dnsmasq.conf"));
  }
  expect(readFileSync(join(m.dir, "dnsmasq.conf"), "utf8")).toBe(USER_CONF);
  const sudo = ran.filter((c) => c.startsWith("sudo"));
  return { ...r, ran, sudo };
}

// --- no Tailscale ---

test("no Tailscale: doctor has no dnsmasq checks, and init installs nothing", async () => {
  const m = await setUp();
  const before = snapshot(m.systemRoot);
  const d = await devsite(["doctor"], m, { tailscale: "absent" });
  expect(d.stdout).toContain("dnsmasq: none, Tailscale is not on this Mac");
  expect(d.stdout).not.toContain("dnsmasq on the Tailscale IP");
  expect(d.ran.some((c) => c.startsWith("dig"))).toBe(false);
  expect(d.status).toBe(0);

  const i = await devsite(["init"], m, { tailscale: "absent" });
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.ran.filter((c) => c.startsWith("brew") || c.startsWith("launchctl"))).toEqual([]);
  expect(i.sudo).toEqual([]);
  expect(snapshot(m.systemRoot)).toEqual(before);
  expect(i.status).toBe(0);
});

test("Tailscale gives no IP: the dnsmasq check is skipped, and init installs nothing", async () => {
  const m = await setUp();
  const d = await devsite(["doctor"], m, { tailscale: "no-ip" });
  expect(d.stdout).toContain("dnsmasq: none, Tailscale is down (no IP)");
  expect(d.stdout).toContain(
    "– dnsmasq on the Tailscale IP answers .internal with it — Tailscale is down (no IP)",
  );
  expect(d.stdout).toContain("✗ Tailscale is up — Tailscale is down (no IP)");
  expect(d.stdout).toContain("fix: start Tailscale and log in");
  expect(d.stdout).toContain(
    "– the Tailscale split DNS route for .internal points to a Mac whose node answers — Tailscale is down",
  );
  expect(d.status).toBe(1);
  const i = await devsite(["init"], m, { tailscale: "no-ip" });
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.sudo).toEqual([]);
});

// --- a fresh install ---

test("a fresh install: doctor is red with init as the fix", async () => {
  const m = await setUp();
  const d = await devsite(["doctor"], m, { tailscale: IP });
  expect(d.stdout).toContain(
    `dnsmasq: devsite's config ${m.conf} is not written; the Tailscale IP is ${IP}`,
  );
  expect(d.stdout).toContain(
    `✗ dnsmasq on the Tailscale IP (${IP}) answers .internal with it — no answer`,
  );
  // The Mac asks through the split DNS route, which reaches the dnsmasq that does not answer yet: macOS's resolver would wait about a minute for it.
  expect(d.stdout).toContain(
    `– this Mac resolves .internal to ${IP} — nothing answers on ${IP} yet`,
  );
  expect(d.ran).toContain(`dig @${IP} +time=1 +tries=1 devsite-check.internal A`);
  expect(d.ran).not.toContain("dscacheutil -q host -a name devsite-check.internal");
  expect(d.sudo).toEqual([]);
  expect(d.status).toBe(1);
});

test("a fresh install: init installs dnsmasq, writes devsite's config and LaunchDaemon, and loads it, in one sudo call", async () => {
  const m = await setUp();
  const r = await devsite(["init"], m, { tailscale: IP, digAfter: IP });
  const dry = await devsite(["init", "--dry-run"], m, { tailscale: IP });
  expect(r.stdout).toContain(`${m.conf} — devsite's dnsmasq config, new`);
  expect(r.stdout).toContain(`${m.watcher} — devsite's dnsmasq watcher, new`);
  expect(r.stdout).toContain(`${m.plist} — devsite's dnsmasq LaunchDaemon, new`);
  expect(r.stdout).not.toContain("relative paths are in");
  expect(r.stdout).toContain("Step 1 of 2: install dnsmasq with Homebrew");
  expect(r.stdout).toContain(`Step 2 of 2: run devsite's dnsmasq on ${IP}  [sudo]`);
  expect(r.stdout).toContain(
    `devsite's LaunchDaemon ${m.plist} runs dnsmasq as root with ${m.conf} while this Mac has a Tailscale IP: it listens on ${IP} only and answers .internal with ${IP}`,
  );
  expect(dry.stdout).toContain(`+listen-address=${IP}`);
  expect(dry.stdout).toContain(`+address=/internal/${IP}`);
  expect(dry.stdout).toContain(`+\t\t<string>${m.binary}</string>`);
  expect(dry.stdout).toContain(`+\t\t<string>${m.watcher}</string>`);
  expect(dry.stdout).toContain("+coproc scutil");
  expect(dry.stdout).toContain("+\t\t<key>SuccessfulExit</key>\n+\t\t<false/>");
  expect(r.ran).toContain("brew install dnsmasq");
  expect(r.sudo).toHaveLength(1);
  const script = r.sudo[0] as string;
  expect(script).toContain(`install -d -m 755 '${dirname(m.conf)}'`);
  expect(script).toMatch(/install -m 644 -o root -g wheel \S+ '[^']+dnsmasq\.conf'/);
  expect(script).toMatch(/install -m 644 -o root -g wheel \S+ '[^']+dnsmasq-watcher\.zsh'/);
  expect(script).toContain(` ${m.plist} && launchctl bootstrap system ${m.plist}`);
  expect(script).not.toContain("bootout");
  expect(script).not.toContain("kickstart");
  // The run ends with the checks again: dnsmasq answers, and the Mac's lookup goes where the split DNS route sends it.
  expect(r.stdout).toContain(`✓ dnsmasq on the Tailscale IP (${IP}) answers .internal with it`);
  expect(r.stdout).toContain(`✗ this Mac resolves .internal to ${IP} — no answer`);
  expect(r.stdout).toContain(
    "fix: the Tailscale split DNS route decides where this Mac asks: see the Tailscale checks",
  );
  expect(r.status).toBe(0);
});

test("a LaunchDaemon file that names another dnsmasq: init unloads it, waits until launchd drops it, and loads the new one", async () => {
  const m = await setUp({
    dnsmasq: true,
    files: IP,
    oldBinary: "/usr/local/opt/dnsmasq/sbin/dnsmasq",
  });
  const r = await devsite(["init"], m, {
    tailscale: IP,
    dig: null,
    digAfter: IP,
    mac: IP,
    loaded: true,
  });
  const dry = await devsite(["init", "--dry-run"], m, {
    tailscale: IP,
    dig: null,
    mac: IP,
    loaded: true,
  });
  expect(r.stdout).toContain(`${m.plist} — devsite's dnsmasq LaunchDaemon, rewritten`);
  expect(dry.stdout).toContain(`-\t\t<string>/usr/local/opt/dnsmasq/sbin/dnsmasq</string>`);
  expect(dry.stdout).toContain(`+\t\t<string>${m.binary}</string>`);
  const script = r.sudo[0] as string;
  expect(script).not.toContain("dnsmasq.conf'");
  expect(script).toContain(
    `${m.plist} && launchctl bootout system/${LABEL} && sh -c 'i=0; while launchctl print system/${LABEL} >/dev/null 2>&1;`,
  );
  expect(script).toMatch(/done' && launchctl bootstrap system \S+\.plist$/);
  expect(r.status).toBe(0);
});

// --- a set-up Mac ---

test("a set-up Mac: doctor is green, and init asks nothing and runs no sudo", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const net: Net = { tailscale: IP, dig: IP, mac: IP, loaded: true };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(`dnsmasq: devsite's config ${m.conf}, listens on ${IP}`);
  expect(d.stdout).toContain(`✓ dnsmasq on the Tailscale IP (${IP}) answers .internal with it`);
  expect(d.stdout).toContain(`✓ this Mac resolves .internal to ${IP}`);
  expect(d.stdout).toContain(`✓ Tailscale is up, with IP ${IP}`);
  expect(d.stdout).toContain(
    `✓ the Tailscale split DNS route for .internal points to a Mac whose node answers (this Mac, ${IP})`,
  );
  expect(d.ran).toContain("tailscale dns status");
  expect(d.stdout).toContain("Every check is green.");
  expect(d.status).toBe(0);

  const before = snapshot(m.systemRoot);
  const i = await devsite(["init"], m, net);
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.stdout).not.toContain("Apply these changes?");
  expect(i.sudo).toEqual([]);
  expect(snapshot(m.systemRoot)).toEqual(before);
  expect(i.status).toBe(0);
});

// --- a changed Tailscale IP ---

test("a changed Tailscale IP: doctor names the old IP, and init rewrites the config and restarts dnsmasq", async () => {
  const m = await setUp({ dnsmasq: true, files: OLD_IP });
  const net: Net = { tailscale: IP, dig: null, digAfter: IP, mac: null, loaded: true };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(`dnsmasq: devsite's config ${m.conf}, listens on ${OLD_IP}`);
  expect(d.stdout).toContain(
    `✗ dnsmasq on the Tailscale IP (${IP}) answers .internal with it — no answer: devsite's config names ${OLD_IP}, the Tailscale IP before it changed`,
  );
  expect(d.status).toBe(1);

  const i = await devsite(["init"], m, net);
  expect(i.stdout).toContain(`Step 1 of 1: run devsite's dnsmasq on ${IP}  [sudo]`);
  expect(i.stdout).toContain(
    `the Tailscale IP changed from ${OLD_IP}; dnsmasq rereads it only on a restart, so sudo runs again`,
  );
  const dry = await devsite(["init", "--dry-run"], m, net);
  expect(i.stdout).toContain(`${m.conf} — devsite's dnsmasq config, rewritten`);
  expect(dry.stdout).toContain(`-listen-address=${OLD_IP}`);
  expect(dry.stdout).toContain(`+listen-address=${IP}`);
  expect(i.ran).not.toContain("brew install dnsmasq");
  const script = i.sudo[0] as string;
  expect(script).toMatch(
    /dnsmasq\.conf' && launchctl kickstart -k system\/ai\.den\.devsite\.dnsmasq$/,
  );
  // The LaunchDaemon did not change, so it stays loaded.
  expect(script).not.toContain(".plist");
  expect(i.status).toBe(0);
});

test("devsite's files are current but dnsmasq gives no answer: init restarts it, with no write", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(["init"], m, {
    tailscale: IP,
    dig: null,
    digAfter: IP,
    mac: IP,
    loaded: true,
  });
  expect(r.stdout).toContain(`Step 1 of 1: restart devsite's dnsmasq on ${IP}  [sudo]`);
  expect(r.sudo).toEqual([
    `sudo -p \n  Password for sudo (%u):  sh -c launchctl kickstart -k system/${LABEL}`,
  ]);
  expect(r.status).toBe(0);
});

test("the watcher file is missing: init writes it and restarts the loaded LaunchDaemon", async () => {
  const m = await setUp({ dnsmasq: true, files: IP, noWatcher: true });
  const r = await devsite(["init"], m, {
    tailscale: IP,
    dig: null,
    digAfter: IP,
    mac: IP,
    loaded: true,
  });
  expect(r.stdout).toContain(`Step 1 of 1: run devsite's dnsmasq on ${IP}  [sudo]`);
  const script = r.sudo[0] as string;
  expect(script).toMatch(
    /dnsmasq-watcher\.zsh' && launchctl kickstart -k system\/ai\.den\.devsite\.dnsmasq$/,
  );
  expect(script).not.toContain("dnsmasq.conf'");
  expect(r.status).toBe(0);
});

// --- a dnsmasq of the user's own on the Tailscale IP ---

test("a user dnsmasq answers .internal with the Tailscale IP: doctor is green, and init adds no dnsmasq", async () => {
  const m = await setUp({ dnsmasq: true });
  const net: Net = { tailscale: IP, dig: IP, mac: IP };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(`✓ dnsmasq on the Tailscale IP (${IP}) answers .internal with it`);
  expect(d.status).toBe(0);
  const before = snapshot(m.systemRoot);
  const i = await devsite(["init"], m, net);
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.sudo).toEqual([]);
  expect(snapshot(m.systemRoot)).toEqual(before);
});

test("a user dnsmasq answers .internal with another IP: doctor names the fix in the user's dnsmasq, and init leaves it", async () => {
  const m = await setUp({ dnsmasq: true });
  const net: Net = { tailscale: IP, dig: "127.0.0.1", mac: "127.0.0.1" };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(
    `✗ dnsmasq on the Tailscale IP (${IP}) answers .internal with it — answers 127.0.0.1, from a DNS server that is not devsite's`,
  );
  expect(d.stdout).toContain(
    `fix: if it is your own dnsmasq, make it answer \`address=/internal/${IP}\`, or stop it listening on ${IP}`,
  );
  expect(d.stdout).toContain(`✗ this Mac resolves .internal to ${IP} — resolves to 127.0.0.1`);
  expect(d.status).toBe(1);
  const i = await devsite(["init"], m, net);
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.sudo).toEqual([]);
  expect(i.status).toBe(0);
});

test("a user dnsmasq answers .internal with NXDOMAIN: doctor names the fix in the user's dnsmasq, and init runs no sudo", async () => {
  const m = await setUp({ dnsmasq: true });
  const net: Net = { tailscale: IP, dig: "NXDOMAIN", mac: null };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(
    `✗ dnsmasq on the Tailscale IP (${IP}) answers .internal with it — answers NXDOMAIN, from a DNS server that is not devsite's`,
  );
  expect(d.stdout).toContain(
    `✗ this Mac resolves .internal to ${IP} — no answer\n      fix: see the dnsmasq check above\n`,
  );
  expect(d.status).toBe(1);
  const i = await devsite(["init"], m, net);
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.sudo).toEqual([]);
});

test("a tailscale on PATH: its IP is used, and the app's CLI is not asked", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const d = await devsite(["doctor"], m, {
    tailscale: IP,
    onPath: true,
    dig: IP,
    mac: IP,
    loaded: true,
  });
  expect(d.stdout).toContain(`✓ dnsmasq on the Tailscale IP (${IP}) answers .internal with it`);
  expect(d.ran).toContain("tailscale status --json");
  expect(d.ran.some((c) => c.startsWith("/Applications/Tailscale.app"))).toBe(false);
});

test("no Homebrew and nothing answers: doctor names Homebrew as the fix, with no init repair", async () => {
  const m = await setUp();
  const d = await devsite(["doctor"], m, { tailscale: IP }, { noBrew: true });
  expect(d.stdout).toContain(
    `✗ dnsmasq on the Tailscale IP (${IP}) answers .internal with it — no answer, and devsite finds dnsmasq through Homebrew, which is not on this Mac`,
  );
  expect(d.stdout).toContain("fix: install Homebrew, then run `bunx devsite init`");
  expect(d.status).toBe(1);
});

// --- the dnsmasq.run setting ---

test("dnsmasq.run is manual: doctor names what must be true, and init installs and runs no dnsmasq", async () => {
  const m = await setUp();
  const settings = { dnsmasq: { run: "manual" } };
  const d = await devsite(["doctor"], m, { tailscale: IP }, { settings });
  expect(d.stdout).toContain(
    `✗ dnsmasq on the Tailscale IP (${IP}) answers .internal with it — no answer`,
  );
  expect(d.stdout).toMatch(
    new RegExp(
      `fix: make a DNS server on ${IP}:53 answer \\.internal with ${IP}: dnsmasq\\.run is manual in .+config\\.json, so init runs no dnsmasq`,
    ),
  );
  expect(d.status).toBe(1);
  const before = snapshot(m.systemRoot);
  const i = await devsite(["init"], m, { tailscale: IP }, { settings });
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.ran.filter((c) => c.startsWith("brew"))).toEqual([]);
  expect(i.sudo).toEqual([]);
  expect(snapshot(m.systemRoot)).toEqual(before);
  expect(i.status).toBe(0);
});

test("a settings file with a dnsmasq.run devsite cannot use, or an unknown section, stops doctor", async () => {
  const m = await setUp();
  const bad = await devsite(
    ["doctor"],
    m,
    { tailscale: IP },
    { settings: { dnsmasq: { run: "auto" } } },
  );
  expect(bad.stderr).toContain(
    'dnsmasq.run must be "manual", not "auto"; delete the key to use the default',
  );
  expect(bad.status).toBe(1);
  const unknown = await devsite(["doctor"], m, { tailscale: IP }, { settings: { dns: {} } });
  expect(unknown.stderr).toContain(
    "unknown section dns (known: caddy.config, caddy.user, caddy.reload, dnsmasq.run)",
  );
  expect(unknown.status).toBe(1);
});

// --- the split DNS route: the node writes it with the OAuth client secret init stores (#110) ---

const OTHER_IP = "100.90.7.7";
const SET_UP: Net = { tailscale: IP, dig: IP, mac: IP, loaded: true };
const SECRET_LABEL =
  "the login Keychain holds the Tailscale OAuth client secret, so the node can write the split DNS route";
const ROUTE_LABEL =
  "the Tailscale split DNS route for .internal points to a Mac whose node answers";
const SECRET_STEP =
  "store the Tailscale OAuth client secret in the login Keychain, so the node writes the split DNS route";

const nodeEnvKeys = [
  "DEVSITE_FAKE_TAILSCALE",
  "DEVSITE_FAKE_SECURITY",
  "DEVSITE_TAILSCALE_API",
  "DEVSITE_DNSMASQ_AT",
  "DEVSITE_CADDY_AT",
];
const savedNodeEnv = Object.fromEntries(nodeEnvKeys.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of nodeEnvKeys) process.env[k] = savedNodeEnv[k];
});

// The node init talks to sees this Mac (MacBook Pro at IP) and `peers` in its tailnet, reads its secret from an empty Keychain folder that init's store fills, and calls a fake split DNS API with `route`.
async function nodeTailnet(route: Route, peers: { name: string; ip: string }[] = []) {
  const tailnet = mkdtempSync(join(tmpdir(), "devsite-tailnet-"));
  writeFileSync(
    join(tailnet, "status.json"),
    JSON.stringify(statusJson({ name: "MacBook Pro", ip: IP }, peers)),
  );
  const keychain = mkdtempSync(join(tmpdir(), "devsite-keychain-"));
  const api = fakeSplitDnsApi(route);
  process.env.DEVSITE_FAKE_TAILSCALE = tailnet;
  process.env.DEVSITE_FAKE_SECURITY = keychain;
  process.env.DEVSITE_TAILSCALE_API = api.url;
  Object.assign(process.env, await serving(IP));
  return { api, keychain };
}

test("no secret in the login Keychain: doctor is red with init as the fix", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const d = await devsite(["doctor"], m, { ...SET_UP, noSecret: true, route: [] });
  expect(d.stdout).toContain(`✗ ${SECRET_LABEL} — no secret`);
  expect(d.stdout).toContain(
    "fix: run `bunx devsite init`. It asks for a Tailscale OAuth client secret and tells you where to create one.",
  );
  expect(d.stdout).toContain(`✗ ${ROUTE_LABEL} — no route`);
  expect(d.stdout).toContain(
    "fix: the node writes the route once the login Keychain holds the OAuth client secret: see the check above",
  );
  expect(d.status).toBe(1);
});

test("no secret: --dry-run names the step that asks for it, and asks nothing", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(["init", "--dry-run"], m, { ...SET_UP, noSecret: true, route: [] });
  expect(r.stdout).toContain(`Step 1 of 1: ${SECRET_STEP}  [manual]`);
  expect(r.stdout).toContain(
    "Create a Tailscale OAuth client: https://console.tailscale.com/admin/settings/trust-credentials",
  );
  expect(r.ran.filter((c) => c.startsWith("security -i"))).toEqual([]);
  expect(r.status).toBe(0);
});

test("the secret typed at the prompt goes to the login Keychain through stdin, never an argument, and the node writes this Mac's IP into the route", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const { api, keychain } = await nodeTailnet(null);
  const r = await devsite(
    ["init"],
    m,
    { ...SET_UP, noSecret: true, keychain, api },
    { keys: [`${SECRET}\r`] },
  );
  expect(r.stdout).not.toContain("Apply these changes?");
  expect(r.stdout).toContain("Tailscale OAuth client secret: \n");
  expect(r.stdout).not.toContain(SECRET);
  expect(r.ran).toContain("security -i");
  for (const c of r.ran) expect(c).not.toContain(SECRET);
  expect(r.stdout).toContain("Stored in the login Keychain.");
  expect(r.stdout).toContain(`The split DNS route for .internal names this Mac (${IP}).`);
  expect(api.state.writes).toEqual([[IP]]);
  expect(r.stdout).toContain(`✓ ${SECRET_LABEL}`);
  expect(r.stdout).toContain(`✓ ${ROUTE_LABEL} (this Mac, ${IP})`);
  expect(r.status).toBe(0);
});

test("a typed value that is no OAuth client secret asks again, and an empty line skips the step", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(
    ["init"],
    m,
    { ...SET_UP, noSecret: true, route: [] },
    {
      keys: ["k123CNTRL\r", "\r"],
    },
  );
  expect(r.stdout).toContain(
    "That doesn't look like an OAuth client secret. It should start with tskey-client-.",
  );
  expect(r.stdout.match(/Tailscale OAuth client secret: /g)).toHaveLength(2);
  expect(r.stdout).toContain(
    "Skipped. This Mac won't write the .internal route until you add the secret.",
  );
  expect(r.stdout).not.toContain("it ran and this is still red");
  expect(r.ran.filter((c) => c.startsWith("security -i"))).toEqual([]);
  expect(r.status).toBe(0);
});

test("--tailscale-secret - reads the secret from standard input and stores it, a stored one included", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const { api, keychain } = await nodeTailnet([OTHER_IP]);
  const r = await devsite(
    ["init", "--tailscale-secret", "-"],
    m,
    { ...SET_UP, keychain, api },
    { piped: `${SECRET}\n`, keys: ["y"] },
  );
  expect(r.stdout).toContain(`Step 1 of 1: ${SECRET_STEP}`);
  expect(r.stdout).toContain("Apply these changes? [Y/n]");
  expect(r.stdout).toContain("Stored in the login Keychain.");
  expect(r.stdout).toContain(
    `The split DNS route for .internal names ${OTHER_IP}, which is none of your Macs; this Mac takes it over in about 6 s if no node answers there.`,
  );
  expect(r.ran).toContain("security -i");
  for (const c of r.ran) expect(c).not.toContain(SECRET);
  expect(r.status).toBe(0);
});

test("--tailscale-secret - stores the secret while Tailscale is down", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(
    ["init", "--tailscale-secret", "-"],
    m,
    { ...SET_UP, tailscale: "no-ip" },
    { piped: `${SECRET}\n`, keys: ["y"] },
  );
  expect(r.ran).toContain("security -i");
  expect(r.stdout).toContain("Stored in the login Keychain.");
});

test("--tailscale-secret - with no secret on standard input, or with a terminal there, changes nothing", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const junk = await devsite(["init", "--tailscale-secret", "-"], m, SET_UP, { piped: "hello\n" });
  expect(junk.stderr).toBe(
    "standard input needs one Tailscale OAuth client secret, which starts with tskey-client-; nothing changed.\n",
  );
  expect(junk.status).toBe(1);
  const tty = await devsite(["init", "--tailscale-secret", "-"], m, SET_UP);
  expect(tty.stderr).toBe(
    "--tailscale-secret - reads the secret from standard input. Pipe it in, for example from your password manager's command line.\n",
  );
  expect(tty.status).toBe(1);
  const both = await devsite(["init", "--tailscale-secret", "-", "--ca", "-"], m, SET_UP, {
    piped: `${SECRET}\n`,
  });
  expect(both.stderr).toBe(
    "--ca - and --tailscale-secret - both read standard input: run init once for each\n",
  );
  expect(both.status).toBe(1);
  expect([...junk.ran, ...tty.ran, ...both.ran].filter((c) => c.startsWith("security -i"))).toEqual(
    [],
  );
});

test("the route names another Mac whose node answers: doctor is green on this Mac, and this Mac resolves .internal to that Mac", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const peerPort = await freePort();
  await nodeTailnet(["::1"], [{ name: "Mac mini", ip: "::1" }]);
  const other = createServer((_req, res) => {
    res.writeHead(200, { "devsite-protocol": "1", "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => other.listen(peerPort, "::1", r));
  try {
    const d = await devsite(["doctor"], m, { ...SET_UP, route: ["::1"], mac: "::1" }, { peerPort });
    expect(d.stdout).toContain(`✓ ${ROUTE_LABEL} (Mac mini, ::1)`);
    expect(d.stdout).toContain("✓ this Mac resolves .internal to ::1");
    // The one red check is the node's listen on IP, an address this test Mac does not have.
    expect(d.stdout.match(/✗ /g)).toHaveLength(1);
    expect(d.stdout).toContain(`✗ the node listens for other Macs on ${IP}:`);
  } finally {
    other.closeAllConnections();
    other.close();
  }
});

test("the route names a Mac whose node does not answer: doctor is red and names where the node logs why", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const net: Net = {
    ...SET_UP,
    route: [OTHER_IP],
    mac: OTHER_IP,
    devices: `${IP}  this-mac  dev@  macOS  -\n${OTHER_IP}  other-mac  dev@  macOS  -\n`,
  };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(
    `✗ ${ROUTE_LABEL} — it points to ${OTHER_IP}, the Tailscale IP of other-mac`,
  );
  expect(d.stdout).toContain(
    "fix: the node takes the route over about 6 s after the Mac it names stops answering; its log says why it has not:",
  );
  expect(d.status).toBe(1);
});

test("`tailscale dns status` gives no answer: doctor names the Tailscale update", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const d = await devsite(["doctor"], m, { ...SET_UP, route: null });
  expect(d.stdout).toContain("— `tailscale dns status` gave no answer");
  expect(d.stdout).toContain(
    "fix: update Tailscale, so `tailscale dns status` lists the split DNS routes",
  );
  expect(d.status).toBe(1);
});

test("the Mac's lookup gets a time limit, so a split DNS route to a Mac that is off cannot stall init", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const { runCommand, calls } = runner({ tailscale: IP, dig: IP, mac: IP, loaded: true });
  await cli(["doctor"], {
    cwd: makeRepo(),
    caddyfile: m.caddyfile,
    runCommand,
    env: { DEVSITE_SYSTEM_ROOT: m.systemRoot },
  });
  const lookup = calls.find((c) => c.cmd === "dscacheutil");
  expect(lookup?.timeoutMs).toBe(3000);
});

test("a command past its time limit is stopped and reads as failed", () => {
  const started = Date.now();
  const r = processRunner("sleep", ["5"], { capture: true, timeoutMs: 100 });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(r.status).not.toBe(0);
});

test("Tailscale is switched off but still reports its IP: doctor reads it as down, and init runs no sudo", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const net = { tailscale: IP, stopped: true, dig: null, mac: null, loaded: true };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain("✗ Tailscale is up — Tailscale is down (no IP)");
  expect(d.stdout).not.toContain("✗ dnsmasq on the Tailscale IP");
  expect(d.ran).not.toContain("dscacheutil -q host -a name devsite-check.internal");
  const i = await devsite(["init"], m, net);
  expect(i.stdout).toContain("Nothing to do: init changed nothing.");
  expect(i.sudo).toEqual([]);
});
