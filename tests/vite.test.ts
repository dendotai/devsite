// The plugin's config hook, in-process. Contract: no devSite host at the Vite
// root — including no package.json at all — means "do nothing".
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { devsite } from "../src/vite.mjs";

const ENV = { command: "serve", mode: "development" } as const;

function configHook(plugin: ReturnType<typeof devsite>) {
  const hook = plugin.config;
  if (typeof hook !== "function") throw new Error("config hook is not callable");
  return hook;
}

function makeRoot(pkg?: object) {
  const root = mkdtempSync(join(tmpdir(), "devsite-vite-"));
  if (pkg !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}

test("no package.json at the Vite root: no-op instead of an ENOENT crash", async () => {
  const plugin = devsite();
  await expect(configHook(plugin).call(plugin, { root: makeRoot() }, ENV)).resolves.toBeUndefined();
});

test("unparseable package.json: no-op", async () => {
  const root = makeRoot();
  writeFileSync(join(root, "package.json"), "not json {");
  const plugin = devsite();
  await expect(configHook(plugin).call(plugin, { root }, ENV)).resolves.toBeUndefined();
});

test("package.json without a devSite host: no-op", async () => {
  const plugin = devsite();
  const result = await configHook(plugin).call(plugin, { root: makeRoot({ name: "x" }) }, ENV);
  expect(result).toBeUndefined();
});

test("devSite.host present: Vite is pointed at a free port for that host", async () => {
  const plugin = devsite();
  const result = await configHook(plugin).call(
    plugin,
    { root: makeRoot({ name: "web", devSite: { host: "web.test.internal" } }) },
    ENV,
  );
  expect(result?.server?.allowedHosts).toEqual(["web.test.internal"]);
  expect(result?.server?.port).toBeGreaterThan(0);
  expect(result?.server?.strictPort).toBe(true);
});
