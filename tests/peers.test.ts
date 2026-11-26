// Nodes on two Macs of one tailnet (#66): how they find each other, and the start a live name on another Mac refuses. tests/two-macs.ts sets up the two Macs.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { register, startDevServer, startTestNode, status, useNodes } from "./node-helpers";
import {
  freePort,
  holdPort,
  OTHER_MAC,
  refused,
  SOMEONE_ELSE,
  statusJson,
  THIS_MAC,
  twoMacs,
} from "./two-macs";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

useNodes();

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
  expect(list).toEqual([{ mac: "Mac mini", ip: "::1", state: "other-protocol", protocol: 2 }]);
});

test("a Mac with nothing on the peer port is listed as refused: no devsite, or its node stopped", async () => {
  expect(await listedAs()).toEqual([{ mac: "Mac mini", ip: "::1", state: "refused" }]);
});

test("a Mac that never replies is listed as timeout: it sleeps, is off, or drops the call", async () => {
  // Accepts the connection and sends nothing, as a dropped packet gives no reply.
  expect(await listedAs((s) => s.on("request", () => {}))).toEqual([
    { mac: "Mac mini", ip: "::1", state: "timeout" },
  ]);
});

test("a Mac where another program holds the peer port is listed as not-a-node", async () => {
  const list = await listedAs((s) =>
    s.on("request", (_req, res) => {
      res.end("hello");
    }),
  );
  expect(list).toEqual([{ mac: "Mac mini", ip: "::1", state: "not-a-node" }]);
});

// DEVSITE_TAILNET_REFRESH_MS is short in tests, so the next refresh comes within a few polls.
async function eventually(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000;
  while (!(await check()) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

test("a peer port taken on this Mac shows in the node's status with the fallback port it listens on, and the node moves back once the port is free", async () => {
  const peerPort = await freePort();
  const release = await holdPort(peerPort, "::1");
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: { status: statusJson(OTHER_MAC, []) },
  });
  const listeners = async () =>
    ((await (await fetch(`${here.url}/status`)).json()) as { tailnetListeners: unknown })
      .tailnetListeners;
  expect(await listeners()).toEqual([
    { address: `[::1]:${peerPort}`, error: "EADDRINUSE", fallback: `[::1]:${peerPort + 1}` },
  ]);
  const hello = await fetch(`http://[::1]:${peerPort + 1}/hello`, {
    headers: { "devsite-protocol": "1" },
  });
  expect(hello.headers.get("devsite-protocol")).toBe("1");
  await release();
  await eventually(async () => !JSON.stringify(await listeners()).includes("EADDRINUSE"));
  expect(await listeners()).toEqual([{ address: `[::1]:${peerPort}` }]);
  expect(await refused(peerPort + 1, "::1")).toBe(true);
});

test("a fallback port another program also holds is skipped for the next one", async () => {
  const peerPort = await freePort();
  const releases = [await holdPort(peerPort, "::1"), await holdPort(peerPort + 1, "::1")];
  const here = await startTestNode(undefined, {
    peerPort,
    tailnet: { status: statusJson(OTHER_MAC, []) },
  });
  const status = (await (await fetch(`${here.url}/status`)).json()) as {
    tailnetListeners: unknown;
  };
  for (const release of releases) await release();
  expect(status.tailnetListeners).toEqual([
    { address: `[::1]:${peerPort}`, error: "EADDRINUSE", fallback: `[::1]:${peerPort + 2}` },
  ]);
});

test("with the peer port taken on the other Mac's Tailscale IP, a start of a name live there is still refused", async () => {
  const peerPort = await freePort();
  const release = await holdPort(peerPort, OTHER_MAC.ip);
  const { here, there } = await twoMacs({ peerPort });
  const dev = await startDevServer();
  await register(there, "web", {
    port: dev.port,
    folder: join(there.home, "Projects", "acme-web"),
  });
  const res = await register(here, "web", { port: dev.port });
  await release();
  expect(res.status).toBe(409);
  expect(await res.json()).toEqual({
    error: "web.internal runs on Mac mini from ~/Projects/acme-web",
  });
  expect(await (await fetch(`${here.url}/peers`)).json()).toEqual([
    { mac: "Mac mini", ip: "::1", state: "same-protocol" },
  ]);
});

test("with a program on the other Mac's peer port that speaks no HTTP, a start of a name live there is still refused", async () => {
  const peerPort = await freePort();
  const holder = createNetServer((s) => s.end("SSH-2.0-OpenSSH\r\n"));
  await new Promise<void>((r) => holder.listen(peerPort, OTHER_MAC.ip, r));
  const { here, there } = await twoMacs({ peerPort });
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  const res = await register(here, "web", { port: dev.port });
  holder.close();
  expect(res.status).toBe(409);
});

test("a node that moved back to the peer port from its fallback port is found there", async () => {
  const peerPort = await freePort();
  const release = await holdPort(peerPort, OTHER_MAC.ip);
  const { here, there } = await twoMacs({ peerPort });
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  expect((await register(here, "web", { port: dev.port })).status).toBe(409);
  await release();
  await eventually(() => refused(peerPort + 1, OTHER_MAC.ip));
  expect(await refused(peerPort + 1, OTHER_MAC.ip)).toBe(true);
  expect((await register(here, "web", { port: dev.port })).status).toBe(409);
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

test("a node takes its first request only once it has read the tailnet, so it knows the other machines", async () => {
  const answers = mkdtempSync(join(tmpdir(), "devsite-tailnet-"));
  writeFileSync(join(answers, "status.json"), JSON.stringify(statusJson(THIS_MAC, [])));
  writeFileSync(join(answers, "delay"), "1");
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, "node", "--port", String(port)], {
    env: {
      ...process.env,
      DEVSITE_USER_HOME: mkdtempSync(join(tmpdir(), "devsite-home-")),
      DEVSITE_FAKE_TAILSCALE: answers,
      DEVSITE_PEER_PORT: String(await freePort()),
    },
    stdio: "ignore",
  });
  try {
    let first: { tailnetListeners?: unknown[] } | null = null;
    for (let i = 0; i < 400 && first === null; i++) {
      first = await fetch(`http://127.0.0.1:${port}/status`).then(
        (r) => r.json() as Promise<{ tailnetListeners?: unknown[] }>,
        () => null,
      );
      if (first === null) await Bun.sleep(10);
    }
    expect(first?.tailnetListeners).toHaveLength(1);
  } finally {
    child.kill();
  }
});
