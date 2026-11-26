// A machine whose node is stopped passes a request to the main Mac (#110): two real Caddys run devsite's route on scratch ports, a DNS server on loopback stands in for Tailscale's, and a local server for the main Mac's node.
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { request } from "node:https";
import { type AddressInfo, createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:tls";
import { renderNodeRoute } from "../src/commands/init";
import { serving } from "./serving";
import { freePort } from "./two-macs";

// Each test starts up to two Caddys.
setDefaultTimeout(15_000);

const PAGE = "<p>node not running</p>";

let children: ChildProcess[] = [];
let node: Server;
let nodePort: number;
let deadPort: number;
let seen: { method?: string; host?: string; body: string }[] = [];

beforeEach(async () => {
  seen = [];
  deadPort = await freePort();
  node = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, host: req.headers.host, body });
    res.end("main");
  });
  await new Promise<void>((r) => node.listen(0, "127.0.0.1", r));
  nodePort = (node.address() as AddressInfo).port;
});

afterEach(async () => {
  await Promise.all(
    children.map((c) => {
      // A Caddy that did not start has ended already and sends no exit event again.
      if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
      const ended = new Promise((r) => c.once("exit", r));
      c.kill();
      return ended;
    }),
  );
  children = [];
  node.closeAllConnections();
  node.close();
});

// devsite's route on `port`. The private CA is in no trust store, so the test's Caddy checks the main Mac's certificate only against the root file `trust` names. dir: Caddy's storage, which holds its CA.
async function startCaddy(
  port: number,
  to: { node: number; main: number; dns: string },
  {
    dir = mkdtempSync(join(tmpdir(), "devsite-pass-")),
    trust,
  }: { dir?: string; trust?: string } = {},
) {
  let route = renderNodeRoute(PAGE);
  for (const [from, into] of [
    ["*.internal, *.localhost {", `*.internal:${port}, *.localhost:${port} {`],
    ["\t\ton_demand\n", ""],
    // Whole tokens, before the node's port goes in: a port that starts with 443 holds "127.0.0.1:443".
    ["127.0.0.1:443 {", `127.0.0.1:${port} {`],
    ["port 443\n", `port ${to.main}\n`],
    ["127.0.0.1:47380", `127.0.0.1:${to.node}`],
    ["100.100.100.100", to.dns],
    [
      "dial_timeout",
      `${trust === undefined ? "tls_insecure_skip_verify" : `tls_trust_pool file ${trust}`}\ndial_timeout`,
    ],
  ] as const) {
    // A route that changed must not reach this machine's real Caddy, node or DNS.
    if (!route.includes(from)) throw new Error(`devsite's route holds no ${from}`);
    route = route.replaceAll(from, into);
  }
  writeFileSync(
    join(dir, "Caddyfile"),
    `{\nadmin off\nauto_https disable_redirects\nskip_install_trust\nhttps_port ${port}\nstorage file_system ${dir}\n}\n${route}`,
  );
  const child = spawn("caddy", ["run", "--config", join(dir, "Caddyfile")], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let log = "";
  child.stderr?.on("data", (d) => {
    log += d;
  });
  children.push(child);
  for (let i = 0; i < 200 && child.exitCode === null; i++) {
    const up = await new Promise<boolean>((resolve) => {
      const s = connect(
        { host: "127.0.0.1", port, servername: "web.internal", rejectUnauthorized: false },
        () => {
          s.destroy();
          resolve(true);
        },
      );
      s.once("error", () => resolve(false));
    });
    if (up) return child;
    await Bun.sleep(50);
  }
  throw new Error(`Caddy did not start: ${log}`);
}

function send(
  port: number,
  opts: { method?: string; body?: string; host?: string; headers?: Record<string, string> } = {},
) {
  const host = opts.host ?? "web.internal";
  return new Promise<{ status?: number; connection?: string; altSvc?: string; body: string }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          servername: host,
          rejectUnauthorized: false,
          agent: false,
          method: opts.method,
          headers: {
            host,
            connection: "keep-alive",
            ...opts.headers,
          },
        },
        async (res) => {
          let body = "";
          for await (const chunk of res) body += chunk;
          resolve({
            status: res.statusCode,
            connection: res.headers.connection,
            altSvc: res.headers["alt-svc"],
            body,
          });
        },
      );
      req.on("error", reject);
      req.end(opts.body);
    },
  );
}

// The old main Mac, whose node is stopped, and the main Mac.
async function twoCaddys() {
  const [old, main] = [await freePort(), await freePort()];
  const dns = (await serving("127.0.0.1")).DEVSITE_DNSMASQ_AT;
  await startCaddy(old, { node: deadPort, main, dns });
  const mainCaddy = await startCaddy(main, { node: nodePort, main, dns });
  return { old, main, mainCaddy };
}

test("a request goes to the main Mac with its body and host, and the connection stays open", async () => {
  const { old } = await twoCaddys();
  const r = await send(old, { method: "POST", body: "hello" });
  expect(r).toEqual({ status: 200, connection: undefined, altSvc: "clear", body: "main" });
  expect(seen).toEqual([{ method: "POST", host: "web.internal", body: "hello" }]);
});

test("a request another machine's node relayed gets the page", async () => {
  const { old } = await twoCaddys();
  expect(await send(old, { headers: { "devsite-relayed": "1" } })).toMatchObject({
    status: 502,
    body: PAGE,
  });
  expect(seen).toEqual([]);
});

test("the main Mac's Caddy refuses the connection: the page", async () => {
  const { old, mainCaddy } = await twoCaddys();
  children = children.filter((c) => c !== mainCaddy);
  await new Promise((r) => {
    mainCaddy.once("exit", r);
    mainCaddy.kill();
  });
  expect(await send(old)).toEqual({
    status: 502,
    connection: "close",
    altSvc: "clear",
    body: PAGE,
  });
});

