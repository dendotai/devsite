// The Vite plugin's route registration against a real local mock of the Caddy admin API (#28). The mock mirrors Caddy's contract: any request without an Origin header is 403'd — so a refactor that silently loses the pinned header fails every test here, not one assertion. Tests point the plugin at the mock via DEVSITE_CADDY_ADMIN (the env seam this suite exists to cover).
import { expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { renderGuardFile, renderHostFile } from "../src/commands/init";
import { portFilePath } from "../src/state.mjs";
import { caddy, devsite } from "../src/vite.mjs";
import {
  fakeViteServer,
  makeStateDir,
  makeViteRoot,
  viteConfigHook,
  viteConfigureServerHook,
} from "./helpers";
import { writeOfflineFragment } from "./machine";

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
  // Simulated failures: the config read, or the route write, answers 500.
  failConfig?: boolean;
  failWrite?: boolean;
};

// A real HTTP server posing as Caddy's admin API. Caddy 403s admin requests whose Origin it can't verify; the mock enforces the same before anything else, so the pinned header is load-bearing for every test in this file.
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
      if (req.method === "PATCH") {
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
    close: () => {
      // Drop any keep-alive connections first so close() cannot hang teardown.
      server.closeAllConnections();
      return new Promise((r) => server.close(r));
    },
  };
}

async function withEnv<T>(name: string, value: string | undefined, fn: () => Promise<T>) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}

function withAdmin<T>(url: string | undefined, fn: () => Promise<T>) {
  return withEnv("DEVSITE_CADDY_ADMIN", url, fn);
}

// Drive the plugin end to end: config hook, then configureServer with a fake bound server, then await the plugin's settled signal — route registration and the last-used stamp have both finished (logged, wrote, or warned) when it resolves, so no assertion below needs to poll.
async function registerViaPlugin(port: number) {
  const root = makeViteRoot({ name: "web", devSite: { name: HOST.replace(/\.internal$/, "") } });
  const plugin = devsite();
  await viteConfigHook(plugin)({ root }, { command: "serve", mode: "development" });

  const fake = fakeViteServer(port);
  viteConfigureServerHook(plugin)(fake.server as never);
  fake.httpServer.emit("listening");

  await plugin.api.settled;
  return { infos: fake.infos, warns: fake.warns, httpServer: fake.httpServer };
}

// tests/setup.ts defaults DEVSITE_STATE_DIR to a shared scratch dir; suites that assert on the stamp re-point it here per test.
function withStateDir<T>(dir: string, fn: () => Promise<T>) {
  return withEnv("DEVSITE_STATE_DIR", dir, fn);
}

function readStamps(dir: string): Record<string, string> {
  return JSON.parse(readFileSync(join(dir, "last-used.json"), "utf8"));
}

test("a dev-server start stamps the host's last-used date", async () => {
  const mock = await startMockCaddy({
    servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } },
  });
  const stateDir = makeStateDir();
  try {
    const before = new Date().toISOString().slice(0, 10);
    await withAdmin(mock.url, () => withStateDir(stateDir, () => registerViaPlugin(50223)));
    const after = new Date().toISOString().slice(0, 10);
    const stamp = readStamps(stateDir)[HOST];
    if (!stamp) throw new Error(`no entry for ${HOST} in the stamp file`);
    // Either side of a midnight rollover during the test run is a pass.
    expect([before, after]).toContain(stamp);
  } finally {
    await mock.close();
  }
});

test("repeated starts update the entry; other hosts' entries are preserved", async () => {
  const mock = await startMockCaddy({
    servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } },
  });
  const stateDir = makeStateDir();
  writeFileSync(
    join(stateDir, "last-used.json"),
    JSON.stringify({ [HOST]: "2001-01-01", "other.test.internal": "2002-02-02" }),
  );
  try {
    await withAdmin(mock.url, () => withStateDir(stateDir, () => registerViaPlugin(50224)));
    const stamps = readStamps(stateDir);
    expect(stamps["other.test.internal"]).toBe("2002-02-02");
    expect(stamps[HOST]).not.toBe("2001-01-01");
  } finally {
    await mock.close();
  }
});

