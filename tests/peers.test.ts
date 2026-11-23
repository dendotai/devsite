// Nodes on two Macs of one tailnet (#66), as two real nodes on loopback: this Mac's Tailscale IP is 127.0.0.1 and the other Mac's is ::1, both on one peer port, as every Mac uses one fixed port. The fake tailscale gives each node its own `status --json` and `whois --json` answers.
import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { register, startDevServer, startTestNode, status, useNodes } from "./node-helpers";

useNodes();

const ME = 1001;
const SOMEONE_ELSE = 2002;
const THIS_MAC = { ip: "127.0.0.1", name: "MacBook Pro" };
const OTHER_MAC = { ip: "::1", name: "Mac mini" };

type Device = { ip: string; name: string };

function statusJson(self: Device, peers: Array<Device & { os?: string; user?: number }>) {
  return {
    BackendState: "Running",
    Self: { HostName: self.name, OS: "macOS", UserID: ME, TailscaleIPs: [self.ip] },
    Peer: Object.fromEntries(
      peers.map((p, i) => [
        `nodekey:${i}`,
        {
          HostName: p.name,
          OS: p.os ?? "macOS",
          UserID: p.user ?? ME,
          TailscaleIPs: [p.ip],
          Online: true,
        },
      ]),
    ),
  };
}

const whois = (user: number) => ({ Node: { User: user }, UserProfile: { ID: user } });

// A port free on both loopback addresses, for the peer port every node shares.
async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

// This Mac's node and the other Mac's node, each of user ME, each seeing the other as a peer. On loopback a call comes from the address it goes to, so each node's whois answer is keyed by its own address. otherSeesCaller: the user the other Mac's whois names for every caller.
async function twoMacs(opts: { otherSeesCaller?: number } = {}) {
  const peerPort = await freePort();
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: {
      status: statusJson(THIS_MAC, [OTHER_MAC]),
      whois: { [THIS_MAC.ip]: whois(ME) },
    },
  });
  const there = await startTestNode(undefined, {
    peerPort,
    tailnet: {
      status: statusJson(OTHER_MAC, [THIS_MAC]),
      whois: { [OTHER_MAC.ip]: whois(opts.otherSeesCaller ?? ME) },
    },
  });
  return { here, there, peerPort };
}

test("a start of a name live on another Mac is refused with that Mac and the project's folder there", async () => {
  const { here, there } = await twoMacs();
  const dev = await startDevServer();
  await register(there, "web", {
    port: dev.port,
    folder: join(there.home, "Projects", "acme-web"),
  });
  const res = await register(here, "web", { port: dev.port });
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "web.internal runs on Mac mini from ~/Projects/acme-web",
  });
  expect((await status(here)).projects.web).toBeUndefined();
});

test("a name the other Mac only shows the offline page for starts here", async () => {
  const { here, there } = await twoMacs();
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  await dev.close();
  expect((await register(here, "web", { port: 1 })).status).toBe(200);
});

test("a Mac that gives no answer does not block a start", async () => {
  const peerPort = await freePort();
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: { status: statusJson(THIS_MAC, [OTHER_MAC]) },
  });
  expect((await register(here, "web", { port: 1 })).status).toBe(200);
});

test("a node refuses a call from a device of another Tailscale user, so its live name does not block that start", async () => {
  const { here, there, peerPort } = await twoMacs({ otherSeesCaller: SOMEONE_ELSE });
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  expect((await register(here, "web", { port: 1 })).status).toBe(200);
  const direct = await fetch(`http://[::1]:${peerPort}/projects/web`, {
    headers: { "devsite-protocol": "1" },
  });
  expect(direct.status).toBe(403);
});

test("the node's address on the tailnet serves no dev server: other devices reach them through Caddy", async () => {
  const { there, peerPort } = await twoMacs();
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  const res = await fetch(`http://[::1]:${peerPort}/`, {
    headers: { host: "web.internal", "devsite-protocol": "1" },
  });
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("web /");
});

// The other Mac at ::1, with `serve` on the shared peer port (or nothing there), as this Mac's node lists it.
async function listedAs(serve?: (server: ReturnType<typeof createServer>) => void) {
  const peerPort = await freePort();
  const other = createServer();
  serve?.(other);
  if (serve !== undefined) await new Promise<void>((r) => other.listen(peerPort, "::1", r));
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: { status: statusJson(THIS_MAC, [OTHER_MAC]) },
  });
  const list = await (await fetch(`${here.url}/peers`)).json();
  other.closeAllConnections();
  other.close();
  return list;
}

test("a Mac whose node speaks another protocol is listed with that protocol", async () => {
  const list = await listedAs((s) =>
    s.on("request", (_req, res) => {
      res.writeHead(400, { "devsite-protocol": "2" });
      res.end();
    }),
  );
  expect(list).toEqual([{ mac: "Mac mini", state: "other-protocol", protocol: 2 }]);
});

test("a Mac with nothing on the peer port is listed as refused: no devsite, or its node stopped", async () => {
  expect(await listedAs()).toEqual([{ mac: "Mac mini", state: "refused" }]);
});

test("a Mac that never replies is listed as timeout: it sleeps, is off, or drops the call", async () => {
  // Accepts the connection and sends nothing, as a dropped packet gives no reply.
  expect(await listedAs((s) => s.on("request", () => {}))).toEqual([
    { mac: "Mac mini", state: "timeout" },
  ]);
});

test("a Mac where another program holds the peer port is listed as not-a-node", async () => {
  const list = await listedAs((s) =>
    s.on("request", (_req, res) => {
      res.end("hello");
    }),
  );
  expect(list).toEqual([{ mac: "Mac mini", state: "not-a-node" }]);
});

test("a peer port taken on this Mac shows in the node's status, and the node takes it once it is free", async () => {
  const peerPort = await freePort();
  const holder = createServer();
  await new Promise<void>((r) => holder.listen(peerPort, "::1", r));
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: { status: statusJson(OTHER_MAC, []) },
  });
  const listeners = async () =>
    ((await (await fetch(`${here.url}/status`)).json()) as { tailnetListeners: unknown })
      .tailnetListeners;
  expect(await listeners()).toEqual([{ address: `[::1]:${peerPort}`, error: "EADDRINUSE" }]);
  await new Promise((r) => holder.close(r));
  // DEVSITE_TAILNET_REFRESH_MS is short in tests, so the next refresh comes within a few polls.
  const deadline = Date.now() + 3000;
  while (JSON.stringify(await listeners()).includes("EADDRINUSE") && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(await listeners()).toEqual([{ address: `[::1]:${peerPort}` }]);
});

test("a node on another protocol does not block a start", async () => {
  const peerPort = await freePort();
  const older = createServer((_req, res) => {
    res.writeHead(400, { "devsite-protocol": "0" });
    res.end();
  });
  await new Promise<void>((r) => older.listen(peerPort, "::1", r));
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: { status: statusJson(THIS_MAC, [OTHER_MAC]) },
  });
  const res = await register(here, "web", { port: 1 });
  older.close();
  expect(res.status).toBe(200);
});

test("only Macs of this Tailscale user are asked: a phone and another user's Mac are skipped", async () => {
  const peerPort = await freePort();
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: {
      status: statusJson(THIS_MAC, [
        { ...OTHER_MAC, os: "iOS" },
        { ip: "127.0.0.2", name: "Shared Mac", user: SOMEONE_ELSE },
      ]),
    },
  });
  expect(await (await fetch(`${here.url}/peers`)).json()).toEqual([]);
});
