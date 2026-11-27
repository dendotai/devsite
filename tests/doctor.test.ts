// `devsite doctor` scenarios, one per check, green and red: run(["doctor"]) over a scratch Caddy dir, a scripted runner (openssl s_client, security), a local mock of Caddy's admin API, and a real node.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import pkg from "../package.json";
import {
  type CommandCall,
  cli,
  MISSING,
  makeEmptyRepo,
  makeIo,
  makeRepo,
  runAndRecordScenario,
  scriptedRunner,
} from "./helpers";
import {
  HOST,
  type Machine,
  mockAdmin,
  nodeRoute,
  pki,
  setUpMachine,
  snapshot,
  useMachine,
  useNodeWith,
} from "./machine";
import { register, startTestNode, useNodes } from "./node-helpers";
import { freePort } from "./two-macs";

useMachine();
useNodes();

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

// lsof: the `-F pc` lines lsof prints for the program holding a port.
type Answers = { served?: string; trusted?: boolean; lsof?: string };

function runner(a: Answers = {}) {
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "openssl" && c.args[0] === "s_client") return { stdout: a.served ?? pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    if (/(?:^|\/)tailscale$/i.test(c.cmd)) return MISSING;
    if (c.cmd === "lsof" && a.lsof !== undefined) return { stdout: a.lsof };
    return { status: 1 };
  });
}

type NodeProjects = Parameters<typeof useNodeWith>[0];

// node: the projects the node knows; by default the repo's web, registered from its folder as `bun dev` does. false: no node answers.
async function doctor(
  m: Machine,
  opts: { cwd?: string; answers?: Answers; node?: NodeProjects | false } = {},
): Promise<{ status: number; stdout: string; stderr: string; calls: CommandCall[] }> {
  const cwd = opts.cwd ?? makeRepo();
  if (opts.node !== false) {
    await useNodeWith(opts.node ?? { web: { folder: join(cwd, "apps", "web") } });
  }
  const { runCommand, calls } = runner(opts.answers);
  const r = await cli(["doctor"], { cwd, caddyfile: m.caddyfile, runCommand });
  return { ...r, calls };
}

// --- every check green ---

test("a set-up Mac: every check is green, exit 0, nothing written, no sudo", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine();
  const before = snapshot(m.dir);
  const r = await doctor(m);
  expect(r.stdout).toContain(`Caddy: Homebrew at ${m.prefix}`);
  expect(r.stdout).toContain(`Caddy config: ${m.caddyfile} (Homebrew's default)`);
  expect(r.stdout).toContain(`devsite's Caddy config: ${join(m.dir, "devsite.d")}`);
  expect(r.stdout).toContain(`Caddy log: ${join(m.prefix, "var", "log", "caddy.log")}`);
  expect(r.stdout).toContain("Service manager: none, Caddy does not run");
  expect(r.stdout).toContain("Runs as: you (devsite's default)");
  expect(r.stdout).toContain(
    `Caddy storage: ${join(m.dir, "storage")} (the Caddyfile's storage line)`,
  );
  expect(r.stdout).toContain("Projects unused for 30+ days: none");
  expect(r.stdout).toContain(`Node log: ${join(m.home, "Library", "Logs", "devsite", "node.log")}`);
  expect(r.stdout).toContain(
    `devsite's settings: ${join(m.home, "Library", "Application Support", "devsite", "config.json")}`,
  );
  expect(r.stdout).toContain("✓ the node answers on 127.0.0.1:47380");
  expect(r.stdout).toContain(`✓ the node runs devsite ${pkg.version} or newer`);
  expect(r.stdout).toContain("✓ no project runs a devsite newer than the node");
  expect(r.stdout).toContain(`✓ Caddy is installed — Homebrew at ${m.prefix}`);
  expect(r.stdout).toContain("✓ Caddy's admin API answers");
  expect(r.stdout).toContain("✓ Caddy has devsite's route for *.internal and *.localhost");
  expect(r.stdout).toContain("✓ devsite's route starts with the LAN guard");
  expect(r.stdout).toContain("✓ no route before devsite's takes its names");
  expect(r.stdout).toContain("✓ the served certificate chains to the CA in Caddy's storage");
  expect(r.stdout).toContain("✓ that CA is trusted in the keychain");
  expect(r.stdout).toContain(
    "✓ every devSite name of this repo is valid and used by one project only",
  );
  expect(r.stdout).toContain("✓ web is used by this repo only");
  expect(r.stdout).toContain("Every check is green.");
  expect(r.stdout).not.toContain("✗");
  expect(r.status).toBe(0);
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.calls.map((c) => c.cmd)).toEqual([
    "ps",
    "tailscale",
    TAILSCALE_APP,
    "openssl",
    "security",
  ]);
  // The certificate check connects to this Mac with the host as SNI, so it needs no DNS.
  expect(r.calls[3]?.args).toEqual([
    "s_client",
    "-connect",
    "127.0.0.1:443",
    "-servername",
    HOST,
    "-showcerts",
  ]);
  expect(r.calls[4]?.args).toEqual([
    "verify-cert",
    "-c",
    join(m.dir, "storage", "pki", "authorities", "local", "root.crt"),
    "-p",
    "ssl",
  ]);
});

