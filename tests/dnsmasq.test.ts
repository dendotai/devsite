// devsite's own dnsmasq on the Tailscale IP (ADR 0003): run(["init"]) and run(["doctor"]) on a set-up Caddy, per Tailscale and dnsmasq scenario. Each test reads what the command printed, which commands it ran, and its exit code; the sudo call runs nothing.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processRunner } from "../src/context";
import { renderConf, renderPlist, renderWatcher } from "../src/dnsmasq";
import { type CommandCall, cli, fakeStdin, MISSING, makeRepo, scriptedRunner } from "./helpers";
import { mockAdmin, pki, placeholder, setUpMachine, snapshot, useMachine } from "./machine";

useMachine();

const IP = "100.90.1.2";
const OLD_IP = "100.90.9.9";
const LABEL = "ai.den.devsite.dnsmasq";
const SET_UP_CADDYFILE =
  '{\n\temail dev@example.com\n\tstorage file_system {\n\t\troot "STORAGE"\n\t}\n}\n\nimport devsite.d/*.caddy # devsite\n';
const USER_CONF = "address=/lan/192.168.1.10\n";

// tailscale: what Tailscale's app CLI gives; onPath: a `tailscale` on PATH gives the same. dig: what answers .internal on the Tailscale IP before init's sudo call and after it: an address, a reply status with no address (NXDOMAIN), or null for no reply. mac: what the Mac's resolver gives.
type Net = {
  tailscale: "absent" | "no-ip" | string;
  onPath?: boolean;
  dig?: string | null;
  digAfter?: string | null;
  mac?: string | null;
  loaded?: boolean;
  // The nameservers of the split DNS route for internal (default: this Mac's IP), or null when `tailscale dns status` fails; routeAfterOpen: the nameservers once init has run `open` for the admin console. devices: what `tailscale status` lists.
  route?: string[] | null;
  routeAfterOpen?: string[];
  devices?: string;
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
  await mockAdmin([placeholder()]);
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
  let opened = false;
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "openssl") return { stdout: pki.served };
    if (c.cmd === "security") return {};
    if (c.cmd === "tailscale" && !net.onPath) return MISSING;
    if (c.cmd === "tailscale" || c.cmd === "/Applications/Tailscale.app/Contents/MacOS/Tailscale") {
      if (net.tailscale === "absent") return MISSING;
      if (net.tailscale === "no-ip") return { status: 1 };
      if (c.args[0] === "status") return { stdout: net.devices ?? "" };
      if (c.args[0] === "dns") {
        const route = opened && net.routeAfterOpen ? net.routeAfterOpen : net.route;
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
    if (c.cmd === "open") opened = true;
    return {};
  });
}

