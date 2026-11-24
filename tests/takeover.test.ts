// The split DNS route and takeover (#110): two real nodes on loopback (tests/two-macs.ts), a local fake of Tailscale's OAuth token and split DNS API, and a shorter signal interval. This Mac (MacBook Pro, 127.0.0.1) sorts after the other Mac (Mac mini, ::1).
import { expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestNode, useNodes } from "./node-helpers";
import { serving } from "./serving";
import { fakeSplitDnsApi, type Route, SECRET } from "./split-dns-api";
import { freePort, ME, OTHER_MAC, statusJson, THIS_MAC, twoMacs } from "./two-macs";

useNodes();
// Each test waits through several signal intervals.
setDefaultTimeout(15_000);

const SIGNAL_MS = 400;

function keychain(secret: string | null) {
  const dir = mkdtempSync(join(tmpdir(), "devsite-keychain-"));
  if (secret !== null) writeFileSync(join(dir, "secret"), secret);
  return dir;
}

async function startMacs(
  route: Route,
  secrets: { here?: string | null; there?: string | null } = {},
  hereEnv: Record<string, string> = {},
  // What the other Mac can serve: everything, when left out.
  thereServes: Parameters<typeof serving>[1] = {},
) {
  const api = fakeSplitDnsApi(route);
  const env = (secret: string | null) => ({
    DEVSITE_TAILSCALE_API: api.url,
    DEVSITE_SIGNAL_MS: String(SIGNAL_MS),
    DEVSITE_FAKE_SECURITY: keychain(secret),
  });
  const macs = await twoMacs({
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
  await Bun.sleep(4 * SIGNAL_MS);
  expect(api.state.writes).toEqual([[THIS_MAC.ip]]);
  const status = (await (await fetch(`${there.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "follower", mac: THIS_MAC.name, ip: THIS_MAC.ip });
});

test("a Mac that starts reads the route first: the main Mac it names keeps it, though it sorts last", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(6 * SIGNAL_MS);
  expect(api.state.writes).toEqual([]);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "main", ip: THIS_MAC.ip });
});

test("a clean stop of the main Mac's node moves the route at once", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(3 * SIGNAL_MS);
  const stopped = Date.now();
  await here.stop();
  await until(routeIs(api, OTHER_MAC.ip), 5000);
  expect(Date.now() - stopped).toBeLessThan(2 * SIGNAL_MS);
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
});

test("a main Mac that stops answering moves the route after 3 missed signals, and leaves it there when it comes back", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(3 * SIGNAL_MS);
  const paused = Date.now();
  here.pause();
  await until(routeIs(api, OTHER_MAC.ip), 5000);
  // The last signal came up to one interval before the pause.
  expect(Date.now() - paused).toBeGreaterThanOrEqual(2 * SIGNAL_MS);
  here.resume();
  await Bun.sleep(6 * SIGNAL_MS);
  expect(api.state.route).toEqual([OTHER_MAC.ip]);
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "follower", mac: OTHER_MAC.name, ip: OTHER_MAC.ip });
});

test("the Mac that takes over reads the route again and writes nothing when another Mac already moved it", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip]);
  await Bun.sleep(3 * SIGNAL_MS);
  api.state.route = [OTHER_MAC.ip];
  await here.stop();
  await Bun.sleep(4 * SIGNAL_MS);
  expect(api.state.writes).toEqual([]);
});

test("a Mac with no secret in its Keychain never writes the route; the Mac that has one takes it over", async () => {
  const { api } = await startMacs(null, { there: null });
  await until(routeIs(api, THIS_MAC.ip), 5000);
  expect(api.state.writes).toEqual([[THIS_MAC.ip]]);
});

test("a main Mac that no node follows finds out that the route moved", async () => {
  const { api, here } = await startMacs([THIS_MAC.ip], { there: null });
  await Bun.sleep(3 * SIGNAL_MS);
  api.state.route = [OTHER_MAC.ip];
  await Bun.sleep(18 * SIGNAL_MS);
  expect((await routeOf(here)).role).toBe("follower");
});

test("a node reads a replaced secret at once when init asks it for the route", async () => {
  const dir = keychain(SECRET);
  const { here } = await startMacs([THIS_MAC.ip], {}, { DEVSITE_FAKE_SECURITY: dir });
  await Bun.sleep(3 * SIGNAL_MS);
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
      DEVSITE_SIGNAL_MS: String(SIGNAL_MS),
      DEVSITE_FAKE_SECURITY: keychain(SECRET),
      ...(await serving(OTHER_MAC.ip)),
    },
    tailnet: { status },
  });
  await Bun.sleep(4 * SIGNAL_MS);
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
  const api = fakeSplitDnsApi([THIS_MAC.ip]);
  const peerPort = await freePort();
  const here = await startTestNode(undefined, {
    peerPort,
    env: {
      DEVSITE_TAILSCALE_API: api.url,
      DEVSITE_SIGNAL_MS: "5000",
      DEVSITE_FAKE_SECURITY: keychain(SECRET),
      ...(await serving(THIS_MAC.ip)),
    },
    tailnet: {
      status: statusJson(THIS_MAC, [OTHER_MAC]),
      whois: { [THIS_MAC.ip]: { UserProfile: { ID: ME } } },
    },
  });
  const role = async () =>
    ((await (await fetch(`${here.url}/status`)).json()) as { route: { role: string } }).route.role;
  while ((await role()) !== "main") await Bun.sleep(20);
  const follower = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    get(
      { host: THIS_MAC.ip, port: peerPort, path: "/signals", headers: { "devsite-protocol": "1" } },
      resolve,
    ).on("error", reject);
  });
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
  const { api, here } = await startMacs([THIS_MAC.ip], {}, events.env);
  await Bun.sleep(3 * SIGNAL_MS);
  const slept = Date.now();
  events.send("sleep");
  await until(routeIs(api, OTHER_MAC.ip), 5000);
  expect(Date.now() - slept).toBeLessThan(2 * SIGNAL_MS);
  await until(events.released, 1000);
  events.send("wake");
  await Bun.sleep(3 * SIGNAL_MS);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "follower", mac: OTHER_MAC.name, ip: OTHER_MAC.ip });
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
});

test("a main Mac that sleeps with no Mac to take over is the main Mac again after its wake", async () => {
  const events = sleepEvents();
  const { api, here } = await startMacs([THIS_MAC.ip], { there: null }, events.env);
  await Bun.sleep(2 * SIGNAL_MS);
  events.send("sleep");
  await until(events.released, 2000);
  events.send("wake");
  await Bun.sleep(3 * SIGNAL_MS);
  const status = (await (await fetch(`${here.url}/status`)).json()) as { route: unknown };
  expect(status.route).toEqual({ role: "main", ip: THIS_MAC.ip });
  expect(api.state.writes).toEqual([]);
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
      DEVSITE_SIGNAL_MS: String(SIGNAL_MS),
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
    const { api, here, there } = await startMacs([THIS_MAC.ip], {}, {}, serves);
    await Bun.sleep(3 * SIGNAL_MS);
    const hello = async () =>
      ((await (await fetch(`${there.url}/status`)).json()) as { route: { role: string } }).route;
    expect((await hello()).role).toBe("follower");
    await here.stop();
    await Bun.sleep(6 * SIGNAL_MS);
    expect(api.state.writes).toEqual([]);
  });
}

test("with no route, a Mac that cannot serve .internal names leaves it, and a later Mac that can writes it", async () => {
  const { api } = await startMacs(null, {}, await serving(THIS_MAC.ip, { dns: null }));
  await Bun.sleep(4 * SIGNAL_MS);
  expect(api.state.writes).toEqual([[OTHER_MAC.ip]]);
});
