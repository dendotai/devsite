// The Vite plugin, a client of the node, through its Vite hooks: its requests go to a real test node, and a local HTTP server stands in for Vite's dev server.
import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { devsite } from "../src/vite.mjs";
import { fakeViteServer, makeViteRoot, viteConfigHook, viteConfigureServerHook } from "./helpers";
import { startDevServer, startTestNode, status, useNodes, viaNode } from "./node-helpers";

useNodes();

const ENV = { command: "serve", mode: "development" } as const;

const savedNode = process.env.DEVSITE_NODE;
afterEach(() => {
  process.env.DEVSITE_NODE = savedNode;
});

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

test("devSite.name present: Vite binds an OS-assigned port on loopback, and HMR comes back over wss on 443", async () => {
  const plugin = devsite();
  const result = await viteConfigHook(plugin)(
    { root: makeViteRoot({ name: "web", devSite: { name: "web" } }) },
    ENV,
  );
  expect(result?.server?.allowedHosts).toEqual(["web.internal"]);
  expect(result?.server?.port).toBe(0);
  expect(result?.server?.strictPort).toBeUndefined();
  // Only the node, on this Mac, connects to Vite; any other address puts the dev server on the local network.
  expect(result?.server?.host).toBe("127.0.0.1");
  expect(result?.server?.ws).toEqual({ protocol: "wss", clientPort: 443 });
});

// Runs the plugin's hooks for a Vite root as `bun dev` does, with the fake server bound to `port`.
async function start(pkg: object, port: number) {
  const root = makeViteRoot(pkg);
  const plugin = devsite();
  await viteConfigHook(plugin)({ root }, ENV);
  const fake = fakeViteServer(port);
  viteConfigureServerHook(plugin)(fake.server as never);
  fake.httpServer.emit("listening");
  await plugin.api.settled;
  return { root, fake };
}

test("on listening, the node gets the name, the bound port and the folder, and the project opens at both names", async () => {
  const node = await startTestNode();
  process.env.DEVSITE_NODE = node.url;
  const dev = await startDevServer();
  const { root, fake } = await start({ name: "@acme/web", devSite: { name: "web" } }, dev.port);
  expect((await status(node)).projects.web).toMatchObject({
    port: dev.port,
    folder: root,
    project: "@acme/web",
    live: true,
  });
  expect((await viaNode(node, "web.internal")).body).toStartWith("web /");
  expect((await viaNode(node, "web.localhost")).body).toStartWith("web /");
  expect(fake.infos).toEqual([
    `devsite: https://web.internal and https://web.localhost → 127.0.0.1:${dev.port}`,
  ]);
  expect(fake.warns).toEqual([]);
});

test("a mixed-case devSite.name registers the lowercase name", async () => {
  const node = await startTestNode();
  process.env.DEVSITE_NODE = node.url;
  const dev = await startDevServer();
  await start({ name: "web", devSite: { name: "Web" } }, dev.port);
  expect(Object.keys((await status(node)).projects)).toEqual(["web"]);
});

test("a stop of the dev server tells the node, so the project is no longer live", async () => {
  const node = await startTestNode();
  process.env.DEVSITE_NODE = node.url;
  const dev = await startDevServer();
  const { fake } = await start({ name: "web", devSite: { name: "web" } }, dev.port);
  fake.httpServer.emit("close");
  await new Promise((r) => setTimeout(r, 100));
  const page = await viaNode(node, "web.internal");
  expect(page.status).toBe(503);
});

test("no node: one warning with the fix and the raw local URL, and the dev server keeps running", async () => {
  // tests/setup.ts points the clients at a port with no listener.
  const { fake } = await start({ name: "web", devSite: { name: "web" } }, 54321);
  expect(fake.warns).toEqual([
    "devsite: the node does not answer — run bunx devsite doctor\n" +
      "devsite: the dev server runs at http://127.0.0.1:54321/ only; HMR works only through the https names.",
  ]);
  expect(fake.infos).toEqual([]);
});

test("a node that answers an error: the warning names the status", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 500;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.DEVSITE_NODE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { fake } = await start({ name: "web", devSite: { name: "web" } }, 54321);
  server.close();
  expect(fake.warns[0]).toStartWith(
    "devsite: the node answered HTTP 500 — run bunx devsite doctor",
  );
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
  ).toThrow("not one DNS label");
});

test("a devSite.name with a dot or a space stops the dev server", () => {
  for (const name of ["web.test", "my app"]) {
    const plugin = devsite();
    expect(() =>
      viteConfigHook(plugin)({ root: makeViteRoot({ name: "web", devSite: { name } }) }, ENV),
    ).toThrow("not one DNS label");
  }
});
