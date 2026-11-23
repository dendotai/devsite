// A real node in its own process, on a scratch home and a free loopback port, plus small local HTTP servers that stand in for dev servers.
import { afterEach } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

export type TestNode = { url: string; port: number; home: string; stop: () => Promise<void> };

const children: ChildProcess[] = [];
const servers: Server[] = [];
// Upgraded sockets leave a server's connection list, so close() would wait on them.
const tunnels = new Set<import("node:stream").Duplex>();

// Each suite calls this once at its top, so its nodes and dev servers stop after each test.
export function useNodes() {
  afterEach(async () => {
    await Promise.all(children.splice(0).map(stopChild));
    for (const s of tunnels) s.destroy();
    tunnels.clear();
    await Promise.all(
      servers.splice(0).map((s) => {
        s.closeAllConnections();
        return new Promise((r) => s.close(r));
      }),
    );
  });
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGTERM");
  });
}

// The answers the fake tailscale (tests/bin/tailscale) gives this node: `status --json`, and `whois --json <ip>` per IP.
export type FakeTailnet = { status: object; whois?: Record<string, object> };

export type TestNodeOptions = { tailnet?: FakeTailnet; peerPort?: number };

export async function startTestNode(
  home = mkdtempSync(join(tmpdir(), "devsite-home-")),
  { tailnet, peerPort }: TestNodeOptions = {},
) {
  const answers = mkdtempSync(join(tmpdir(), "devsite-tailnet-"));
  if (tailnet !== undefined) {
    writeFileSync(join(answers, "status.json"), JSON.stringify(tailnet.status));
    for (const [ip, who] of Object.entries(tailnet.whois ?? {})) {
      writeFileSync(join(answers, `whois-${ip}.json`), JSON.stringify(who));
    }
  }
  const child = spawn(process.execPath, [CLI, "node", "--port", "0"], {
    env: {
      ...process.env,
      DEVSITE_USER_HOME: home,
      DEVSITE_FAKE_TAILSCALE: answers,
      ...(peerPort === undefined ? {} : { DEVSITE_PEER_PORT: String(peerPort) }),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  const port = await new Promise<number>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (d) => {
      out += d;
      const m = out.match(/listening on 127\.0\.0\.1:(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.once("exit", (code) => reject(new Error(`the node exited ${code}: ${out}`)));
  });
  const node: TestNode = {
    url: `http://127.0.0.1:${port}`,
    port,
    home,
    stop: () => stopChild(child),
  };
  return node;
}

// A dev server: answers each request with `<name> <path>`, and echoes each WebSocket-style upgrade back as raw bytes.
export async function startDevServer(name = "web") {
  const server = createServer((req, res) => {
    res.setHeader("content-type", "text/plain");
    res.end(`${name} ${req.url} host=${req.headers.host}`);
  });
  server.on("upgrade", (_req, socket) => {
    tunnels.add(socket);
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
    );
    socket.on("data", (d) => socket.write(d));
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

// A request to the node as Caddy sends it: the visited host in the Host header.
export function viaNode(
  node: TestNode,
  host: string,
  path = "/",
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: node.port, path, headers: { host } }, (res) => {
      let body = "";
      res.on("data", (c) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

export function register(
  node: TestNode,
  name: string,
  body: { port: number; folder?: string; project?: string; devsiteVersion?: string },
) {
  return fetch(`${node.url}/projects/${name}`, {
    method: "PUT",
    body: JSON.stringify({ folder: "/Users/me/Projects/web", ...body }),
  });
}

export async function status(node: TestNode) {
  const res = await fetch(`${node.url}/status`);
  return (await res.json()) as {
    version: string;
    projects: Record<string, { live: boolean; port: number; folder: string; lastUsed: string }>;
  };
}
