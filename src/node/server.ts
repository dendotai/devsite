// The node (ADR 0005): the devsite server that stays on, one per Mac. Caddy proxies every `*.internal` and `*.localhost` request here, and the node sends it to the project's dev server or answers the offline page; clients register projects through its API on the same port.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname } from "node:path";
// bun-types types every .html import as an HTMLBundle for Bun.serve; the text attribute gives the file's text, which `bun build` inlines into dist, so the package ships no asset file.
import offlinePage from "../../assets/offline.html" with { type: "text" };
import pkg from "../../package.json";
import { NAME_RE } from "../names.mjs";
import { type PathsEnv, stateFile, userHome } from "../paths";
import { makeRelay, RELAYED_HEADER, type RelayEnv, requestHead } from "./relay";
import {
  addressOf,
  askPeer,
  type Peer,
  PROTOCOL,
  PROTOCOL_HEADER,
  readTailnet,
  type Tailnet,
  type TailnetEnv,
  whoisUser,
} from "./tailnet";

export type Project = {
  // The package.json name of the project, for the offline page.
  project: string;
  port: number;
  folder: string;
  mac: string;
  live: boolean;
  // UTC date of the last start, YYYY-MM-DD.
  lastUsed: string;
  devsiteVersion: string;
};

// One per Tailscale IP of this Mac: the address the node listens on for other Macs, with the error code while another program holds the port.
export type TailnetListener = { address: string; error?: string };

export type Status = {
  version: string;
  pid: number;
  projects: Record<string, Project>;
  // Absent from an older node.
  tailnetListeners?: TailnetListener[];
};

type State = { projects: Record<string, Project> };

const PROBE_MS = 300;

function readState(file: string): State {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as State;
    // Null prototype, so a name such as __proto__ is a key like any other.
    return { projects: Object.assign(Object.create(null), parsed.projects ?? {}) };
  } catch (err) {
    if ((err as { code?: string }).code !== "ENOENT") {
      console.error(
        `devsite node: ${file} is unreadable (${(err as Error).message}); starting empty`,
      );
    }
    return { projects: Object.create(null) };
  }
}

// Write-then-rename: a reader, or a kill mid-write, never sees a truncated file.
function writeState(file: string, state: State) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