test("a Caddyfile with no storage line and Caddy stopped: the Setup section names the data dir brew services gives Caddy", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine();
  writeFileSync(m.caddyfile, "import devsite.d/*.caddy # devsite\n");
  const r = await doctor(m);
  expect(r.stdout).toContain(
    `Caddy storage: ${join(m.prefix, "var", "lib", "caddy")} (the data dir \`brew services\` gives Caddy)`,
  );
});

// --- the Caddy checks, red ---

test("the admin API does not answer: red with its fix, and the route checks are skipped", async () => {
  // The suites' default admin address (tests/setup.ts) has no listener.
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("✗ Caddy's admin API answers — no answer");
  expect(r.stdout).toContain("fix: run `bunx devsite init`");
  expect(r.stdout).toContain("– devsite's route — it needs the admin API");
  expect(r.stdout).toContain("1 check red.");
  expect(r.status).toBe(1);
});

test("no route names *.internal: red", async () => {
  await mockAdmin([]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(
    "✗ Caddy has devsite's route for *.internal and *.localhost — no route names *.internal and *.localhost",
  );
  expect(r.status).toBe(1);
});

test("a route without the LAN guard: red", async () => {
  await mockAdmin([
    {
      match: [{ host: ["*.internal", "*.localhost"] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:47380" }] }],
      terminal: true,
    },
  ]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(
    "✗ devsite's route starts with the LAN guard — the guard is missing, so the LAN reaches the dev servers",
  );
  expect(r.status).toBe(1);
});

test("a route before devsite's that takes every .localhost name: red, naming that route", async () => {
  await mockAdmin([
    { match: [{ host: ["*.localhost"] }], handle: [], terminal: true },
    nodeRoute(),
  ]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(
    "✗ no route before devsite's takes its names — route 0 of server srv0 (*.localhost) comes first",
  );
  expect(r.stdout).toContain("fix: delete that route from Caddy's config");
  expect(r.status).toBe(1);
});

test("routes before devsite's for names of the user's own: green", async () => {
  await mockAdmin([
    { match: [{ host: ["muxa.internal", "*.api.internal"] }], handle: [], terminal: true },
    nodeRoute(),
  ]);
  const r = await doctor(setUpMachine());
  // `*.api.internal` stands for two labels, so it takes no devsite name.
  expect(r.stdout).toContain("✓ no route before devsite's takes its names");
  expect(r.status).toBe(0);
});

test("a route with no host matcher before the devsite host matches every host: red", async () => {
  await mockAdmin([{ handle: [], terminal: true }, nodeRoute()]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("route 0 of server srv0 (every host) comes first");
  expect(r.status).toBe(1);
});

test("the served certificate comes from another CA: red", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctor(setUpMachine({ root: pki.otherRoot }));
  expect(r.stdout).toContain(
    `✗ the served certificate chains to the CA in Caddy's storage — ${HOST} is served a certificate from another CA`,
  );
  expect(r.status).toBe(1);
});

test("no certificate is served: red", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctor(setUpMachine(), { answers: { served: "" } });
  expect(r.stdout).toContain(`no certificate served for ${HOST} on 127.0.0.1:443`);
  expect(r.status).toBe(1);
});

test("no CA in Caddy's storage: red, and the trust check is skipped", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctor(setUpMachine({ root: null }));
  expect(r.stdout).toContain(
    "✗ the served certificate chains to the CA in Caddy's storage — no CA at",
  );
  expect(r.stdout).toContain("– that CA is trusted in the keychain — no CA to check");
  expect(r.calls.map((c) => c.cmd)).toEqual(["ps", "tailscale", TAILSCALE_APP]);
  expect(r.status).toBe(1);
});

test("the CA is not trusted in the keychain: red", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctor(setUpMachine(), { answers: { trusted: false } });
  expect(r.stdout).toContain("✗ that CA is trusted in the keychain");
  expect(r.status).toBe(1);
});

// --- the checks of this repo ---

test("a project in another repo uses the same name: red, naming its folder", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctor(setUpMachine(), { node: { web: { folder: "/Users/me/Projects/shop" } } });
  expect(r.stdout).toContain(
    "✗ web is used by this repo only — the project in /Users/me/Projects/shop uses it too",
  );
  expect(r.stdout).toContain("fix: pick another devSite.name for web");
  expect(r.status).toBe(1);
});

test("a devSite name that is not one DNS label: red", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctor(setUpMachine(), { cwd: makeRepo("web.test") });
  expect(r.stdout).toContain(
    "✗ every devSite name of this repo is valid and used by one project only",
  );
  expect(r.stdout).toContain("is not one DNS label");
  expect(r.status).toBe(1);
});

