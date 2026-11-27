// The relay (#109): a request to this Mac's node for a name live on the other Mac goes over HTTPS to that Mac's Caddy, checked against this Mac's CA root. A local HTTPS server signed by a test CA stands in for the other Mac's Caddy and proxies to its node, and a mock of this Mac's Caddy admin API gives the root.
import { afterEach, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, get, type IncomingMessage, request, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { type AddressInfo, connect, createServer as createTcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RELAYED_HEADER, requestHead } from "../src/node/relay";
import {
  register,
  startDevServer,
  type TestNode,
  upgrade,
  useNodes,
  viaNode,
} from "./node-helpers";
import { freePort, THIS_MAC, twoMacs } from "./two-macs";

useNodes();

type Ca = { root: string; leaf: string; leafKey: string };
const cas: { shared: Ca; other: Ca } = {
  shared: { root: "", leaf: "", leafKey: "" },
  other: { root: "", leaf: "", leafKey: "" },
};

// A CA root and a leaf for web.internal that it signs, as each Mac's Caddy holds them.
function makeCa(cn: string): Ca {
  const dir = mkdtempSync(join(tmpdir(), "devsite-relay-pki-"));
  const openssl = (args: string[]) => {
    const r = spawnSync("openssl", args, { cwd: dir, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${r.stderr}`);
  };
  openssl(
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${cn}`].concat([
      "-keyout",
      "root.key",
      "-out",
      "root.crt",
    ]),
  );
  openssl(
    ["req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=web.internal"].concat([
      "-keyout",
      "leaf.key",
      "-out",
      "leaf.csr",
    ]),
  );
  writeFileSync(join(dir, "san.ext"), "subjectAltName=DNS:web.internal\n");
  openssl(
    ["x509", "-req", "-in", "leaf.csr", "-CA", "root.crt", "-CAkey", "root.key"].concat([
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      "san.ext",
      "-out",
      "leaf.crt",
    ]),
  );
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return { root: read("root.crt"), leaf: read("leaf.crt"), leafKey: read("leaf.key") };
}

beforeAll(() => {
  cas.shared = makeCa("Test Root");
  cas.other = makeCa("Other Root");
});

const servers: Server[] = [];
const sockets = new Set<Socket>();

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.clear();
  await Promise.all(
    servers.splice(0).map((s) => {
      s.closeAllConnections();
      return new Promise((r) => s.close(r));
    }),
  );
});

