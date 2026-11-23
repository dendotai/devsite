// The node (ADR 0005): the devsite server that stays on, one per Mac. Caddy proxies every `*.internal` and `*.localhost` request here, and the node sends it to the project's dev server or answers the offline page; clients register projects through its API on the same port.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { connect, type Socket } from "node:net";
import { hostname } from "node:os";
import { dirname } from "node:path";
// bun-types types every .html import as an HTMLBundle for Bun.serve; the text attribute gives the file's text, which `bun build` inlines into dist, so the package ships no asset file.
import offlinePage from "../../assets/offline.html" with { type: "text" };
import pkg from "../../package.json";
import { NAME_RE } from "../names.mjs";
import { type PathsEnv, stateFile } from "../paths";

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

export type Status = {
  version: string;
  pid: number;
  projects: Record<string, Project>;
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

export function renderOfflinePage(host: string, p: Project | undefined): string {
  const facts =
    p === undefined
      ? `<p>No project named <em class="host">${html(host.replace(/\.[a-z]+$/, ""))}</em> has run on this Mac.</p>`
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
    .replaceAll("__STATUS_CODE__", p === undefined ? "404" : "503")
    .replace("__FACTS__", facts);
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = "";
  for await (const chunk of req) text += chunk;
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

// The API answers only a request sent to the node's own address, so a web page that rebinds its DNS name to 127.0.0.1 reaches none of it.
function isApi(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

const today = () => new Date().toISOString().slice(0, 10);

export type NodeOptions = { port: number; env: PathsEnv };
export type RunningNode = { port: number; close: () => Promise<void> };

export async function startNode({ port, env }: NodeOptions): Promise<RunningNode> {
  const file = stateFile(env);
  const state = readState(file);
  const mac = hostname().replace(/\.local$/, "");
  const save = () => writeState(file, state);

  // A dev server that stopped with no stop request (Ctrl-C, a crash) is found here, at the first request that cannot reach it.
  const markDown = (name: string, deadPort: number) => {
    const p = state.projects[name];
    if (p?.live && p.port === deadPort) {
      p.live = false;
      save();
    }
  };

  const offline = (res: ServerResponse, host: string, name: string) => {
    const p = state.projects[name];
    res.writeHead(p === undefined ? 404 : 503, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(renderOfflinePage(host, p));
  };

  const proxy = (req: IncomingMessage, res: ServerResponse, name: string) => {
    const p = state.projects[name];
    if (p === undefined || !p.live) return offline(res, req.headers.host ?? "", name);
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
    });
    up.on("error", () => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      markDown(name, target);
      offline(res, req.headers.host ?? "", name);
    });
    req.pipe(up);
  };

  const register = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const body = (await readBody(req)) as Partial<Project> | null;
    const port = body?.port;
    if (
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      typeof body?.folder !== "string"
    ) {
      return sendJson(res, 400, { error: "the body needs a port (1-65535) and a folder" });
    }
    // A port the OS gave a dead dev server can go to the next one: the project that held it is no longer live.
    for (const other of Object.values(state.projects)) {
      if (other.port === port) other.live = false;
    }
    state.projects[name] = {
      project: typeof body.project === "string" ? body.project : name,
      port,
      folder: body.folder,
      mac,
      live: true,
      lastUsed: today(),
      devsiteVersion: typeof body.devsiteVersion === "string" ? body.devsiteVersion : "",
    };
    save();
    sendJson(res, 200, state.projects[name]);
  };

  const stop = async (req: IncomingMessage, res: ServerResponse, name: string) => {
    const body = (await readBody(req)) as { port?: unknown } | null;
    if (typeof body?.port === "number") markDown(name, body.port);
    sendJson(res, 200, state.projects[name] ?? null);
  };

  const status = async (res: ServerResponse) => {
    // Live means the dev server answers now (GLOSSARY.md), so each live project is asked.
    const live = Object.entries(state.projects).filter(([, p]) => p.live);
    const answers = await Promise.all(live.map(([, p]) => probe(p.port)));
    let changed = false;
    live.forEach(([, p], i) => {
      if (!answers[i]) {
        p.live = false;
        changed = true;
      }
    });
    if (changed) save();
    const body: Status = { version: pkg.version, pid: process.pid, projects: state.projects };
    sendJson(res, 200, body);
  };

  const api = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://node");
    const parts = url.pathname.split("/").filter((s) => s !== "");
    const name = parts[1]?.toLowerCase();
    if (req.method === "GET" && url.pathname === "/status") return status(res);
    // Caddy asks here before it signs a certificate for a name at its first TLS handshake, so a LAN host cannot make it sign one per name it sends.
    if (req.method === "GET" && url.pathname === "/tls-allowed") {
      const asked = projectOf(url.searchParams.get("domain") ?? "");
      res.writeHead(asked !== null && state.projects[asked] !== undefined ? 200 : 403);
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

  const server = createServer((req, res) => {
    const name = projectOf(req.headers.host);
    if (name !== null) return proxy(req, res, name);
    if (isApi(req.headers.host, actualPort())) {
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
      socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      return;
    }
    const target = p.port;
    const up = connect({ host: "127.0.0.1", port: target }, () => {
      const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      }
      up.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on("error", () => {
      markDown(name, target);
      socket.destroy();
    });
    socket.on("error", () => up.destroy());
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const actualPort = () => {
    const a = server.address();
    return typeof a === "object" && a !== null ? a.port : port;
  };
  return {
    port: actualPort(),
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of tunnels) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
