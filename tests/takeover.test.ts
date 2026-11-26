// The split DNS route and takeover (#110): two real nodes on loopback (tests/two-macs.ts), a local fake of Tailscale's OAuth token and split DNS API, and a shorter heartbeat interval. This Mac (MacBook Pro, 127.0.0.1) sorts after the other Mac (Mac mini, ::1).
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestNode, useNodes } from "./node-helpers";
import { serving } from "./serving";
import { fakeSplitDnsApi, type Route, SECRET } from "./split-dns-api";
import { freePort, holdPort, ME, OTHER_MAC, statusJson, THIS_MAC, twoMacs } from "./two-macs";

useNodes();
// Each test waits through several heartbeat intervals.
setDefaultTimeout(15_000);

const HEARTBEAT_MS = 400;

function keychain(secret: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "devsite-keychain-"));
  if (secret !== null) writeFileSync(join(dir, "secret"), secret);
  return dir;
}

async function startMacs(
  route: Route,
  secrets: { here?: string | null; there?: string | null } = {},
  // thereServes: what the other Mac can serve, everything when left out. peerPort: a port the test set up first.
  {
    hereEnv = {},
    thereServes = {},
    peerPort,
  }: {
    hereEnv?: Record<string, string>;
    thereServes?: Parameters<typeof serving>[1];
    peerPort?: number;
  } = {},
) {
  const api = fakeSplitDnsApi(route);
  const env = (secret: string | null) => ({
    DEVSITE_TAILSCALE_API: api.url,
    DEVSITE_HEARTBEAT_MS: String(HEARTBEAT_MS),
    DEVSITE_FAKE_SECURITY: keychain(secret),
  });
  const macs = await twoMacs({
    peerPort,
    hereEnv: {
      ...env(secrets.here === undefined ? SECRET : secrets.here),
      ...(await serving(THIS_MAC.ip)),
      ...hereEnv,
    },
    thereEnv: {
      ...env(secrets.there === undefined ? SECRET : secrets.there),
      ...(await serving(OTHER_MAC.ip, thereServes)),
    },
  });
  return { ...macs, api };
}

// The node's stand-in sleep listener reads its events from the folder; released: the node let the sleep go on.
function sleepEvents() {
  const dir = mkdtempSync(join(tmpdir(), "devsite-sleep-"));
  return {
    env: { DEVSITE_FAKE_SLEEP: dir },
    send: (event: "sleep" | "wake") => appendFileSync(join(dir, "events"), `${event}\n`),
    released: () => existsSync(join(dir, "released")),
  };
}

async function until(check: () => boolean, ms: number): Promise<number> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`not within ${ms} ms`);
    await Bun.sleep(20);
  }
  return Date.now() - start;
}

const routeOf = async (node: { url: string }) =>
  ((await (await fetch(`${node.url}/status`)).json()) as { route: { role: string } }).route;

const routeIs = (api: { state: { route: Route } }, ip: string) => () =>
  api.state.route?.join() === ip;

