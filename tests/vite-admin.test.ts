// The Vite plugin's route registration against a real local mock of the
// Caddy admin API (#28). The mock mirrors Caddy's contract: any request
// without an Origin header is 403'd — so a refactor that silently loses the
// pinned header fails every test here, not one assertion. Tests point the
// plugin at the mock via DEVSITE_CADDY_ADMIN (the env seam this suite
// exists to cover).
import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { caddy, devsite } from "../src/vite.mjs";

const HOST = "web.test.internal";

type Recorded = {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
};

type MockOpts = {
  // The JSON served for GET /config/apps/http/servers.
  servers?: unknown;
  // Simulated failures: the config read, or any route write, answers 500.
  failConfig?: boolean;
  failWrite?: boolean;
};

// A real HTTP server posing as Caddy's admin API. Caddy 403s admin requests
// whose Origin it can't verify; the mock enforces the same before anything
// else, so the pinned header is load-bearing for every test in this file.
async function startMockCaddy(opts: MockOpts = {}) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body,
      });
      if (!req.headers.origin) {
        res.statusCode = 403;
        res.end("origin required");
        return;
      }
      if (req.method === "GET" && req.url === "/config/apps/http/servers") {
        if (opts.failConfig) {
          res.statusCode = 500;
          res.end();
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(opts.servers ?? {}));
        return;
      }
      if (req.method === "PATCH" || req.method === "POST") {
        if (opts.failWrite) {
          res.statusCode = 500;
          res.end();
          return;
        }
        res.end("{}");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

// Point the plugin at the mock for the duration of fn; always restore.
async function withAdmin<T>(url: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.DEVSITE_CADDY_ADMIN;
  if (url === undefined) delete process.env.DEVSITE_CADDY_ADMIN;
  else process.env.DEVSITE_CADDY_ADMIN = url;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.DEVSITE_CADDY_ADMIN;
    else process.env.DEVSITE_CADDY_ADMIN = prev;
  }
}

// Drive the plugin end to end: config hook, then configureServer with a fake
// bound server, then wait until registration logged an outcome (info or warn).
async function registerViaPlugin(port: number) {
  const root = mkdtempSync(join(tmpdir(), "devsite-vite-admin-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "web", devSite: { host: HOST } }),
  );
  const plugin = devsite();
  const config = plugin.config;
  if (typeof config !== "function") throw new Error("config hook is not callable");
  await config.call(plugin, { root }, { command: "serve", mode: "development" });

  const httpServer = new EventEmitter() as EventEmitter & { address: () => { port: number } };
  httpServer.address = () => ({ port });
  const infos: string[] = [];
  const warns: string[] = [];
  const server = {
    httpServer,
    config: {
      logger: { info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m) },
    },
  };
  const hook = plugin.configureServer;
  if (typeof hook !== "function") throw new Error("configureServer hook is not callable");
  hook.call(plugin, server as never);
  httpServer.emit("listening");

  const start = Date.now();
  while (infos.length === 0 && warns.length === 0) {
    if (Date.now() - start > 3000) throw new Error("registration never settled");
    await new Promise((r) => setTimeout(r, 5));
  }
  return { infos, warns };
}

test("the mock mirrors Caddy: any request without an Origin header is 403", async () => {
  const mock = await startMockCaddy();
  try {
    // Bare fetch, not caddy() — undici sends no Origin on its own.
    const res = await fetch(`${mock.url}/config/apps/http/servers`);
    expect(res.status).toBe(403);
  } finally {
    await mock.close();
  }
});

test("existing route: the plugin PATCHes it to the bound port", async () => {
  const mock = await startMockCaddy({
    servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } },
  });
  try {
    const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50123));
    expect(warns).toEqual([]);
    expect(infos.join("\n")).toContain(`https://${HOST} → localhost:50123`);

    const patch = mock.requests.find((r) => r.method === "PATCH");
    if (!patch) throw new Error("no PATCH reached the mock");
    expect(patch.path).toBe("/config/apps/http/servers/srv0/routes/0");
    expect(patch.body).toContain("localhost:50123");
    // The pin rode along even though the caller supplied its own headers
    // (content-type is set by the PATCH call itself).
    expect(patch.headers.origin).toBe(mock.url);
    expect(patch.headers["content-type"]).toBe("application/json");
  } finally {
    await mock.close();
  }
});

test("unknown host: the plugin POST-appends to the :443 server", async () => {
  const mock = await startMockCaddy({
    servers: {
      other: { listen: [":8080"], routes: [] },
      https: { listen: [":443"], routes: [{ match: [{ host: ["someone.else.internal"] }] }] },
    },
  });
  try {
    const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50124));
    expect(warns).toEqual([]);
    expect(infos.join("\n")).toContain(`https://${HOST} → localhost:50124`);

    const post = mock.requests.find((r) => r.method === "POST");
    if (!post) throw new Error("no POST reached the mock");
    expect(post.path).toBe("/config/apps/http/servers/https/routes");
    expect(post.body).toContain(HOST);
    expect(post.body).toContain("localhost:50124");
    expect(post.headers.origin).toBe(mock.url);
  } finally {
    await mock.close();
  }
});

test("config fetch fails: a warning, and the dev server keeps running", async () => {
  const mock = await startMockCaddy({ failConfig: true });
  try {
    const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50125));
    expect(infos).toEqual([]);
    expect(warns.join("\n")).toContain("could not register");
    expect(warns.join("\n")).toContain("HTTP 500");
  } finally {
    await mock.close();
  }
});

test("no :443 server in the config: a warning pointing at `devsite init`", async () => {
  const mock = await startMockCaddy({ servers: { srv0: { listen: [":8080"], routes: [] } } });
  try {
    const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50126));
    expect(infos).toEqual([]);
    expect(warns.join("\n")).toContain("could not register");
    expect(warns.join("\n")).toContain("devsite init");
  } finally {
    await mock.close();
  }
});

test("write rejected: a warning, and the dev server keeps running", async () => {
  const mock = await startMockCaddy({
    servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } },
    failWrite: true,
  });
  try {
    const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50127));
    expect(infos).toEqual([]);
    expect(warns.join("\n")).toContain("could not register");
  } finally {
    await mock.close();
  }
});

test("the pinned Origin wins over a caller-supplied Origin header", async () => {
  const mock = await startMockCaddy();
  try {
    await withAdmin(mock.url, async () => {
      const res = await caddy("/config/apps/http/servers", {
        headers: { origin: "http://evil.example", "x-extra": "kept" },
      });
      expect(res.status).toBe(200);
    });
    const req = mock.requests[0];
    if (!req) throw new Error("nothing reached the mock");
    expect(req.headers.origin).toBe(mock.url);
    // Other caller headers still pass through — only the pin is enforced.
    expect(req.headers["x-extra"]).toBe("kept");
  } finally {
    await mock.close();
  }
});

test("without the env override, the admin endpoint is the local default", async () => {
  await withAdmin(undefined, async () => {
    const seen: string[] = [];
    const spy = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return Response.json({});
    }) as typeof fetch;
    try {
      await caddy("/config/apps/http/servers");
    } finally {
      globalThis.fetch = spy;
    }
    expect(seen).toEqual(["http://localhost:2019/config/apps/http/servers"]);
  });
});