// This Mac's Caddy admin API, as GET /pki/ca/local answers with the local CA's root.
async function adminWithRoot(root: string): Promise<string> {
  const s = createServer((req, res) => {
    if (req.url !== "/pki/ca/local") {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ id: "local", root_certificate: root }));
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

// The other Mac's Caddy at ::1: TLS with `ca`'s leaf, then every request and upgrade to that Mac's node with its Host header, as devsite's route does.
async function otherCaddy(port: number, ca: Ca, node: TestNode) {
  const s = createHttpsServer({ cert: ca.leaf, key: ca.leafKey }, (req, res) => {
    const up = request(
      {
        host: "127.0.0.1",
        port: node.port,
        method: req.method,
        path: req.url,
        headers: req.headers,
      },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on("error", () => res.destroy());
    req.pipe(up);
  });
  s.on("upgrade", (req, socket: Socket, head: Buffer) => {
    sockets.add(socket);
    const up = connect({ host: "127.0.0.1", port: node.port }, () => {
      up.write(requestHead(req));
      if (head.length > 0) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    sockets.add(up);
    up.on("error", () => socket.destroy());
    socket.on("error", () => up.destroy());
  });
  servers.push(s);
  await new Promise<void>((r) => s.listen(port, "::1", r));
}

// Two Macs whose Caddys share one port; the other Mac's Caddy serves a leaf of `served` (null: no Caddy answers there), and this Mac's Caddy holds the shared root.
async function relayMacs(served: Ca | null = cas.shared) {
  const caddyPort = await freePort();
  const admin = await adminWithRoot(cas.shared.root);
  const env = { DEVSITE_PEER_CADDY_PORT: String(caddyPort) };
  const macs = await twoMacs({
    hereEnv: { ...env, DEVSITE_CADDY_ADMIN: admin },
    thereEnv: env,
  });
  if (served !== null) await otherCaddy(caddyPort, served, macs.there);
  return macs;
}

test("a request for a name live on the other Mac returns that Mac's dev server's answer", async () => {
  const { here, there } = await relayMacs();
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  const res = await viaNode(here, "web.internal", "/src/main.ts");
  expect(res).toMatchObject({ status: 200, body: "web /src/main.ts host=web.internal" });
});

test("HMR: a WebSocket upgrade for a name live on the other Mac reaches its dev server", async () => {
  const { here, there } = await relayMacs();
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  const got = await upgrade(here, "web.internal", "ping");
  expect(got).toStartWith("HTTP/1.1 101 Switching Protocols");
  expect(got).toEndWith("ping");
});

test("the other Mac's Caddy with a certificate from another CA root gets no request: the answer names that Mac and the fix", async () => {
  const { here, there } = await relayMacs(cas.other);
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  const res = await viaNode(here, "web.internal");
  expect(res.status).toBe(502);
  expect(res.body).toContain("Mac mini");
  expect(res.body).toContain("devsite ca export");
  expect(res.body).not.toContain("web /");
});

test("the other Mac's Caddy does not answer: the answer names that Mac and the address asked", async () => {
  const { here, there } = await relayMacs(null);
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  const res = await viaNode(here, "web.internal");
  expect(res.status).toBe(502);
  expect(res.body).toContain(
    "web.internal runs on Mac mini, and its Caddy does not answer at [::1]:",
  );
});

test("a name live on no Mac shows the offline page with where it last ran on the other Mac", async () => {
  const { here, there } = await relayMacs();
  const dev = await startDevServer();
  await register(there, "web", {
    port: dev.port,
    folder: join(there.home, "Projects", "acme-web"),
    project: "@acme/web",
  });
  await dev.close();
  const page = await viaNode(here, "web.internal");
  expect(page.status).toBe(503);
  expect(page.body).toContain("<dt>last ran in</dt><dd>~/Projects/acme-web</dd>");
  expect(page.body).toContain("<dt>on</dt><dd>Mac mini</dd>");
  expect(page.body).toContain("<dt>live</dt><dd>no</dd>");
  expect(page.body).toContain("<span>@acme/web</span>");
});

test("Caddy may sign a certificate for a name the other Mac knows, so the phone reaches it through this Mac", async () => {
  const { here, there } = await relayMacs();
  await register(there, "web", { port: 1 });
  const allowed = (d: string) => fetch(`${here.url}/tls-allowed?domain=${d}`);
  expect((await allowed("web.internal")).status).toBe(200);
  expect((await allowed("nope.internal")).status).toBe(403);
});

test("a relayed request is never relayed again, so two nodes never send one request back and forth", async () => {
  const { here, there } = await relayMacs();
  const dev = await startDevServer();
  await register(here, "web", { port: dev.port });
  const res = await viaNode(there, "web.internal", "/", { headers: { [RELAYED_HEADER]: "1" } });
  expect(res.status).toBe(404);
  expect(res.body).not.toContain("web /");
});

test("a POST body reaches the other Mac's dev server whole", async () => {
  const { here, there } = await relayMacs();
  const echo = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    res.end(`${req.method} ${body}`);
  });
  servers.push(echo);
  await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
  await register(there, "web", { port: (echo.address() as AddressInfo).port });
  const sent = "x".repeat(200_000);
  const res = await viaNode(here, "web.internal", "/api", { method: "POST", body: sent });
  expect(res.status).toBe(200);
  expect(res.body).toBe(`POST ${sent}`);
});

test("an answer that takes 12 s comes through, also on a connection that an earlier request opened", async () => {
  const { here, there } = await relayMacs();
  const slow = createServer((req, res) => {
    setTimeout(() => res.end("slow"), req.url === "/slow" ? 12_000 : 0);
  });
  servers.push(slow);
  await new Promise<void>((r) => slow.listen(0, "127.0.0.1", r));
  await register(there, "web", { port: (slow.address() as AddressInfo).port });
  expect((await viaNode(here, "web.internal")).status).toBe(200);
  expect(await viaNode(here, "web.internal", "/slow")).toMatchObject({ status: 200, body: "slow" });
}, 30_000);

test("the other Mac's Caddy accepts the connection and then says nothing: the answer names that Mac after 1.5 s", async () => {
  const caddyPort = await freePort();
  const env = { DEVSITE_PEER_CADDY_PORT: String(caddyPort) };
  const { here, there } = await twoMacs({
    hereEnv: { ...env, DEVSITE_CADDY_ADMIN: await adminWithRoot(cas.shared.root) },
    thereEnv: env,
  });
  const silent = createTcpServer((s) => {
    sockets.add(s);
  });
  await new Promise<void>((r) => silent.listen(caddyPort, "::1", r));
  const dev = await startDevServer();
  await register(there, "web", { port: dev.port });
  const start = Date.now();
  const res = await viaNode(here, "web.internal").finally(() => silent.close());
  expect(Date.now() - start).toBeLessThan(5000);
  expect(res.status).toBe(502);
  expect(res.body).toContain("its Caddy does not answer at [::1]:");
}, 30_000);

test("the other machine closes its heartbeat connection, as before it sleeps: a relayed request that waits on it ends at once with the page that names it", async () => {
  const { here, there, peerPort } = await relayMacs();
  // A dev server that never answers.
  const silent = createServer(() => {});
  servers.push(silent);
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  await register(there, "web", { port: (silent.address() as AddressInfo).port });
  const heartbeats = await new Promise<IncomingMessage>((resolve, reject) => {
    get(
      {
        host: THIS_MAC.ip,
        port: peerPort,
        path: "/heartbeats",
        headers: { "devsite-protocol": "1" },
      },
      resolve,
    ).on("error", reject);
  });
  expect(heartbeats.statusCode).toBe(200);
  const page = viaNode(here, "web.internal");
  await Bun.sleep(500);
  const closed = Date.now();
  heartbeats.destroy();
  const res = await page;
  expect(Date.now() - closed).toBeLessThan(1000);
  expect(res.status).toBe(502);
  expect(res.body).toBe(
    "devsite: web.internal runs on Mac mini, which went to sleep or stopped its devsite node.\n",
  );
});
