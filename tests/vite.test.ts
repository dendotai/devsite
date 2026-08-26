// The plugin's config hook, in-process. Contract: no devSite host at the Vite
// root — including no package.json at all — means "do nothing".
import { afterEach, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { devsite } from "../src/vite.mjs";
import { fakeViteServer, makeViteRoot, viteConfigHook, viteConfigureServerHook } from "./helpers";

const ENV = { command: "serve", mode: "development" } as const;

test("no package.json at the Vite root: no-op instead of an ENOENT crash", () => {
  const plugin = devsite();
  expect(viteConfigHook(plugin).call(plugin, { root: makeViteRoot() }, ENV)).toBeUndefined();
});

test("unparseable package.json: no-op", () => {
  const root = makeViteRoot();
  writeFileSync(join(root, "package.json"), "not json {");
  const plugin = devsite();
  expect(viteConfigHook(plugin).call(plugin, { root }, ENV)).toBeUndefined();
});

test("package.json without a devSite host: no-op", () => {
  const plugin = devsite();
  const result = viteConfigHook(plugin).call(plugin, { root: makeViteRoot({ name: "x" }) }, ENV);
  expect(result).toBeUndefined();
});

test("devSite.host present: Vite binds an OS-assigned port (port 0) for that host", async () => {
  const plugin = devsite();
  const result = await viteConfigHook(plugin).call(
    plugin,
    { root: makeViteRoot({ name: "web", devSite: { host: "web.test.internal" } }) },
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
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (init?.method === "PATCH") return new Response("{}", { status: 200 });
    // GET /config/apps/http/servers — one server already routing our host.
    return Response.json({
      srv0: {
        listen: [":443"],
        routes: [{ match: [{ host: ["web.test.internal"] }] }],
      },
    });
  });

  const plugin = devsite();
  await viteConfigHook(plugin).call(
    plugin,
    { root: makeViteRoot({ name: "web", devSite: { host: "web.test.internal" } }) },
    ENV,
  );

  const fake = fakeViteServer(54321);
  viteConfigureServerHook(plugin).call(plugin, fake.server as never);
  fake.httpServer.emit("listening");
  // registerRoute is async; let its fetches settle.
  await new Promise((r) => setTimeout(r, 0));

  const patch = fetchSpy.mock.calls.find(([, init]) => init?.method === "PATCH");
  expect(patch).toBeDefined();
  expect(String(patch?.[1]?.body)).toContain("localhost:54321");
  expect([...fake.infos, ...fake.warns].join("\n")).toContain(
    "https://web.test.internal → localhost:54321",
  );
});