// twoMacs starts this Mac's node first, so at its first read no other node answers.
test("with no route, the main Mac's node writes its own IP, and the Mac that starts later follows it", async () => {
  const { api, there } = await startMacs(null);
  await until(routeIs(api, THIS_MAC.ip), 5000);
  await Bun.sleep(4 * HEARTBEAT_MS);
  expect(api.state.writes).toEqual([[THIS_MAC.ip]]);
  const status = (await (await fetch(`${there.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "follower", mac: THIS_MAC.name, ip: THIS_MAC.ip });
});

test("a Mac that starts reads the route first: the main Mac it names keeps it, though it sorts last", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(6 * HEARTBEAT_MS);
  expect(api.state.writes).toEqual([]);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "main", ip: THIS_MAC.ip });
});

test("a clean stop of the main Mac's node moves the route at once", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(3 * HEARTBEAT_MS);
  const stopped = Date.now();
  await here.stop();
  await until(routeIs(api, OTHER_MAC.ip), 5000);
  expect(Date.now() - stopped).toBeLessThan(2 * HEARTBEAT_MS);
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
});

test("a main Mac that stops answering moves the route after 3 missed heartbeats, and leaves it there when it comes back", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(3 * HEARTBEAT_MS);
  const paused = Date.now();
  here.pause();
  await until(routeIs(api, OTHER_MAC.ip), 5000);
  // The last heartbeat came up to one interval before the pause.
  expect(Date.now() - paused).toBeGreaterThanOrEqual(2 * HEARTBEAT_MS);
  here.resume();
  await Bun.sleep(6 * HEARTBEAT_MS);
  expect(api.state.route).toEqual([OTHER_MAC.ip]);
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "follower", mac: OTHER_MAC.name, ip: OTHER_MAC.ip });
});

test("the Mac that takes over reads the route again and writes nothing when another Mac already moved it", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(3 * HEARTBEAT_MS);
  api.state.route = [OTHER_MAC.ip];
  await here.stop();
  await Bun.sleep(4 * HEARTBEAT_MS);
  expect(api.state.writes).toEqual([]);
});

test("a main Mac whose peer port another program holds sends its heartbeats from its fallback port, and moves back to the peer port, so the route stays", async () => {
  const peerPort = await freePort();
  const release = await holdPort(peerPort, THIS_MAC.ip);
  const { api, here, there } = await startMacs([THIS_MAC.ip], {}, { peerPort });
  await Bun.sleep(8 * HEARTBEAT_MS);
  expect(api.state.writes).toEqual([]);
  await release();
  await Bun.sleep(8 * HEARTBEAT_MS);
  const listeners = (
    (await (await fetch(`${here.url}/status`)).json()) as { tailnetListeners: unknown }
  ).tailnetListeners;
  expect(listeners).toEqual([{ address: `${THIS_MAC.ip}:${peerPort}` }]);
  expect(api.state.writes).toEqual([]);
  expect((await routeOf(there)) as unknown).toEqual({
    role: "follower",
    mac: THIS_MAC.name,
    ip: THIS_MAC.ip,
  });
});

test("a Mac with no secret in its Keychain never writes the route; the Mac that has one takes it over", async () => {
  const { api } = await startMacs(null, { there: null });
  await until(routeIs(api, THIS_MAC.ip), 5000);
  expect(api.state.writes).toEqual([[THIS_MAC.ip]]);
});

test("a main Mac that no node follows finds out that the route moved", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip], { there: null });
  await Bun.sleep(3 * HEARTBEAT_MS);
  api.state.route = [OTHER_MAC.ip];
  await Bun.sleep(18 * HEARTBEAT_MS);
  expect((await routeOf(here)).role).toBe("follower");
});

test("a node reads a replaced secret at once when init asks it for the route", async () => {
  const dir = keychain(SECRET);
  const { here } = await startMacs([THIS_MAC.ip], {}, { hereEnv: { DEVSITE_FAKE_SECURITY: dir } });
  await Bun.sleep(3 * HEARTBEAT_MS);
  expect((await routeOf(here)).role).toBe("main");
  writeFileSync(join(dir, "secret"), "tskey-client-k999CNTRL-wrong");
  const res = await fetch(`${here.url}/route`, { method: "POST" });
  expect(await res.json()).toEqual({ role: "unknown", why: "Tailscale's API gave no answer" });
});

test("a Mac whose secret Tailscale refuses does not hold up the takeover of another", async () => {
  // The other Mac sorts first; its secret is refused.
  const { api } = await startMacs(null, { there: "tskey-client-k999CNTRL-wrong" });
  await until(routeIs(api, THIS_MAC.ip), 5000);
  api.state.route = ["100.90.9.9"];
  await until(routeIs(api, THIS_MAC.ip), 14_000);
});

// Two loopback addresses allow one real node and one more voter, so the other voter is a server that answers as a node holding a secret does.
async function nodeBesideVoter(voter: { name: string; online: boolean }) {
  const api = fakeSplitDnsApi(null);
  const peerPort = await freePort();
  const other = createServer((_req, res) => {
    res.writeHead(200, { "devsite-protocol": "1", "content-type": "application/json" });
    res.end(JSON.stringify({ routeWriter: true }));
  });
  await new Promise<void>((r) => other.listen(peerPort, THIS_MAC.ip, r));
  const status = statusJson(OTHER_MAC, [{ ip: THIS_MAC.ip, name: voter.name }]);
  for (const p of Object.values(status.Peer)) p.Online = voter.online;
  await startTestNode(undefined, {
    peerPort,
    env: {
      DEVSITE_TAILSCALE_API: api.url,
      DEVSITE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      DEVSITE_FAKE_SECURITY: keychain(SECRET),
      ...(await serving(OTHER_MAC.ip)),
    },
    tailnet: { status },
  });
  await Bun.sleep(4 * HEARTBEAT_MS);
  other.closeAllConnections();
  other.close();
  return api.state.writes;
}

test("of the nodes that answer, only the Mac whose device name sorts first writes", async () => {
  expect(await nodeBesideVoter({ name: "Alpha Mac", online: true })).toEqual([]);
  expect(await nodeBesideVoter({ name: "Zulu Mac", online: true })).toEqual([[OTHER_MAC.ip]]);
});

test("of two Macs with one device name, one writes", async () => {
  expect(await nodeBesideVoter({ name: OTHER_MAC.name, online: true })).toEqual([[OTHER_MAC.ip]]);
});

test("a Mac that Tailscale marks offline still votes when its node answers", async () => {
  expect(await nodeBesideVoter({ name: "Alpha Mac", online: false })).toEqual([]);
});

test("a main Mac that loses a follower reads the route again, and once more after Tailscale's API gave no answer", async () => {
  const { api, here, ask } = await mainAlone({ DEVSITE_HEARTBEAT_MS: "5000" });
  const role = async () => (await routeOf(here)).role;
  const follower = await ask("/heartbeats");
  expect(follower.statusCode).toBe(200);
  api.state.route = [OTHER_MAC.ip];
  api.state.down = true;
  follower.destroy();
  await Bun.sleep(600);
  expect(await role()).toBe("main");
  api.state.down = false;
  await Bun.sleep(1000);
  expect(await role()).toBe("follower");
  expect(api.state.writes).toEqual([]);
});

test("a sleep of the main Mac moves the route at once, and after its wake the Mac follows the new main Mac", async () => {
  const events = sleepEvents();
  const { api, here } = await startMacs([THIS_MAC.ip], {}, { hereEnv: events.env });
  await Bun.sleep(3 * HEARTBEAT_MS);
  const slept = Date.now();
  events.send("sleep");
  await until(routeIs(api, OTHER_MAC.ip), 5000);
  expect(Date.now() - slept).toBeLessThan(2 * HEARTBEAT_MS);
  await until(events.released, 1000);
  events.send("wake");
  await Bun.sleep(3 * HEARTBEAT_MS);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "follower", mac: OTHER_MAC.name, ip: OTHER_MAC.ip });
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
});

test("a main Mac that sleeps with no Mac to take over is the main Mac again after its wake", async () => {
  const events = sleepEvents();
  const { api, here } = await startMacs([THIS_MAC.ip], { there: null }, { hereEnv: events.env });
  await Bun.sleep(2 * HEARTBEAT_MS);
  events.send("sleep");
  await until(events.released, 2000);
  events.send("wake");
  await Bun.sleep(3 * HEARTBEAT_MS);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "main", ip: THIS_MAC.ip });
  expect(api.state.writes).toEqual([]);
});

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

// A stand-in for the main Mac's node, whose open connection the test cuts, and a real node that follows it, with env added to its own.
async function nodeBesideMain(env: Record<string, string> = {}) {
  const api = fakeSplitDnsApi([THIS_MAC.ip]);
  const peerPort = await freePort();
  const open = new Set<ServerResponse>();
  let opened = 0;
  let closedAt = 0;
  const answer = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(200, { "devsite-protocol": "1" });
    res.write("heartbeat\n");
    opened += 1;
    open.add(res);
    res.on("close", () => {
      open.delete(res);
      closedAt = Date.now();
    });
  };
  const listen = async () => {
    const s = createServer(answer);
    await new Promise<void>((r) => s.listen(peerPort, THIS_MAC.ip, r));
    return s;
  };
  let main = await listen();
  const heartbeats = setInterval(() => {
    for (const res of open) res.write("heartbeat\n");
  }, HEARTBEAT_MS);
  const cut = () => {
    main.closeAllConnections();
    main.close();
  };
  stops.push(() => {
    clearInterval(heartbeats);
    cut();
  });
  const node = await startTestNode(undefined, {
    peerPort,
    env: {
      DEVSITE_TAILSCALE_API: api.url,
      DEVSITE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      DEVSITE_FAKE_SECURITY: keychain(SECRET),
      ...(await serving(OTHER_MAC.ip)),
      ...env,
    },
    tailnet: { status: statusJson(OTHER_MAC, [THIS_MAC]) },
  });
  await until(() => opened === 1, 5000);
  return {
    api,
    node,
    cut,
    // The newest heartbeat, sent as a whole before the test goes on.
    heartbeat: async () => {
      const at = Date.now();
      for (const res of open) res.write("heartbeat\n");
      await Bun.sleep(50);
      return at;
    },
    going: () => {
      for (const res of open) res.end("going\n");
    },
    opened: () => opened,
    // When a connection for heartbeats last closed.
    closedAt: () => closedAt,
    back: async () => {
      main = await listen();
    },
  };
}

test("a cut connection to the main Mac moves the route after 3 missed heartbeats", async () => {
  const m = await nodeBesideMain();
  const lastHeartbeat = await m.heartbeat();
  m.cut();
  await until(routeIs(m.api, OTHER_MAC.ip), 5000);
  expect(Date.now() - lastHeartbeat).toBeGreaterThanOrEqual(3 * HEARTBEAT_MS);
  // The node counts once each interval, then asks for votes and writes.
  expect(Date.now() - lastHeartbeat).toBeLessThan(6 * HEARTBEAT_MS);
  expect(m.api.state.writes).toEqual([[OTHER_MAC.ip]]);
});

test("a connection to the main Mac that is cut and comes back at once moves nothing", async () => {
  const m = await nodeBesideMain();
  m.cut();
  await m.back();
  await until(() => m.opened() === 2, 3 * HEARTBEAT_MS);
  await Bun.sleep(5 * HEARTBEAT_MS);
  expect(m.api.state.writes).toEqual([]);
});

test("a node whose old main Mac still sends heartbeats finds out that the route moved, and takes over when the new main Mac is gone", async () => {
  const m = await nodeBesideMain();
  // A third machine took the route over, and no node answers there.
  m.api.state.route = ["100.90.9.9"];
  await until(routeIs(m.api, OTHER_MAC.ip), 14_000);
  expect(m.api.state.writes).toEqual([[OTHER_MAC.ip]]);
});

test("a main Mac that goes while this node reads the route moves it at once", async () => {
  const m = await nodeBesideMain();
  m.api.state.delayMs = 300;
  const read = fetch(`${m.node.url}/route`, { method: "POST" });
  await Bun.sleep(100);
  m.going();
  const went = Date.now();
  m.cut();
  await until(routeIs(m.api, OTHER_MAC.ip), 5000);
  // The read that runs, the read before the write, and the write.
  expect(Date.now() - went).toBeLessThan(3 * 300 + HEARTBEAT_MS);
  await read;
});

test("a Mac that goes to sleep while it takes over writes no route", async () => {
  const events = sleepEvents();
  const m = await nodeBesideMain(events.env);
  m.api.state.delayMs = 1000;
  const reads = m.api.state.reads;
  m.going();
  m.cut();
  // The vote reads the route again before it writes; the sleep comes during that read.
  await Bun.sleep(200);
  events.send("sleep");
  await until(events.released, 2000);
  await Bun.sleep(4 * HEARTBEAT_MS);
  expect(m.api.state.reads).toBeGreaterThan(reads);
  expect(m.api.state.writes).toEqual([]);
  expect((await routeOf(m.node)).role).toBe("unknown");
});

test("a Mac that goes to sleep closes its connection for heartbeats to the main Mac before it lets the sleep go on", async () => {
  const events = sleepEvents();
  const m = await nodeBesideMain(events.env);
  events.send("sleep");
  await until(events.released, 2000);
  const released = statSync(join(events.env.DEVSITE_FAKE_SLEEP, "released")).mtimeMs;
  expect(m.closedAt()).toBeGreaterThan(0);
  expect(m.closedAt()).toBeLessThanOrEqual(released);
});

// The main Mac's node alone, and what it answers another node.
async function mainAlone(env: Record<string, string>) {
  const api = fakeSplitDnsApi([THIS_MAC.ip]);
  const peerPort = await freePort();
  const here = await startTestNode(undefined, {
    peerPort,
    env: {
      DEVSITE_TAILSCALE_API: api.url,
      DEVSITE_FAKE_SECURITY: keychain(SECRET),
      ...(await serving(THIS_MAC.ip)),
      ...env,
    },
    tailnet: {
      status: statusJson(THIS_MAC, [OTHER_MAC]),
      whois: { [THIS_MAC.ip]: { UserProfile: { ID: ME } } },
    },
  });
  while ((await routeOf(here)).role !== "main") await Bun.sleep(20);
  const ask = (path: string) =>
    new Promise<IncomingMessage>((resolve, reject) => {
      get(
        { host: THIS_MAC.ip, port: peerPort, path, headers: { "devsite-protocol": "1" } },
        resolve,
      ).on("error", reject);
    });
  return { api, here, ask };
}

test("a main Mac that stalls for less than 3 heartbeats sends the next one at once", async () => {
  const heartbeatMs = 1000;
  const { here, ask } = await mainAlone({ DEVSITE_HEARTBEAT_MS: String(heartbeatMs) });
  const heartbeats = await ask("/heartbeats");
  let at = 0;
  let count = 0;
  heartbeats.on("data", () => {
    at = Date.now();
    count += 1;
  });
  await until(() => count >= 2, 5000);
  const before = at;
  const seen = count;
  here.pause();
  await Bun.sleep(2.5 * heartbeatMs);
  here.resume();
  await until(() => count > seen, 5000);
  expect(at - before).toBeLessThan(3 * heartbeatMs);
  heartbeats.destroy();
});

test("a Mac that goes to sleep does not vote for itself", async () => {
  const events = sleepEvents();
  const { ask } = await mainAlone(events.env);
  const votes = async () => {
    let body = "";
    for await (const chunk of await ask("/hello")) body += chunk;
    return (JSON.parse(body) as { routeWriter: boolean }).routeWriter;
  };
  expect(await votes()).toBe(true);
  events.send("sleep");
  await until(events.released, 2000);
  expect(await votes()).toBe(false);
  events.send("wake");
  await Bun.sleep(500);
  expect(await votes()).toBe(true);
});

test("a program on the main Mac's port that is no node does not count as a main Mac that answers", async () => {
  const api = fakeSplitDnsApi([THIS_MAC.ip]);
  const peerPort = await freePort();
  const other = createServer((_req, res) => res.end("hello"));
  await new Promise<void>((r) => other.listen(peerPort, THIS_MAC.ip, r));
  await startTestNode(undefined, {
    peerPort,
    env: {
      DEVSITE_TAILSCALE_API: api.url,
      DEVSITE_HEARTBEAT_MS: String(HEARTBEAT_MS),
      DEVSITE_FAKE_SECURITY: keychain(SECRET),
      ...(await serving(OTHER_MAC.ip)),
    },
    tailnet: { status: statusJson(OTHER_MAC, [THIS_MAC]) },
  });
  await until(routeIs(api, OTHER_MAC.ip), 5000).finally(() => {
    other.closeAllConnections();
    other.close();
  });
});

// The Mac that would take over, with one part of its setup missing.
for (const [title, serves] of [
  ["whose dnsmasq gives no answer", { dns: null }],
  ["whose DNS answers another address", { dns: "100.90.9.9" }],
  ["whose Caddy accepts no connection", { caddy: false }],
] as const) {
  test(`a Mac ${title} does not take over, so the route stays`, async () => {
    const { api, here, there } = await startMacs([THIS_MAC.ip], {}, { thereServes: serves });
    await Bun.sleep(3 * HEARTBEAT_MS);
    expect((await routeOf(there)).role).toBe("follower");
    await here.stop();
    await Bun.sleep(6 * HEARTBEAT_MS);
    expect(api.state.writes).toEqual([]);
  });
}

test("with no route, a Mac that cannot serve .internal names leaves it, and a later Mac that can writes it", async () => {
  const { api } = await startMacs(null, {}, { hereEnv: await serving(THIS_MAC.ip, { dns: null }) });
  await Bun.sleep(4 * HEARTBEAT_MS);
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
});