test("Tailscale's DNS names this machine itself, or gives no answer: the page", async () => {
  const self = await freePort();
  const dns = (await serving("127.0.0.1")).DEVSITE_DNSMASQ_AT;
  await startCaddy(self, { node: deadPort, main: self, dns });
  expect(await send(self)).toMatchObject({ status: 502, body: PAGE });
  const noDns = await freePort();
  await startCaddy(noDns, { node: deadPort, main: noDns, dns: `127.0.0.1:${deadPort}` });
  expect(await send(noDns)).toMatchObject({ status: 502, body: PAGE });
});

test("a *.localhost name belongs to this machine: the page", async () => {
  const { old } = await twoCaddys();
  expect(await send(old, { host: "web.localhost" })).toMatchObject({ status: 502, body: PAGE });
  expect(seen).toEqual([]);
});

test("a request that says it was passed is not passed again", async () => {
  const { old } = await twoCaddys();
  const r = await send(old, { headers: { "devsite-pass": "passed" } });
  expect(r).toMatchObject({ status: 502, connection: "close", body: PAGE });
  expect(seen).toEqual([]);
});

test("a WebSocket opens through the main Mac", async () => {
  node.on("upgrade", (_req, socket) => {
    socket.end(
      "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
    );
  });
  const { old } = await twoCaddys();
  const head = await new Promise<string>((resolve) => {
    const s = connect(
      { host: "127.0.0.1", port: old, servername: "web.internal", rejectUnauthorized: false },
      () =>
        s.write(
          "GET / HTTP/1.1\r\nHost: web.internal\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
        ),
    );
    s.once("data", (d) => {
      s.destroy();
      resolve(String(d));
    });
  });
  expect(head).toStartWith("HTTP/1.1 101");
});

test("a main Mac that accepts the connection and then says nothing: the page after 1.5 s", async () => {
  const silent = createTcpServer();
  await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
  const old = await freePort();
  const dns = (await serving("127.0.0.1")).DEVSITE_DNSMASQ_AT;
  await startCaddy(old, { node: deadPort, main: (silent.address() as AddressInfo).port, dns });
  const start = Date.now();
  expect(await send(old)).toMatchObject({ status: 502, body: PAGE });
  expect(Date.now() - start).toBeGreaterThanOrEqual(1400);
  expect(Date.now() - start).toBeLessThan(4000);
  silent.close();
});

test("a node that dies while it answers: the request is not sent a second time", async () => {
  const [old, main] = [await freePort(), await freePort()];
  const dns = (await serving("127.0.0.1")).DEVSITE_DNSMASQ_AT;
  const dying = createServer((req) => req.socket.destroy());
  await new Promise<void>((r) => dying.listen(0, "127.0.0.1", r));
  await startCaddy(old, { node: (dying.address() as AddressInfo).port, main, dns });
  await startCaddy(main, { node: nodePort, main, dns });
  expect(await send(old, { method: "POST", body: "pay" })).toMatchObject({
    status: 502,
    body: PAGE,
  });
  expect(seen).toEqual([]);
  dying.close();
});

test("an answer that takes 12 s comes through, as with no pass", async () => {
  node.removeAllListeners("request");
  node.on("request", (_req, res) => {
    setTimeout(() => res.end("slow"), 12_000);
  });
  const { old } = await twoCaddys();
  expect(await send(old)).toMatchObject({ status: 200, body: "slow" });
}, 30_000);

// Every Mac serves from one CA root (#104), so the old main Mac's Caddy checks the main Mac's certificate against that root; the system's trust store holds it on a real Mac.
test("the main Mac's certificate from the shared CA root passes the check; one from another root gets the page", async () => {
  const dns = (await serving("127.0.0.1")).DEVSITE_DNSMASQ_AT;
  const shared = mkdtempSync(join(tmpdir(), "devsite-pass-"));
  const main = await freePort();
  await startCaddy(main, { node: nodePort, main, dns }, { dir: shared });
  const root = join(shared, "pki", "authorities", "local", "root.crt");
  const old = await freePort();
  await startCaddy(old, { node: deadPort, main, dns }, { trust: root });
  expect(await send(old)).toMatchObject({ status: 200, body: "main" });

  const otherRoot = join(mkdtempSync(join(tmpdir(), "devsite-pass-")), "other.crt");
  const made = spawnSync("openssl", [
    ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=Other Root"],
    ...["-keyout", `${otherRoot}.key`, "-out", otherRoot],
  ]);
  expect(made.status).toBe(0);
  const untrusting = await freePort();
  await startCaddy(untrusting, { node: deadPort, main, dns }, { trust: otherRoot });
  expect(await send(untrusting)).toMatchObject({ status: 502, body: PAGE });
  expect(seen).toHaveLength(1);
});

// Go's resolver, which Caddy uses, tries each nameserver of /etc/resolv.conf twice, 5 s each, and Caddy sends every try to its one resolver.
test("a DNS server that never replies: the page after 10 s for each nameserver of /etc/resolv.conf", async () => {
  const nameservers =
    readFileSync("/etc/resolv.conf", "utf8").match(/^nameserver\s/gm)?.length ?? 1;
  const expected = nameservers * 2 * 5000;
  const old = await freePort();
  const dns = (await serving("127.0.0.1", { dns: null })).DEVSITE_DNSMASQ_AT;
  await startCaddy(old, { node: deadPort, main: await freePort(), dns });
  const start = Date.now();
  expect(await send(old)).toMatchObject({ status: 502, body: PAGE });
  expect(Date.now() - start).toBeGreaterThanOrEqual(expected - 500);
  expect(Date.now() - start).toBeLessThan(expected + 2000);
}, 60_000);