function probe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(PROBE_MS, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

const html = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.codePointAt(0)};`);

// 404: no project of that name has run on this Mac; 503: one has, and its dev server does not answer.
const offlineStatus = (p: LastRun | undefined) => (p === undefined ? 404 : 503);

// What the offline page shows of a project, from this Mac's state or another Mac's node.
type LastRun = Pick<Project, "project" | "folder" | "mac" | "live" | "lastUsed">;

export function renderOfflinePage(host: string, p: LastRun | undefined): string {
  const facts =
    p === undefined
      ? `<p>No project named <em class="host">${html(projectOf(host) ?? host)}</em> has run on this Mac.</p>`
      : [
          "<dl>",
          `<dt>last ran in</dt><dd>${html(p.folder)}</dd>`,
          `<dt>on</dt><dd>${html(p.mac)}</dd>`,
          `<dt>last used</dt><dd>${html(p.lastUsed)}</dd>`,
          `<dt>live</dt><dd>${p.live ? "yes" : "no"}</dd>`,
          "</dl>",
        ].join("\n    ");
  return (offlinePage as unknown as string)
    .replace(/<!--[\s\S]*?-->\n?/, "")
    .replaceAll("__HOST__", html(host))
    .replaceAll("__PROJECT__", html(p?.project ?? ""))
    .replaceAll("__STATUS_CODE__", String(offlineStatus(p)))
    .replace("__FACTS__", facts);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

// A registration is a few hundred bytes; the cap keeps a stray client from filling the node's memory.
const MAX_BODY = 64 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY) return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// A project's name from a Host header the route sends: `<name>.internal` or `<name>.localhost`, any port.
function projectOf(host: string | undefined): string | null {
  const m = (host ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "")
    .match(/^([^.]+)\.(?:internal|localhost)$/);
  return m?.[1] !== undefined && NAME_RE.test(m[1]) ? m[1] : null;
}

// The API answers only a request sent to the node's own address, so a web page that rebinds its DNS name to 127.0.0.1 reaches none of it. A browser sends an Origin header with every cross-site POST, and the clients (the CLI, the Vite plugin, Caddy's ask) send none, so a web page cannot mark a project not live either.
function isApi(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  return (
    (host === `127.0.0.1:${port}` || host === `localhost:${port}`) &&
    req.headers.origin === undefined
  );
}

type Registration = Pick<Project, "port" | "folder"> &
  Partial<Pick<Project, "project" | "devsiteVersion">>;

function parseRegistration(body: unknown): Registration | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as Record<string, unknown>;
  const { port, folder } = b;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof folder !== "string") return null;
  return {
    port,
    folder,
    project: typeof b.project === "string" ? b.project : undefined,
    devsiteVersion: typeof b.devsiteVersion === "string" ? b.devsiteVersion : undefined,
  };
}

const today = () => new Date().toISOString().slice(0, 10);

// Every Mac's node listens for the other nodes on its Tailscale IPs, at one port: the loopback port, NODE_PORT. peerPort differs from it only in tests.
export type NodeOptions = {
  port: number;
  peerPort?: number;
  env: PathsEnv & TailnetEnv & RelayEnv & { DEVSITE_TAILNET_REFRESH_MS?: string };
};

// How often the node reads its Tailscale IPs again and retries a taken port, as Tailscale can start after the node or get a new IP. DEVSITE_TAILNET_REFRESH_MS shortens it in tests.
export const TAILNET_REFRESH_MS = 10_000;

// The states askPeer names (src/node/tailnet.ts), with same-protocol for a node that answered.
export type PeerState =
  | { mac: string; state: "same-protocol" | "denied" | "refused" | "timeout" | "not-a-node" }
  | { mac: string; state: "other-protocol"; protocol: number | null };

// What a node tells another node about one of its projects; folder starts with `~` for a path in its home. project and lastUsed are absent from an older node.
type PeerProject = { folder: string; live: boolean; project?: string; lastUsed?: string };

type PeerRecord = { peer: Peer; project: PeerProject };

function peerProjectOf(body: unknown): PeerProject | null {
  type Sent = { folder?: unknown; live?: unknown; project?: unknown; lastUsed?: unknown };
  const p = (body as { project?: Sent | null } | null)?.project;
  if (typeof p !== "object" || p === null) return null;
  if (typeof p.folder !== "string" || typeof p.live !== "boolean") return null;
  return {
    folder: p.folder,
    live: p.live,
    project: typeof p.project === "string" ? p.project : undefined,
    lastUsed: typeof p.lastUsed === "string" ? p.lastUsed : undefined,
  };
}

// A live name found on another Mac is kept this long, so a page's many requests do not each ask every Mac; a name live on no Mac is asked again at the next request, so a dev server started on any Mac opens at once.
const LIVE_PEER_MS = 5000;

export type RunningNode = { port: number; close: () => Promise<void> };

export async function startNode({ port, peerPort, env }: NodeOptions): Promise<RunningNode> {
  const file = stateFile(env);
  const state = readState(file);
  const mac = hostname().replace(/\.local$/, "");
  const save = () => writeState(file, state);
  // The port is known once the loopback server listens.
  let peersAt = peerPort ?? port;
  // The last tailnet read, for the check on each call from another node.
  let tailnet: Tailnet | null = null;
  const peerServers = new Map<string, Server>();
  // A bind that fails is logged once per IP, as each refresh tries it again; the code stays for `GET /status`.
  const failedIps = new Map<string, string>();

  // A dev server that stopped with no stop request (Ctrl-C, a crash) is found here, at the first request that cannot reach it.
  const markNotLive = (name: string, deadPort: number) => {
    const p = state.projects[name];
    if (p?.live && p.port === deadPort) {
      p.live = false;
      save();
    }
  };

  // Each other Mac's record of a name, until one says it is live: the relay needs no more, and a Mac that sleeps costs no wait then.
  const askPeersUntilLive = async (
    name: string,
    peers: Peer[],
  ): Promise<{ live: PeerRecord | null; records: PeerRecord[] }> => {
    const records: PeerRecord[] = [];
    const live = await new Promise<PeerRecord | null>((resolve) => {
      let left = peers.length;
      if (left === 0) resolve(null);
      for (const peer of peers) {
        askPeer(peer, peersAt, `/projects/${name}`).then((answer) => {
          const project = answer.state === "answer" ? peerProjectOf(answer.body) : null;
          if (project !== null) {
            records.push({ peer, project });
            if (project.live) resolve({ peer, project });
          }
          left -= 1;
          if (left === 0) resolve(null);
        });
      }
    });
    return { live, records };
  };

  const livePeers = new Map<string, { peer: Peer; until: number }>();

  // The Mac a request for a name not live here goes to; the peer list is the last refresh's, as this runs for each request of a page.
  const findLive = async (name: string): Promise<{ live: Peer | null; records: PeerRecord[] }> => {
    const kept = livePeers.get(name);
    if (kept !== undefined && kept.until > Date.now()) return { live: kept.peer, records: [] };
    const { live, records } = await askPeersUntilLive(name, tailnet?.peers ?? []);
    if (live === null) return { live: null, records };
    livePeers.set(name, { peer: live.peer, until: Date.now() + LIVE_PEER_MS });
    return { live: live.peer, records };
  };

  const lastRun = (name: string, others: PeerRecord[]): LastRun | undefined => {
    let newest: LastRun | undefined = state.projects[name];
    for (const { peer, project: p } of others) {
      const lastUsed = p.lastUsed ?? "";
      if (newest !== undefined && newest.lastUsed >= lastUsed) continue;
      newest = {
        project: p.project ?? name,
        folder: p.folder,
        mac: peer.mac,
        live: p.live,
        lastUsed,
      };
    }
    return newest;
  };

  const offline = (res: ServerResponse, host: string, name: string, others: PeerRecord[] = []) => {
    const p = lastRun(name, others);
    res.writeHead(offlineStatus(p), {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderOfflinePage(host, p));
  };

  const relay = makeRelay(env);

  const proxy = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const host = req.headers.host ?? "";
    const p = state.projects[name];
    if (p?.live) return proxyHere(req, res, name, p);
    if (req.headers[RELAYED_HEADER] !== undefined) return offline(res, host, name);
    const { live, records } = await findLive(name);
    if (live === null) return offline(res, host, name, records);
    const failure = await relay.send(req, res, live);
    if (failure === null) return;
    livePeers.delete(name);
    res.writeHead(502, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(relay.explain(failure, host, live));
  };

  const proxyHere = (req: IncomingMessage, res: ServerResponse, name: string, p: Project) => {
    const target = p.port;
    const up = httpRequest({
      host: "127.0.0.1",
      port: target,
      method: req.method,
      path: req.url,
      headers: req.headers,
    });
    up.on("response", (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
      // A dev server that resets mid-response: an error with no listener would end the node.
      r.on("error", () => res.destroy());
    });
    let browserLeft = false;
    up.on("error", () => {
      // The destroy below fires this error too, and says nothing about the dev server.
      if (browserLeft) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      markNotLive(name, target);
      offline(res, req.headers.host ?? "", name);
    });
    // A browser that leaves mid-response: the dev server's request ends with it.
    res.on("close", () => {
      if (res.writableFinished) return;
      browserLeft = true;
      up.destroy();
    });
    req.pipe(up);
  };

  const isLive = async (p: Project) => {
    if (!p.live) return false;
    if (await probe(p.port)) return true;
    p.live = false;
    save();
    return false;
  };

  const home = userHome(env);
  const shownFolder = (folder: string) =>
    folder === home || folder.startsWith(`${home}/`) ? `~${folder.slice(home.length)}` : folder;

  // The name alone decides, so two repos with one devSite name meet the same refusal as one repo on two Macs.
  const liveElsewhere = async (name: string): Promise<string | null> => {
    const fresh = await readTailnet(env);
    if (fresh === null) return null;
    const { live } = await askPeersUntilLive(name, fresh.peers);
    return live === null
      ? null
      : `${name}.internal runs on ${live.peer.mac} from ${live.project.folder}`;
  };

  const register = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const body = parseRegistration(await readBody(req));
    if (body === null) {
      return sendJson(res, 400, { error: "the body needs a port (1-65535) and a folder" });
    }
    const elsewhere = await liveElsewhere(name);
    if (elsewhere !== null) return sendJson(res, 409, { error: elsewhere });
    const { port } = body;
    // A port the OS gave a dead dev server can go to the next one: the project that held it is no longer live.
    for (const other of Object.values(state.projects)) {
      if (other.port === port) other.live = false;
    }
    state.projects[name] = {
      project: body.project ?? name,
      port,
      folder: body.folder,
      mac,
      live: true,
      lastUsed: today(),
      devsiteVersion: body.devsiteVersion ?? "",
    };
    save();
    sendJson(res, 200, state.projects[name]);
  };

  const stop = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const body = (await readBody(req)) as { port?: unknown } | null;
    if (typeof body?.port === "number") markNotLive(name, body.port);
    sendJson(res, 200, state.projects[name] ?? null);
  };

  const status = async (res: ServerResponse) => {
    await Promise.all(Object.values(state.projects).map(isLive));
    const body: Status = {
      version: pkg.version,
      pid: process.pid,
      projects: state.projects,
      tailnetListeners: (tailnet?.ips ?? []).map((ip) => {
        const address = addressOf(ip, peersAt);
        const error = failedIps.get(ip);
        return error === undefined ? { address } : { address, error };
      }),
    };
    sendJson(res, 200, body);
  };

  const peers = async (res: ServerResponse) => {
    const tailnet = await readTailnet(env);
    const list = await Promise.all(
      (tailnet?.peers ?? []).map(async (peer: Peer): Promise<PeerState> => {
        const answer = await askPeer(peer, peersAt, "/hello");
        if (answer.state === "other-protocol") {
          return { mac: peer.mac, state: "other-protocol", protocol: answer.protocol };
        }
        return {
          mac: peer.mac,
          state: answer.state === "answer" ? "same-protocol" : answer.state,
        };
      }),
    );
    sendJson(res, 200, list);
  };

  const api = async (req: IncomingMessage, res: ServerResponse) => {
    const { url, parts } = routeOf(req);
    const name = parts[1]?.toLowerCase();
    if (req.method === "GET" && url.pathname === "/status") return status(res);
    if (req.method === "GET" && url.pathname === "/peers") return peers(res);
    // Caddy asks here before it signs a certificate for a name at its first TLS handshake, so a LAN host cannot make it sign one per name it sends.
    if (req.method === "GET" && url.pathname === "/tls-allowed") {
      // A name another Mac knows passes too: the phone reaches every Mac's projects through the main Mac.
      const asked = projectOf(url.searchParams.get("domain") ?? "");
      const known =
        asked !== null &&
        (state.projects[asked] !== undefined ||
          (await askPeersUntilLive(asked, tailnet?.peers ?? [])).records.length > 0);
      res.writeHead(known ? 200 : 403);
      return res.end();
    }
    if (parts[0] === "projects" && name !== undefined && NAME_RE.test(name)) {
      if (req.method === "PUT" && parts.length === 2) return register(req, res, name);
      if (req.method === "POST" && parts.length === 3 && parts[2] === "stop") {
        return stop(req, res, name);
      }
    }
    sendJson(res, 404, { error: `no ${req.method} ${url.pathname}` });
  };

  // The port listen() binds; it differs from `port` only when that is 0.
  let boundPort = port;

  const server = createServer((req, res) => {
    const name = projectOf(req.headers.host);
    if (name !== null) {
      proxy(req, res, name).catch((err) => {
        console.error(`devsite node: ${req.headers.host}${req.url}: ${(err as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
      return;
    }
    if (isApi(req, boundPort)) {
      api(req, res).catch((err) => {
        console.error(`devsite node: ${req.method} ${req.url}: ${(err as Error).message}`);
        if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
      });
      return;
    }
    res.writeHead(421, { "content-type": "text/plain" });
    res.end("devsite node: no project at this host\n");
  });

  // An upgraded socket leaves the server's connection list, so close() would wait on it forever.
  const tunnels = new Set<Socket>();

  // HMR: Vite's WebSocket goes through as raw bytes once the upgrade request reaches the dev server.
  server.on("upgrade", (req: IncomingMessage, socket: Socket, head: Buffer) => {
    tunnels.add(socket);
    socket.once("close", () => tunnels.delete(socket));
    const name = projectOf(req.headers.host);
    const p = name === null ? undefined : state.projects[name];
    if (name === null || p === undefined || !p.live) {
      const refuse = () =>
        socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      if (name === null || req.headers[RELAYED_HEADER] !== undefined) return refuse();
      findLive(name)
        .then(async ({ live }) => {
          if (live === null) return refuse();
          const failure = await relay.tunnel(req, socket, head, live);
          if (failure === null) return;
          livePeers.delete(name);
          // A browser shows no text for a refused WebSocket, so the reason goes to the log.
          console.error(relay.explain(failure, req.headers.host ?? "", live).trimEnd());
          refuse();
        })
        .catch(refuse);
      return;
    }
    const target = p.port;
    const up = connect({ host: "127.0.0.1", port: target }, () => {
      up.write(requestHead(req));
      if (head.length > 0) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => {
      markNotLive(name, target);
      socket.destroy();
    });
    socket.on("error", () => up.destroy());
  });

  await listen(server, port, "127.0.0.1");
  const a = server.address();
  if (typeof a === "object" && a !== null) boundPort = a.port;
  peersAt = peerPort ?? boundPort;

  // Another node's call: only from a device of this Mac's Tailscale user, and never a request for a dev server, which other devices reach through Caddy and its LAN guard.
  const answerPeer = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader(PROTOCOL_HEADER, String(PROTOCOL));
    const from = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
    const user = await whoisUser(from, env);
    if (tailnet === null || user !== tailnet.user) {
      return sendJson(res, 403, { error: "only a device of this Mac's Tailscale user" });
    }
    if (req.headers[PROTOCOL_HEADER] !== String(PROTOCOL)) {
      return sendJson(res, 400, { error: `this node speaks protocol ${PROTOCOL}` });
    }
    const { url, parts } = routeOf(req);
    if (req.method === "GET" && url.pathname === "/hello") return sendJson(res, 200, {});
    const name = parts[1]?.toLowerCase();
    if (
      req.method === "GET" &&
      parts[0] === "projects" &&
      parts.length === 2 &&
      name !== undefined
    ) {
      const p = NAME_RE.test(name) ? state.projects[name] : undefined;
      const project: PeerProject | null =
        p === undefined
          ? null
          : {
              folder: shownFolder(p.folder),
              live: await isLive(p),
              project: p.project,
              lastUsed: p.lastUsed,
            };
      return sendJson(res, 200, { project });
    }
    sendJson(res, 404, { error: `no ${req.method} ${url.pathname}` });
  };

  let refreshing = false;

  const refresh = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      tailnet = await readTailnet(env);
      const wanted = new Set(tailnet?.ips ?? []);
      for (const ip of failedIps.keys()) if (!wanted.has(ip)) failedIps.delete(ip);
      for (const [ip, s] of peerServers) {
        if (wanted.has(ip)) continue;
        stopServer(s);
        peerServers.delete(ip);
      }
      for (const ip of wanted) {
        if (peerServers.has(ip)) continue;
        const s = createServer((req, res) => {
          answerPeer(req, res).catch((err) => {
            console.error(`devsite node: peer ${req.method} ${req.url}: ${(err as Error).message}`);
            if (!res.headersSent) sendJson(res, 500, { error: "internal error" });
          });
        });
        try {
          await listen(s, peersAt, ip);
          peerServers.set(ip, s);
          failedIps.delete(ip);
        } catch (err) {
          if (!failedIps.has(ip)) {
            console.error(
              `devsite node: cannot listen on ${ip}:${peersAt}: ${(err as Error).message}`,
            );
          }
          failedIps.set(ip, String((err as NodeJS.ErrnoException).code ?? "error"));
        }
      }
    } finally {
      refreshing = false;
    }
  };
  await refresh();
  const timer = setInterval(refresh, Number(env.DEVSITE_TAILNET_REFRESH_MS) || TAILNET_REFRESH_MS);
  timer.unref();

  return {
    port: boundPort,
    close: async () => {
      clearInterval(timer);
      for (const s of peerServers.values()) stopServer(s);
      await new Promise<void>((resolve) => {
        for (const s of tunnels) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      });
    },
  };
}

function stopServer(s: Server) {
  s.closeAllConnections();
  s.close();
}

function routeOf(req: IncomingMessage) {
  const url = new URL(req.url ?? "/", "http://node");
  return { url, parts: url.pathname.split("/").filter((s) => s !== "") };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
