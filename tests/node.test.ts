// The node (ADR 0005), driven over HTTP as Caddy and the clients drive it: each test starts a real node in its own process.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { join } from "node:path";
import pkg from "../package.json";
import {
  register,
  startDevServer,
  startTestNode,
  status,
  type TestNode,
  useNodes,
  viaNode,
} from "./node-helpers";

useNodes();

test("a registered project answers at both names through the node", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  expect((await register(node, "web", { port: dev.port })).status).toBe(200);
  const internal = await viaNode(node, "web.internal", "/src/main.ts");
  expect(internal).toMatchObject({ status: 200, body: "web /src/main.ts host=web.internal" });
  const localhost = await viaNode(node, "web.localhost:443");
  expect(localhost.body).toBe("web / host=web.localhost:443");
});

test("several projects run at once, each on its own port", async () => {
  const node = await startTestNode();
  const web = await startDevServer("web");
  const api = await startDevServer("api");
  await register(node, "web", { port: web.port });
  await register(node, "api", { port: api.port });
  expect((await viaNode(node, "web.internal")).body).toStartWith("web ");
  expect((await viaNode(node, "api.internal")).body).toStartWith("api ");
});

// A raw upgrade request, as Caddy forwards the browser's HMR WebSocket; returns what comes back after the bytes sent.
function upgrade(node: TestNode, host: string, send: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect({ host: "127.0.0.1", port: node.port }, () => {
      s.write(
        `GET /hmr HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
    });
    let got = "";
    s.on("data", (d) => {
      got += d;
      if (got.includes("\r\n\r\n") && !got.includes(send)) s.write(send);
      if (got.includes(send)) {
        s.destroy();
        resolve(got);
      }
    });
    s.on("error", reject);
    s.on("close", () => resolve(got));
  });
}

test("HMR: a WebSocket upgrade reaches the dev server and its bytes flow both ways", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port });
  const got = await upgrade(node, "web.internal", "ping");
  expect(got).toStartWith("HTTP/1.1 101 Switching Protocols");
  expect(got).toEndWith("ping");
});

test("a stopped project shows the offline page with where it last ran, and not live", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", {
    port: dev.port,
    folder: "/Users/me/Projects/web",
    project: "@acme/web",
  });
  await fetch(`${node.url}/projects/web/stop`, {
    method: "POST",
    body: JSON.stringify({ port: dev.port }),
  });
  const page = await viaNode(node, "web.internal");
  expect(page.status).toBe(503);
  expect(page.headers["content-type"]).toBe("text/html; charset=utf-8");
  expect(page.headers["cache-control"]).toBe("no-store");
  expect(page.body).toContain('<em class="host">web.internal</em> is not running');
  expect(page.body).toContain("<dt>last ran in</dt><dd>/Users/me/Projects/web</dd>");
  expect(page.body).toContain("<dt>live</dt><dd>no</dd>");
  expect(page.body).toContain("<span>@acme/web</span>");
  expect(page.body).not.toContain("__");
});

test("a dev server that died with no stop: the next request shows the offline page, and the project is no longer live", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port });
  await dev.close();
  const page = await viaNode(node, "web.internal");
  expect(page.status).toBe(503);
  expect(page.body).toContain("<dt>live</dt><dd>no</dd>");
  expect((await status(node)).projects.web?.live).toBe(false);
});

test("a browser that drops a request before the dev server answers leaves the project live", async () => {
  const node = await startTestNode();
  // A dev server still busy with the request, as Vite is while it transforms a module.
  const reached = Promise.withResolvers<void>();
  const dropped = Promise.withResolvers<void>();
  const dev = createServer((req) => {
    req.socket.once("close", () => dropped.resolve());
    reached.resolve();
  });
  await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
  try {
    await register(node, "web", { port: (dev.address() as AddressInfo).port });
    const req = request({ host: "127.0.0.1", port: node.port, headers: { host: "web.internal" } });
    req.on("error", () => undefined);
    req.end();
    await reached.promise;
    req.destroy();
    await dropped.promise;
    expect((await status(node)).projects.web?.live).toBe(true);
  } finally {
    dev.closeAllConnections();
    await new Promise((r) => dev.close(r));
  }
});

test("status asks each live project's dev server, so a dead one reads as not live", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port });
  expect((await status(node)).projects.web?.live).toBe(true);
  await dev.close();
  expect((await status(node)).projects.web?.live).toBe(false);
});

test("a stop for an old port leaves the project live on its new port", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port });
  await fetch(`${node.url}/projects/web/stop`, {
    method: "POST",
    body: JSON.stringify({ port: 1 }),
  });
  expect((await status(node)).projects.web?.live).toBe(true);
});

test("a port the OS gives a second project ends the first one's claim to it", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port });
  await register(node, "api", { port: dev.port });
  expect((await status(node)).projects.web?.live).toBe(false);
  expect((await viaNode(node, "web.internal")).status).toBe(503);
});

test("a name no project used on this Mac: the offline page says so, with 404", async () => {
  const node = await startTestNode();
  const page = await viaNode(node, "nope.localhost");
  expect(page.status).toBe(404);
  expect(page.body).toContain('No project named <em class="host">nope</em> has run on this Mac.');
});

test("the state lives in Application Support and outlives the node", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port, devsiteVersion: "1.2.3" });
  const file = join(node.home, "Library", "Application Support", "devsite", "state.json");
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.projects.web).toMatchObject({
    port: dev.port,
    folder: "/Users/me/Projects/web",
    live: true,
    lastUsed: new Date().toISOString().slice(0, 10),
    devsiteVersion: "1.2.3",
  });
  await node.stop();
  const again = await startTestNode(node.home);
  expect((await viaNode(again, "web.internal")).body).toStartWith("web ");
});

test("status names the node's devsite version", async () => {
  const node = await startTestNode();
  expect((await status(node)).version).toBe(pkg.version);
});

test("Caddy may sign a certificate only for a name the node knows", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port });
  const ask = (domain: string) => fetch(`${node.url}/tls-allowed?domain=${domain}`);
  expect((await ask("web.internal")).status).toBe(200);
  expect((await ask("web.localhost")).status).toBe(200);
  expect((await ask("evil.internal")).status).toBe(403);
  expect((await ask("web.example.com")).status).toBe(403);
});

test("the API answers only at the node's own address, not at a name a web page rebinds to it", async () => {
  const node = await startTestNode();
  const res = await viaNode(node, "evil.example.com", "/status");
  expect(res.status).toBe(421);
});

test("a register with no port is refused, and changes nothing", async () => {
  const node = await startTestNode();
  const res = await fetch(`${node.url}/projects/web`, { method: "PUT", body: "{}" });
  expect(res.status).toBe(400);
  expect((await status(node)).projects).toEqual({});
});

test("a web page's cross-site POST cannot mark a project not live", async () => {
  const node = await startTestNode();
  const dev = await startDevServer();
  await register(node, "web", { port: dev.port });
  const res = await fetch(`${node.url}/projects/web/stop`, {
    method: "POST",
    headers: { origin: "https://example.com", "content-type": "text/plain" },
    body: JSON.stringify({ port: dev.port }),
  });
  expect(res.status).toBe(421);
  expect((await status(node)).projects.web?.live).toBe(true);
});

test("a dev server that resets mid-response leaves the node running", async () => {
  const node = await startTestNode();
  const dev = createServer((_req, res) => {
    res.writeHead(200, { "content-length": "1000" });
    res.write("partial");
    setTimeout(() => res.socket?.destroy(), 20);
  });
  await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
  try {
    await register(node, "web", { port: (dev.address() as AddressInfo).port });
    // The browser side ends with the dev server's reset: it gets no end, only a close.
    await new Promise<void>((resolve) => {
      const req = request(
        { host: "127.0.0.1", port: node.port, headers: { host: "web.internal" } },
        (res) => {
          res.resume();
          res.on("error", () => undefined);
          res.on("close", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
    expect((await status(node)).projects.web).toBeDefined();
  } finally {
    dev.closeAllConnections();
    await new Promise((r) => dev.close(r));
  }
});

test("a second node on a taken port exits 1 with a devsite message, not a stack", async () => {
  const node = await startTestNode();
  const r = spawnSync(
    process.execPath,
    [join(import.meta.dir, "..", "src", "cli.ts"), "node", "--port", String(node.port)],
    { encoding: "utf8", env: { ...process.env, DEVSITE_USER_HOME: node.home } },
  );
  expect(r.status).toBe(1);
  expect(r.stderr).toBe(
    `devsite node: another process listens on 127.0.0.1:${node.port}; \`lsof -i :${node.port}\` names it\n`,
  );
});
