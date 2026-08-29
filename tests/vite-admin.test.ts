// The Vite plugin's route registration against a real local mock of the
// Caddy admin API (#28). The mock mirrors Caddy's contract: any request
// without an Origin header is 403'd — so a refactor that silently loses the
// pinned header fails every test here, not one assertion. Tests point the
// plugin at the mock via DEVSITE_CADDY_ADMIN (the env seam this suite
// exists to cover).
import { expect, spyOn, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { COULD_NOT_RECORD, COULD_NOT_REGISTER, caddy, devsite } from "../src/vite.mjs";
import {
  fakeViteServer,
  makeStateDir,
  makeViteRoot,
  viteConfigHook,
  viteConfigureServerHook,
} from "./helpers";

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

// The stamp is fire-and-forget, so it can land after registration logs its
// outcome — poll until the condition holds.
async function pollFor(cond: () => boolean, what: string) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > 3000) throw new Error(`${what} never happened`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// Drive the plugin end to end: config hook, then configureServer with a fake
// bound server, then wait until registration logged its outcome. The wait is
// registration-specific on purpose: the fire-and-forget stamp can log its
// "could not record" warn first, and that must not end the wait early.
async function registerViaPlugin(port: number) {
  const root = makeViteRoot({ name: "web", devSite: { host: HOST } });
  const plugin = devsite();
  await viteConfigHook(plugin)({ root }, { command: "serve", mode: "development" });

  const fake = fakeViteServer(port);
  viteConfigureServerHook(plugin)(fake.server as never);
  fake.httpServer.emit("listening");

  await pollFor(
    () => fake.infos.length > 0 || fake.warns.some((w) => w.includes(COULD_NOT_REGISTER)),
    "registration",
  );
  return { infos: fake.infos, warns: fake.warns };
}

// tests/setup.ts defaults DEVSITE_STATE_DIR to a shared scratch dir; suites
// that assert on the stamp re-point it here per test.
function withStateDir<T>(dir: string, fn: () => Promise<T>) {
  return withEnv("DEVSITE_STATE_DIR", dir, fn);
}

// The stamp file's content; undefined before the first write. stampLastUsed
// writes atomically (write + rename), so a reader never sees a partial file —
// a SyntaxError here is a real regression and propagates.
function readStamps(dir: string): Record<string, string> | undefined {
  try {
    return JSON.parse(readFileSync(join(dir, "last-used.json"), "utf8"));
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }
}

test("a dev-server start stamps the host's last-used date", async () => {
  const mock = await startMockCaddy({
    servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } },
  });
  const stateDir = makeStateDir();
  try {
    const before = new Date().toISOString().slice(0, 10);
    await withAdmin(mock.url, () => withStateDir(stateDir, () => registerViaPlugin(50223)));
    await pollFor(() => readStamps(stateDir) !== undefined, "stamp write");
    const after = new Date().toISOString().slice(0, 10);
    const stamp = readStamps(stateDir)?.[HOST];
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
    await pollFor(() => readStamps(stateDir)?.[HOST] !== "2001-01-01", "stamp update");
    const stamps = readStamps(stateDir);
    if (!stamps) throw new Error("stamp file disappeared");
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
    expect(infos.join("\n")).toContain(`https://${HOST} → localhost:50225`);
    await pollFor(() => warns.join("\n").includes(COULD_NOT_RECORD), "stamp warning");
    expect(warns.join("\n")).toContain(COULD_NOT_RECORD);
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
    expect(warns.join("\n")).toContain(COULD_NOT_REGISTER);
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
    expect(warns.join("\n")).toContain(COULD_NOT_REGISTER);
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
    expect(warns.join("\n")).toContain(COULD_NOT_REGISTER);
    // The 500 from the write, specifically — a 403 (lost Origin) must not
    // satisfy this test.
    expect(warns.join("\n")).toContain("HTTP 500");
  } finally {
    await mock.close();
  }
});

test("the pinned Origin wins over a caller-supplied Origin header, any casing", async () => {
  const mock = await startMockCaddy();
  try {
    await withAdmin(mock.url, async () => {
      // Capitalized on purpose: a plain object spread is case-sensitive and
      // would keep both keys, sending "http://evil.example, <admin>".
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
    // The double cast bridges Bun's `typeof fetch` (it carries a `preconnect`
    // static no plain function can satisfy).
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
