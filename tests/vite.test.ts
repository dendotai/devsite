// The plugin's config hook, in-process. Contract: no devSite host at the Vite root — including no package.json at all — means "do nothing".
import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { devsite } from "../src/vite.mjs";
import { fakeViteServer, makeViteRoot, viteConfigHook, viteConfigureServerHook } from "./helpers";

const ENV = { command: "serve", mode: "development" } as const;

test("no package.json at the Vite root: no-op instead of an ENOENT crash", () => {
  const plugin = devsite();
  expect(viteConfigHook(plugin)({ root: makeViteRoot() }, ENV)).toBeUndefined();
});

test("unparseable package.json: no-op", () => {
  const root = makeViteRoot();
  writeFileSync(join(root, "package.json"), "not json {");
  const plugin = devsite();
  expect(viteConfigHook(plugin)({ root }, ENV)).toBeUndefined();
});

test("package.json without a devSite name: no-op", () => {
  const plugin = devsite();
  const result = viteConfigHook(plugin)({ root: makeViteRoot({ name: "x" }) }, ENV);
  expect(result).toBeUndefined();
});

test("the old devSite.host field stops the dev server with the field that replaced it", () => {
  const plugin = devsite();
  expect(() =>
    viteConfigHook(plugin)(
      { root: makeViteRoot({ name: "web", devSite: { host: "web.test.internal" } }) },
      ENV,
    ),
  ).toThrow("devSite.name");
});

test("devSite.name present: Vite binds an OS-assigned port (port 0) for that host", async () => {
  const plugin = devsite();
  const result = await viteConfigHook(plugin)(
    { root: makeViteRoot({ name: "web", devSite: { name: "web.test" } }) },
    ENV,
  );
  expect(result?.server?.allowedHosts).toEqual(["web.test.internal"]);
  expect(result?.server?.port).toBe(0);
  expect(result?.server?.strictPort).toBeUndefined();
});

// Listen-time registration: the port Caddy is told about must be the one the server actually bound, read from httpServer.address() — never a pre-picked number. fetch is stubbed so no real Caddy admin API is touched.
afterEach(() => {
  (globalThis.fetch as { mockRestore?: () => void }).mockRestore?.();
});

test("on listening, one route serves both the .internal and the .localhost host", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit,
  ) => {
    if (init?.method === "PATCH") return new Response("{}", { status: 200 });
    return Response.json({
      srv0: { listen: [":443"], routes: [{ match: [{ host: ["web.test.internal"] }] }] },
    });
  }) as unknown as typeof fetch);

  const plugin = devsite();
  await viteConfigHook(plugin)(
    { root: makeViteRoot({ name: "web", devSite: { name: "web.test" } }) },
    ENV,
  );
  const fake = fakeViteServer(54321);
  viteConfigureServerHook(plugin)(fake.server as never);
  fake.httpServer.emit("listening");
  await plugin.api.settled;

  const writes = fetchSpy.mock.calls.filter(([, init]) => init?.method);
  expect(writes).toHaveLength(1);
  const route = JSON.parse(String(writes[0]?.[1]?.body));
  expect(route.match[0].host).toEqual(["web.test.internal", "web.test.localhost"]);
  expect(String(writes[0]?.[1]?.body)).toContain("localhost:54321");
});

test("a devSite.name that keeps the old .internal suffix is refused with the bare name", () => {
  const plugin = devsite();
  expect(() =>
    viteConfigHook(plugin)(
      { root: makeViteRoot({ name: "web", devSite: { name: "web.internal" } }) },
      ENV,
    ),
  ).toThrow('write "web"');
});

test("a devSite.name that is not a string is refused", () => {
  const plugin = devsite();
  expect(() =>
    viteConfigHook(plugin)({ root: makeViteRoot({ name: "web", devSite: { name: 42 } }) }, ENV),
  ).toThrow("not a plain hostname");
});

test("a mixed-case devSite.name matches the lowercase route Caddy holds", async () => {
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (
    _url: unknown,
    init?: RequestInit,
  ) => {
    if (init?.method) return new Response("{}", { status: 200 });
    return Response.json({
      srv0: { listen: [":443"], routes: [{ match: [{ host: ["web.test.internal"] }] }] },
    });
  }) as unknown as typeof fetch);
  const plugin = devsite();
  await viteConfigHook(plugin)(
    { root: makeViteRoot({ name: "web", devSite: { name: "Web.Test" } }) },
    ENV,
  );
  const fake = fakeViteServer(54321);
  viteConfigureServerHook(plugin)(fake.server as never);
  fake.httpServer.emit("listening");
  await plugin.api.settled;
  expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
});

test("a devSite.name that is not a plain hostname stops the dev server", () => {
  const plugin = devsite();
  expect(() =>
    viteConfigHook(plugin)(
      { root: makeViteRoot({ name: "web", devSite: { name: "my app" } }) },
      ENV,
    ),
  ).toThrow("not a plain hostname");
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
    // Bun's `typeof fetch` carries a `preconnect` static no plain function can satisfy — hence the double cast.
  }) as unknown as typeof fetch);

  const plugin = devsite();
  await viteConfigHook(plugin)(
    { root: makeViteRoot({ name: "web", devSite: { name: "web.test" } }) },
    ENV,
  );

  const fake = fakeViteServer(54321);
  viteConfigureServerHook(plugin)(fake.server as never);
  fake.httpServer.emit("listening");
  // registerRoute is async; let its fetches settle.
  await new Promise((r) => setTimeout(r, 0));

  const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patch).toBeDefined();
  expect(String(patch?.[1]?.body)).toContain("localhost:54321");
  expect([...fake.infos, ...fake.warns].join("\n")).toContain(
    "https://web.test.internal and https://web.test.localhost → localhost:54321",
  );
});