// noBrew: `brew --prefix` gives nothing, as on a Mac with no Homebrew. settings: the content of devsite's settings file.
async function devsite(
  argv: string[],
  m: Mac,
  net: Net,
  opts: { noBrew?: boolean; settings?: object; keys?: string[]; tty?: boolean } = {},
) {
  const { runCommand, calls } = runner(net);
  const configHome = mkdtempSync(join(tmpdir(), "devsite-config-"));
  if (opts.settings !== undefined) {
    mkdirSync(join(configHome, "devsite"));
    writeFileSync(join(configHome, "devsite", "config.json"), JSON.stringify(opts.settings));
  }
  const r = await cli(argv, {
    configHome,
    cwd: makeRepo(),
    caddyfile: m.caddyfile,
    runCommand,
    stdin: fakeStdin(opts.keys ?? "y", opts.tty ?? true),
    env: {
      DEVSITE_SYSTEM_ROOT: m.systemRoot,
      DEVSITE_SPLIT_DNS_WAIT_MS: "0",
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
  expect(d.stdout).not.toContain("dnsmasq answers");
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
  expect(d.stdout).toContain("dnsmasq: none, Tailscale gives no IP");
  expect(d.stdout).toContain(
    "– dnsmasq answers .internal on the Tailscale IP — Tailscale gives no IP: it is stopped or logged out",
  );
  expect(d.stdout).toContain(
    "✗ Tailscale is up — Tailscale gives no IP: it is stopped or logged out",
  );
  expect(d.stdout).toContain("fix: start Tailscale and log in");
  expect(d.stdout).toContain(
    "– the Tailscale split DNS route for internal points to this Mac — Tailscale is down",
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
  expect(d.stdout).toContain(`✗ dnsmasq answers .internal with ${IP} on ${IP} — no answer`);
  expect(d.stdout).toContain(`✗ this Mac resolves .internal to ${IP} — no answer`);
  // The Mac asks through the split DNS route, which reaches the dnsmasq that does not answer yet.
  expect(d.stdout).toContain("fix: fix the dnsmasq check above first");
  expect(d.ran).toContain(`dig @${IP} +time=1 +tries=1 devsite-check.internal A`);
  expect(d.ran).toContain("dscacheutil -q host -a name devsite-check.internal");
  expect(d.sudo).toEqual([]);
  expect(d.status).toBe(1);
});

test("a fresh install: init installs dnsmasq, writes devsite's config and LaunchDaemon, and loads it, in one sudo call", async () => {
  const m = await setUp();
  const r = await devsite(["init"], m, { tailscale: IP, digAfter: IP });
  expect(r.stdout).toContain("Step 1 of 2: install dnsmasq with Homebrew");
  expect(r.stdout).toContain(`Step 2 of 2: run devsite's dnsmasq on ${IP}  [sudo]`);
  expect(r.stdout).toContain(
    `devsite's LaunchDaemon ${m.plist} runs dnsmasq as root with ${m.conf} while this Mac has a Tailscale IP: it listens on ${IP} only and answers .internal with ${IP}`,
  );
  expect(r.stdout).toContain(`+listen-address=${IP}`);
  expect(r.stdout).toContain(`+address=/internal/${IP}`);
  expect(r.stdout).toContain(`+\t\t<string>${m.binary}</string>`);
  expect(r.stdout).toContain(`+\t\t<string>${m.watcher}</string>`);
  expect(r.stdout).toContain("+coproc scutil");
  expect(r.stdout).toContain("+\t\t<key>SuccessfulExit</key>\n+\t\t<false/>");
  expect(r.ran).toContain("brew install dnsmasq");
  expect(r.sudo).toHaveLength(1);
  const script = r.sudo[0] as string;
  expect(script).toContain(`install -d -m 755 '${dirname(m.conf)}'`);
  expect(script).toMatch(/install -m 644 -o root -g wheel \S+ '[^']+dnsmasq\.conf'/);
  expect(script).toMatch(/install -m 644 -o root -g wheel \S+ '[^']+dnsmasq-watcher\.zsh'/);
  expect(script).toContain(` ${m.plist} && launchctl bootstrap system ${m.plist}`);
  expect(script).not.toContain("bootout");
  expect(script).not.toContain("kickstart");
  // The run ends with the checks again: dnsmasq answers, and the split DNS route is still the user's step.
  expect(r.stdout).toContain(`✓ dnsmasq answers .internal with ${IP} on ${IP}`);
  expect(r.stdout).toContain(`✗ this Mac resolves .internal to ${IP} — no answer`);
  expect(r.stdout).toContain(
    `fix: in the Tailscale admin console (https://login.tailscale.com/admin/dns), add a split DNS nameserver: domain internal, nameserver ${IP}`,
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
  expect(r.stdout).toContain(`-\t\t<string>/usr/local/opt/dnsmasq/sbin/dnsmasq</string>`);
  expect(r.stdout).toContain(`+\t\t<string>${m.binary}</string>`);
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
  expect(d.stdout).toContain(`✓ dnsmasq answers .internal with ${IP} on ${IP}`);
  expect(d.stdout).toContain(`✓ this Mac resolves .internal to ${IP}`);
  expect(d.stdout).toContain(`✓ Tailscale is up, with IP ${IP}`);
  expect(d.stdout).toContain(
    `✓ the Tailscale split DNS route for internal points to this Mac (${IP})`,
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
    `✗ dnsmasq answers .internal with ${IP} on ${IP} — no answer: devsite's config names ${OLD_IP}, the Tailscale IP before it changed`,
  );
  expect(d.status).toBe(1);

  const i = await devsite(["init"], m, net);
  expect(i.stdout).toContain(`Step 1 of 1: run devsite's dnsmasq on ${IP}  [sudo]`);
  expect(i.stdout).toContain(
    `the Tailscale IP changed from ${OLD_IP}; dnsmasq rereads it only on a restart, so sudo runs again`,
  );
  expect(i.stdout).toContain(`-listen-address=${OLD_IP}`);
  expect(i.stdout).toContain(`+listen-address=${IP}`);
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
  expect(d.stdout).toContain(`✓ dnsmasq answers .internal with ${IP} on ${IP}`);
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
    `✗ dnsmasq answers .internal with ${IP} on ${IP} — answers 127.0.0.1, from a DNS server that is not devsite's`,
  );
  expect(d.stdout).toContain(
    `fix: if it is your own dnsmasq, make it answer address=/internal/${IP}, or stop it listening on ${IP}`,
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
    `✗ dnsmasq answers .internal with ${IP} on ${IP} — answers NXDOMAIN, from a DNS server that is not devsite's`,
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
  expect(d.stdout).toContain(`✓ dnsmasq answers .internal with ${IP} on ${IP}`);
  expect(d.ran).toContain("tailscale ip -4");
  expect(d.ran.some((c) => c.startsWith("/Applications/Tailscale.app"))).toBe(false);
});

test("no Homebrew and nothing answers: doctor names Homebrew as the fix, with no init repair", async () => {
  const m = await setUp();
  const d = await devsite(["doctor"], m, { tailscale: IP }, { noBrew: true });
  expect(d.stdout).toContain(
    `✗ dnsmasq answers .internal with ${IP} on ${IP} — no answer, and devsite finds dnsmasq through Homebrew, which is not on this Mac`,
  );
  expect(d.stdout).toContain("fix: install Homebrew, then run bunx devsite init");
  expect(d.status).toBe(1);
});

// --- the dnsmasq.run setting ---

test("dnsmasq.run is manual: doctor names what must be true, and init installs and runs no dnsmasq", async () => {
  const m = await setUp();
  const settings = { dnsmasq: { run: "manual" } };
  const d = await devsite(["doctor"], m, { tailscale: IP }, { settings });
  expect(d.stdout).toContain(`✗ dnsmasq answers .internal with ${IP} on ${IP} — no answer`);
  expect(d.stdout).toMatch(
    new RegExp(
      `fix: dnsmasq\\.run is manual in \\S+config\\.json, so init runs no dnsmasq: make a DNS server on ${IP}:53 answer \\.internal with ${IP}`,
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
  expect(bad.stderr).toContain('dnsmasq.run must be "manual", not "auto"');
  expect(bad.status).toBe(1);
  const unknown = await devsite(["doctor"], m, { tailscale: IP }, { settings: { dns: {} } });
  expect(unknown.stderr).toContain(
    'unknown section "dns" (known: caddy.config, caddy.user, caddy.reload, dnsmasq.run)',
  );
  expect(unknown.status).toBe(1);
});

// --- the split DNS route (#76) ---

const OTHER_IP = "100.90.7.7";
const ADMIN = "https://login.tailscale.com/admin/dns";
const SET_UP: Net = { tailscale: IP, dig: IP, mac: IP, loaded: true };

test("no split DNS route: the plan names the manual step with its values, and --dry-run asks nothing", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(["init", "--dry-run"], m, { ...SET_UP, route: [] });
  expect(r.stdout).toContain(
    "✗ the Tailscale split DNS route for internal points to this Mac (100.90.1.2) — no route",
  );
  expect(r.stdout).toContain(
    "Step 1 of 1: add the split DNS route for internal in the Tailscale admin console, so the phone finds .internal names  [manual]",
  );
  expect(r.stdout).toContain(`nameserver: ${IP}`);
  expect(r.stdout).toContain("restrict to domain: internal");
  expect(r.ran).not.toContain(`open ${ADMIN}`);
  expect(r.status).toBe(0);
});

test("the route added after the prompt: init opens the admin console, checks the route, and goes green, with no Apply prompt", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(
    ["init"],
    m,
    { ...SET_UP, route: [], routeAfterOpen: [IP] },
    {
      keys: ["y", "y"],
    },
  );
  expect(r.stdout).not.toContain("Apply these changes?");
  expect(r.stdout).toContain(`Open ${ADMIN} in your browser? (y/n) y`);
  expect(r.ran).toContain(`open ${ADMIN}`);
  expect(r.stdout).toContain("Done? Press y to check, n to skip y");
  expect(r.stdout).toContain("The split DNS route for internal points to this Mac.");
  expect(r.stdout).toContain(
    `✓ the Tailscale split DNS route for internal points to this Mac (${IP})`,
  );
  expect(r.sudo).toEqual([]);
  expect(r.status).toBe(0);
});

test("a failed check asks again, and a skip leaves init exit 0 and doctor exit 1", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const net: Net = { ...SET_UP, route: [] };
  const r = await devsite(["init"], m, net, { keys: ["n", "y", "n"] });
  expect(r.ran).not.toContain(`open ${ADMIN}`);
  expect(r.stdout).toContain("Not yet: `tailscale dns status` shows no route.");
  expect(r.stdout.match(/Done\? Press y to check, n to skip/g)).toHaveLength(2);
  expect(r.stdout).toContain(
    `Skipped: \`bunx devsite doctor\` stays red until the route for internal points to ${IP}.`,
  );
  expect(r.status).toBe(0);

  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(
    `fix: in the Tailscale admin console (${ADMIN}), add a split DNS nameserver: domain internal, nameserver ${IP}`,
  );
  expect(d.status).toBe(1);
});

test("Ctrl-C at the open prompt skips the step", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(["init"], m, { ...SET_UP, route: [] }, { keys: ["\x03"] });
  expect(r.stdout).toContain("(y/n) ^C");
  expect(r.stdout).not.toContain("Done? Press y");
  expect(r.stdout).toContain("Skipped:");
  expect(r.status).toBe(0);
});

test("the route points to another Mac: doctor and init name that Mac, and init offers to change the route", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const net: Net = {
    ...SET_UP,
    route: [OTHER_IP],
    devices: `${IP}  this-mac  dev@  macOS  -\n${OTHER_IP}  other-mac  dev@  macOS  -\n`,
  };
  const d = await devsite(["doctor"], m, net);
  expect(d.stdout).toContain(
    `✗ the Tailscale split DNS route for internal points to this Mac (${IP}) — it points to ${OTHER_IP}, the Tailscale IP of other-mac`,
  );
  expect(d.stdout).toContain(
    `fix: the phone opens one Mac's projects per tailnet (https://github.com/dendotai/devsite/issues/66): to use this Mac's, change the nameserver for internal to ${IP}`,
  );
  expect(d.status).toBe(1);

  const i = await devsite(["init"], m, net, { keys: ["n", "y", "n"] });
  expect(i.stdout).toContain(
    "Step 1 of 1: change the split DNS route for internal in the Tailscale admin console",
  );
  expect(i.stdout).toContain(
    `the route now points to ${OTHER_IP}, the Tailscale IP of other-mac: change it to ${IP}, and that device's projects stop opening on the phone`,
  );
  expect(i.stdout).toContain(
    `Not yet: \`tailscale dns status\` shows it points to ${OTHER_IP}, the Tailscale IP of other-mac.`,
  );
  expect(i.status).toBe(0);
});

test("no TTY and only the manual step: init prints the step and exits 0", async () => {
  const m = await setUp({ dnsmasq: true, files: IP });
  const r = await devsite(["init"], m, { ...SET_UP, route: [] }, { tty: false });
  expect(r.stdout).toContain(`nameserver: ${IP}`);
  expect(r.stdout).toContain("Run `bunx devsite init` in a terminal to be guided through it.");
  expect(r.ran).not.toContain(`open ${ADMIN}`);
  expect(r.status).toBe(0);
});

test("a fresh install with no route: the manual step runs after the one sudo call", async () => {
  const m = await setUp();
  const r = await devsite(
    ["init"],
    m,
    { tailscale: IP, digAfter: IP, route: [] },
    {
      keys: ["y", "n", "n"],
    },
  );
  expect(r.stdout).toContain("Step 3 of 3: add the split DNS route for internal");
  expect(r.sudo).toHaveLength(1);
  expect(r.stdout.indexOf(`sudo install -d`)).toBeLessThan(r.stdout.indexOf(`Open ${ADMIN}`));
  expect(r.status).toBe(0);
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
