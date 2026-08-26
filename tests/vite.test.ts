// The plugin's config hook, in-process. Contract: no devSite host at the Vite
// root — including no package.json at all — means "do nothing".
import { afterEach, expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devsite } from "../src/vite.mjs";

const ENV = { command: "serve", mode: "development" } as const;

function configHook(plugin: ReturnType<typeof devsite>) {
  const hook = plugin.config;
  if (typeof hook !== "function") throw new Error("config hook is not callable");
  // The hook never reads `this`; bind once so call sites stay plain (its
  // declared thisArg is Vite's ConfigPluginContext, which no test builds).
  return hook.bind(plugin as never);
}

function makeRoot(pkg?: object) {
  const root = mkdtempSync(join(tmpdir(), "devsite-vite-"));
  if (pkg !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}

test("no package.json at the Vite root: no-op instead of an ENOENT crash", () => {
  const plugin = devsite();
  expect(configHook(plugin)({ root: makeRoot() }, ENV)).toBeUndefined();
});

test("unparseable package.json: no-op", () => {
  const root = makeRoot();
  writeFileSync(join(root, "package.json"), "not json {");
  const plugin = devsite();
  expect(configHook(plugin)({ root }, ENV)).toBeUndefined();
});

test("package.json without a devSite host: no-op", () => {
  const plugin = devsite();
  const result = configHook(plugin)({ root: makeRoot({ name: "x" }) }, ENV);
  expect(result).toBeUndefined();
});

test("devSite.host present: Vite binds an OS-assigned port (port 0) for that host", async () => {
  const plugin = devsite();
  const result = await configHook(plugin)(
    { root: makeRoot({ name: "web", devSite: { host: "web.test.internal" } }) },
    ENV,
  );
  expect(result?.server?.allowedHosts).toEqual(["web.test.internal"]);
  expect(result?.server?.port).toBe(0);
  expect(result?.server?.strictPort).toBeUndefined();
});

// Listen-time registration: the port Caddy is told about must be the one the
// server actually bound, read from httpServer.address() — never a pre-picked
// number. fetch is stubbed so no real Caddy admin API is touched.
afterEach(() => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
});

test("on listening, the Caddy route gets the server's bound port", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit,
  ) => {
    if (init?.method === "PATCH") return new Response("{}", { status: 200 });
    // GET /config/apps/http/servers — one server already routing our host.
    return Response.json({
      srv0: {
        listen: [":443"],
        routes: [{ match: [{ host: ["web.test.internal"] }] }],
      },
    });
    // Bun's `typeof fetch` carries a `preconnect` static no plain function
    // can satisfy — hence the double cast.
  }) as unknown as typeof fetch);

  const plugin = devsite();
  await configHook(plugin)(
    { root: makeRoot({ name: "web", devSite: { host: "web.test.internal" } }) },
    ENV,
  );

  const httpServer = new EventEmitter() as EventEmitter & { address: () => { port: number } };
  httpServer.address = () => ({ port: 54321 });
  const logged: string[] = [];
  const server = {
    httpServer,
    config: {
      logger: { info: (m: string) => logged.push(m), warn: (m: string) => logged.push(m) },
    },
  };

  const hook = plugin.configureServer;
  if (typeof hook !== "function") throw new Error("configureServer hook is not callable");
  hook.call(plugin as never, server as never);
  httpServer.emit("listening");
  // registerRoute is async; let its fetches settle.
  await new Promise((r) => setTimeout(r, 0));

  const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patch).toBeDefined();
  expect(String(patch?.[1]?.body)).toContain("localhost:54321");
  expect(logged.join("\n")).toContain("https://web.test.internal → localhost:54321");
});