test("a stamp write failure warns and does not break route registration", async () => {
  const mock = await startMockCaddy({
    servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } },
  });
  // A state "dir" nested under a plain file: mkdir fails with ENOTDIR.
  const blocker = join(makeStateDir(), "not-a-dir");
  writeFileSync(blocker, "");
  try {
    const { infos, warns } = await withAdmin(mock.url, () =>
      withStateDir(join(blocker, "devsite"), () => registerViaPlugin(50225)),
    );
    // Route registration succeeded regardless.
    expect(infos.join("\n")).toContain(
      `https://${HOST} and https://${HOST.replace(/\.internal$/, ".localhost")} → 127.0.0.1:50225`,
    );
    expect(warns.join("\n")).toContain("could not record");
  } finally {
    await mock.close();
  }
});

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
    expect(infos.join("\n")).toContain(
      `https://${HOST} and https://${HOST.replace(/\.internal$/, ".localhost")} → 127.0.0.1:50123`,
    );

    const patch = mock.requests.find((r) => r.method === "PATCH");
    if (!patch) throw new Error("no PATCH reached the mock");
    expect(patch.path).toBe("/config/apps/http/servers/srv0/routes/0");
    expect(patch.body).toContain("127.0.0.1:50123");
    // The pin rode along even though the caller supplied its own headers
    // (content-type is set by the PATCH call itself).
    expect(patch.headers.origin).toBe(mock.url);
    expect(patch.headers["content-type"]).toBe("application/json");
  } finally {
    await mock.close();
  }
});

test("the swapped-in route aborts a request from outside this Mac and the tailnet before it proxies", async () => {
  const mock = await startMockCaddy({
    servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } },
  });
  try {
    await withAdmin(mock.url, () => registerViaPlugin(50123));
    const patch = mock.requests.find((r) => r.method === "PATCH");
    if (!patch) throw new Error("no PATCH reached the mock");
    const [sub] = JSON.parse(patch.body).handle;
    expect(sub.handler).toBe("subroute");
    const [guard, proxy] = sub.routes;
    expect(guard).toEqual({
      match: [{ not: [{ remote_ip: { ranges: ["127.0.0.1", "::1", "100.64.0.0/10"] } }] }],
      handle: [{ handler: "static_response", abort: true }],
    });
    expect(proxy.handle).toEqual([
      { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:50123" }] },
    ]);
  } finally {
    await mock.close();
  }
});

test("a host `devsite init` never registered: a warning naming the host and `devsite doctor`, and no route write", async () => {
  const mock = await startMockCaddy({
    servers: {
      srv0: { listen: [":443"], routes: [{ match: [{ host: ["someone.else.internal"] }] }] },
    },
  });
  try {
    const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50124));
    expect(infos).toEqual([]);
    expect(warns.join("\n")).toContain(`no Caddy route for ${HOST}`);
    expect(warns.join("\n")).toContain("run `bunx devsite doctor`");
    expect(mock.requests.filter((r) => r.method !== "GET")).toEqual([]);
  } finally {
    await mock.close();
  }
});

test("the admin API does not answer: a warning that says so and names `devsite doctor`", async () => {
  const mock = await startMockCaddy();
  await mock.close();
  const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50128));
  expect(infos).toEqual([]);
  expect(warns.join("\n")).toContain("could not register");
  expect(warns.join("\n")).toContain(
    "the Caddy admin API does not answer — run `bunx devsite doctor`",
  );
});

test("config read answers an error status: a warning with the status and `devsite doctor`", async () => {
  const mock = await startMockCaddy({ failConfig: true });
  try {
    const { infos, warns } = await withAdmin(mock.url, () => registerViaPlugin(50125));
    expect(infos).toEqual([]);
    expect(warns.join("\n")).toContain("could not register");
    expect(warns.join("\n")).toContain("HTTP 500");
    expect(warns.join("\n")).toContain("run `bunx devsite doctor`");
    expect(warns.join("\n")).not.toContain("does not answer");
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
    // The 500 from the write, specifically — a 403 (lost Origin) must not satisfy this test.
    expect(warns.join("\n")).toContain("HTTP 500");
    expect(warns.join("\n")).not.toContain("is the Caddy service running");
  } finally {
    await mock.close();
  }
});