test("two projects of this repo declare one name: red", async () => {
  await mockAdmin([nodeRoute()]);
  const repo = makeRepo();
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { name: "Web" } }),
  );
  const r = await doctor(setUpMachine(), { cwd: repo });
  expect(r.stdout).toContain('devSite.name "web" is declared by both');
  expect(r.status).toBe(1);
});

test("outside a repo: the machine checks run and the repo checks are skipped", async () => {
  await mockAdmin([nodeRoute()]);
  const cwd = makeEmptyRepo();
  const r = await doctor(setUpMachine(), { cwd, node: { web: {} } });
  expect(r.stdout).toContain("✓ Caddy's admin API answers");
  expect(r.stdout).toContain(`Skipped the checks of this repo: no package.json#devSite in ${cwd}.`);
  expect(r.status).toBe(0);
});

test("doctor as root refuses, with init's reason", async () => {
  const { runCommand, calls } = runner();
  const io = makeIo({ runCommand });
  io.ctx.env.DEVSITE_UID = "0";
  expect(await runAndRecordScenario(["doctor"], io.ctx)).toBe(1);
  expect(io.stderr.text()).toContain("devsite doctor is running as root.");
  expect(io.stderr.text()).toContain("bunx devsite doctor");
  expect(calls).toEqual([]);
});

// --- review follow-ups: Caddy's own matching rules, guards built another way, storage forms ---

test("a wildcard in the first label matches, as Caddy's host matcher does: red", async () => {
  await mockAdmin([{ match: [{ host: ["*.internal"] }], handle: [], terminal: true }, nodeRoute()]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("route 0 of server srv0 (*.internal) comes first");
  expect(r.status).toBe(1);
});

// devsite's route with its guard letting in only `ranges`.
function routeAllowing(ranges: string[]) {
  return {
    match: [{ host: ["*.internal", "*.localhost"] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [{ not: [{ remote_ip: { ranges } }] }],
            handle: [{ handler: "static_response", abort: true }],
          },
          { handle: [{ handler: "static_response", status_code: 503 }] },
        ],
      },
    ],
    terminal: true,
  };
}

test("a guard that allows fewer sources still keeps the LAN out: green", async () => {
  await mockAdmin([routeAllowing(["127.0.0.1"])]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("✓ devsite's route starts with the LAN guard");
});

test("a guard that lets the LAN in: red", async () => {
  await mockAdmin([routeAllowing(["127.0.0.1", "192.168.0.0/16"])]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("✗ devsite's route starts with the LAN guard");
  expect(r.status).toBe(1);
});

test("a one-line `storage file_system <path>`: the CA checks read that storage", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine();
  const storage = join(m.dir, "storage");
  writeFileSync(m.caddyfile, `{\n\tstorage file_system ${storage}\n}\n`);
  const r = await doctor(m);
  expect(r.stdout).toContain(`Caddy storage: ${storage} (the Caddyfile's storage line)`);
  expect(r.stdout).toContain("✓ the served certificate chains to the CA in Caddy's storage");
  expect(r.status).toBe(0);
});

test("a storage kind other than file_system: the CA checks read the CA from GET /pki/ca/local", async () => {
  await mockAdmin([nodeRoute()], { caRoot: pki.root });
  const m = setUpMachine();
  writeFileSync(m.caddyfile, "{\n\tstorage redis {\n\t\thost 127.0.0.1\n\t}\n}\n");
  const r = await doctor(m);
  expect(r.stdout).toContain(
    "Caddy storage: not read by devsite (the Caddyfile's storage line, storage redis)",
  );
  expect(r.stdout).toContain("✓ the served certificate chains to the CA in Caddy's storage");
  expect(r.stdout).toContain("✓ that CA is trusted in the keychain");
  expect(r.status).toBe(0);
});

test("a storage devsite cannot read and no CA from the admin API: the CA checks are skipped, not red", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine();
  writeFileSync(m.caddyfile, "{\n\tstorage redis {\n\t\thost 127.0.0.1\n\t}\n}\n");
  const r = await doctor(m);
  expect(r.stdout).toContain(
    "– the served certificate chains to the CA in Caddy's storage — devsite cannot read the Caddyfile's storage line, storage redis, and Caddy's admin API gives no CA",
  );
  expect(r.calls.map((c) => c.cmd)).toEqual(["ps", "tailscale", TAILSCALE_APP]);
  expect(r.status).toBe(0);
});

// --- the node ---

test("no node: the node check is red first, with init and the node's log as the fix", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine();
  const r = await doctor(m, { node: false });
  const nodeAt = r.stdout.indexOf("✗ the node answers on 127.0.0.1:47380 — no answer");
  expect(nodeAt).toBeGreaterThan(-1);
  expect(nodeAt).toBeLessThan(r.stdout.indexOf("Setup"));
  expect(r.stdout).toContain(
    `fix: run \`bunx devsite init\`; the node's log is ${join(m.home, "Library", "Logs", "devsite", "node.log")}`,
  );
  expect(r.stdout).toContain(
    "– the served certificate chains to the CA in Caddy's storage — the node does not answer",
  );
  expect(r.status).toBe(1);
});

test("a project whose devsite is newer than the node: red, with init in that project's folder", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctor(setUpMachine(), {
    node: { shop: { folder: "/Users/me/Projects/shop", devsiteVersion: "99.0.0" } },
  });
  expect(r.stdout).toContain("✗ no project runs a devsite newer than the node — shop runs 99.0.0");
  expect(r.stdout).toContain("fix: run `bunx devsite init` in /Users/me/Projects/shop");
  expect(r.status).toBe(1);
});

test("the node's projects unused for 30+ days are listed in the Setup section", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine();
  const state = join(m.home, "Library", "Application Support", "devsite");
  mkdirSync(state, { recursive: true });
  const project = (lastUsed: string) => ({
    project: "x",
    port: 1,
    folder: "/x",
    mac: "mac",
    live: false,
    lastUsed,
    devsiteVersion: "",
  });
  writeFileSync(
    join(state, "state.json"),
    JSON.stringify({
      projects: {
        old: project("2020-01-01"),
        fresh: project(new Date().toISOString().slice(0, 10)),
      },
    }),
  );
  const r = await doctor(m, { cwd: makeEmptyRepo(), node: {} });
  expect(r.stdout).toContain("Projects unused for 30+ days: old (last used 2020-01-01)");
});

// --- the other Macs' nodes ---

// This Mac's node on a fake tailnet with one other Mac, Mac mini at ::1. On the shared peer port there, a node answers with protocol `theirs`, or `answer` replies for another program.
async function doctorWithOtherMac(
  m: Machine,
  theirs: number | ((res: import("node:http").ServerResponse) => void),
) {
  const otherMac = createServer();
  await new Promise<void>((r) => otherMac.listen(0, "::1", r));
  const peerPort = (otherMac.address() as AddressInfo).port;
  otherMac.removeAllListeners("request");
  otherMac.on("request", (_req, res) => {
    if (typeof theirs === "function") return theirs(res);
    res.writeHead(theirs === 1 ? 200 : 400, { "devsite-protocol": String(theirs) });
    res.end("{}");
  });
  const cwd = makeRepo();
  const node = await startTestNode(undefined, {
    peerPort,
    tailnet: {
      status: {
        BackendState: "Running",
        Self: { HostName: "MacBook Pro", OS: "macOS", UserID: 1, TailscaleIPs: ["127.0.0.1"] },
        Peer: {
          a: { HostName: "Mac mini", OS: "macOS", UserID: 1, TailscaleIPs: ["::1"], Online: true },
        },
      },
    },
  });
  await register(node, "web", { port: 1, folder: join(cwd, "apps", "web") });
  process.env.DEVSITE_NODE = node.url;
  const r = await doctor(m, { cwd, node: false });
  await new Promise((done) => otherMac.close(done));
  return r;
}