test("the pinned Origin wins over a caller-supplied Origin header, any casing", async () => {
  const mock = await startMockCaddy();
  try {
    await withAdmin(mock.url, async () => {
      // Capitalized on purpose: a plain object spread is case-sensitive and would keep both keys, sending "http://evil.example, <admin>".
      const res = await caddy("/config/apps/http/servers", {
        headers: { Origin: "http://evil.example", "x-extra": "kept" },
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

test("a Headers-instance caller keeps its headers; the pin still wins", async () => {
  const mock = await startMockCaddy();
  try {
    await withAdmin(mock.url, async () => {
      const res = await caddy("/config/apps/http/servers", {
        headers: new Headers({ origin: "http://evil.example", "x-extra": "kept" }),
      });
      expect(res.status).toBe(200);
    });
    const req = mock.requests[0];
    if (!req) throw new Error("nothing reached the mock");
    expect(req.headers.origin).toBe(mock.url);
    expect(req.headers["x-extra"]).toBe("kept");
  } finally {
    await mock.close();
  }
});

test("without the env override, the admin endpoint is the local default", async () => {
  await withAdmin(undefined, async () => {
    // The double cast bridges Bun's `typeof fetch` (it carries a `preconnect` static no plain function can satisfy).
    const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async () =>
      Response.json({})) as unknown as typeof fetch);
    let seen: string[];
    try {
      await caddy("/config/apps/http/servers");
      // Read before mockRestore — restoring also clears the recorded calls.
      seen = fetchSpy.mock.calls.map(([url]) => String(url));
    } finally {
      fetchSpy.mockRestore();
    }
    expect(seen).toEqual(["http://localhost:2019/config/apps/http/servers"]);
  });
});

// The route init leaves for the host, which the plugin PATCHes on start.
const HOST_ROUTE = { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } };

test("a start writes the live port to the port file; a stop writes the placeholder back and keeps the file", async () => {
  const mock = await startMockCaddy({ servers: HOST_ROUTE });
  const stateDir = makeStateDir();
  try {
    const { httpServer } = await withAdmin(mock.url, () =>
      withStateDir(stateDir, () => registerViaPlugin(50310)),
    );
    const portFile = portFilePath(HOST, stateDir);
    expect(readFileSync(portFile, "utf8")).toBe("reverse_proxy 127.0.0.1:50310\n");
    await withStateDir(stateDir, async () => httpServer.emit("close"));
    expect(existsSync(portFile)).toBe(true);
    expect(readFileSync(portFile, "utf8")).toBe("error 503\n");
  } finally {
    await mock.close();
  }
});

test("Ctrl-C writes the placeholder back, and a stop leaves no signal listener behind", async () => {
  const mock = await startMockCaddy({ servers: HOST_ROUTE });
  const stateDir = makeStateDir();
  // The plugin exits after Ctrl-C; the stub keeps the test run alive and records the code.
  const exit = spyOn(process, "exit").mockImplementation((() => {}) as never);
  // The earlier tests' starts never close, so their listeners stay; only this start's are compared.
  const before = { SIGINT: process.listeners("SIGINT"), SIGHUP: process.listeners("SIGHUP") };
  const added = (signal: "SIGINT" | "SIGHUP") =>
    process.listeners(signal).filter((l) => !before[signal].includes(l));
  try {
    const { httpServer } = await withAdmin(mock.url, () =>
      withStateDir(stateDir, () => registerViaPlugin(50311)),
    );
    expect(added("SIGINT")).toHaveLength(1);
    expect(added("SIGHUP")).toHaveLength(1);
    await withStateDir(stateDir, async () => process.emit("SIGINT", "SIGINT"));
    expect(readFileSync(portFilePath(HOST, stateDir), "utf8")).toBe("error 503\n");
    expect(exit).toHaveBeenCalledWith(130);
    await withStateDir(stateDir, async () => httpServer.emit("close"));
    expect(added("SIGINT")).toEqual([]);
    expect(added("SIGHUP")).toEqual([]);
  } finally {
    exit.mockRestore();
    await mock.close();
  }
});

// `caddy reload` adapts the Caddyfile and loads the result, so the route a reload gives the host is the route `caddy adapt` makes of devsite's files.
function reloadedUpstream(stateDir: string): unknown {
  const caddyfile = join(makeStateDir(), "Caddyfile");
  writeOfflineFragment(dirname(caddyfile));
  writeFileSync(
    caddyfile,
    renderGuardFile() +
      renderHostFile({ host: HOST, project: "web" }, portFilePath(HOST, stateDir)),
  );
  const r = spawnSync("caddy", ["adapt", "--config", caddyfile, "--adapter", "caddyfile"], {
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`caddy adapt failed: ${r.stderr}`);
  const config = JSON.parse(r.stdout);
  const route = Object.values(config.apps.http.servers as Record<string, { routes: object[] }>)
    .flatMap((srv) => srv.routes)
    .find((rt) => JSON.stringify(rt).includes(HOST));
  // The handler after the LAN guard in the host's subroute.
  return (route as { handle: { routes: { handle: unknown[] }[] }[] }).handle[0]?.routes[1]
    ?.handle[0];
}

test("a Caddy reload after a start keeps the live port; after a stop it gives the placeholder", async () => {
  const mock = await startMockCaddy({ servers: HOST_ROUTE });
  const stateDir = makeStateDir();
  try {
    const { httpServer } = await withAdmin(mock.url, () =>
      withStateDir(stateDir, () => registerViaPlugin(50312)),
    );
    expect(reloadedUpstream(stateDir)).toEqual({
      handler: "reverse_proxy",
      upstreams: [{ dial: "127.0.0.1:50312" }],
    });
    await withStateDir(stateDir, async () => httpServer.emit("close"));
    expect(reloadedUpstream(stateDir)).toEqual({ handler: "error", status_code: 503 });
  } finally {
    await mock.close();
  }
});