test("a Mac whose node runs an older protocol is red, with update devsite on that Mac", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctorWithOtherMac(setUpMachine(), 0);
  expect(r.stdout).toContain(
    "✗ the node on Mac mini speaks this node's protocol — it speaks protocol 0, this node 1",
  );
  expect(r.stdout).toContain("fix: update devsite on Mac mini");
  expect(r.status).toBe(1);
});

test("a Mac whose node runs a newer protocol is red, with update devsite on this Mac", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctorWithOtherMac(setUpMachine(), 2);
  expect(r.stdout).toContain(
    "✗ the node on Mac mini speaks this node's protocol — it speaks protocol 2, this node 1",
  );
  expect(r.stdout).toContain("fix: update devsite on this Mac: run `bunx devsite init`");
});

test("a Mac whose node speaks this node's protocol is green", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctorWithOtherMac(setUpMachine(), 1);
  expect(r.stdout).toContain("Other Macs");
  expect(r.stdout).toContain("✓ the node on Mac mini speaks this node's protocol");
  expect(r.status).toBe(0);
});

test("a Mac where another program holds the peer port is red, with the doctor run there", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctorWithOtherMac(setUpMachine(), (res) => res.end("hello"));
  expect(r.stdout).toMatch(
    /✗ the node on Mac mini answers on port \d+ — another program answers there/,
  );
  expect(r.stdout).toContain("fix: run `bunx devsite doctor` on Mac mini: it names the program");
});

test("a Mac whose node refuses this Mac's calls is red, with one Tailscale user as the fix", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctorWithOtherMac(setUpMachine(), (res) => {
    res.writeHead(403, { "devsite-protocol": "1" });
    res.end("{}");
  });
  expect(r.stdout).toContain(
    "✗ the node on Mac mini accepts this Mac's calls — its Tailscale names another user for this Mac",
  );
  expect(r.stdout).toContain("fix: log in both Macs to one Tailscale user");
});

test("a peer port another program holds on this Mac is red, naming that program", async () => {
  await mockAdmin([nodeRoute()]);
  const holder = createServer();
  const peerPort = await freePort();
  await new Promise<void>((r) => holder.listen(peerPort, "::1", r));
  const cwd = makeRepo();
  const node = await startTestNode(undefined, {
    peerPort,
    tailnet: {
      status: {
        BackendState: "Running",
        Self: { HostName: "MacBook Pro", OS: "macOS", UserID: 1, TailscaleIPs: ["::1"] },
      },
    },
  });
  await register(node, "web", { port: 1, folder: join(cwd, "apps", "web") });
  process.env.DEVSITE_NODE = node.url;
  const r = await doctor(setUpMachine(), {
    cwd,
    node: false,
    answers: { lsof: "p4242\ncsyncthing\n" },
  });
  await new Promise((done) => holder.close(done));
  expect(r.stdout).toContain(
    `✗ the node listens for other Macs on [::1]:${peerPort} — syncthing (pid 4242) holds the port; the other Macs reach the node on [::1]:${peerPort + 1} meanwhile`,
  );
  expect(r.stdout).toContain("fix: stop syncthing; the node takes the port within 10 s");
  const lsof = r.calls.find((c) => c.cmd === "lsof");
  expect(lsof?.args).toEqual(["-nP", `-iTCP:${peerPort}`, "-sTCP:LISTEN", "-Fpc"]);
  expect(r.status).toBe(1);
});

test("a peer port this Mac's node holds is green", async () => {
  await mockAdmin([nodeRoute()]);
  const r = await doctorWithOtherMac(setUpMachine(), 1);
  expect(r.stdout).toMatch(/✓ the node listens for other Macs on 127\.0\.0\.1:\d+/);
});
