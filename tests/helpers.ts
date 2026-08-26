// Shared fixtures for the CLI and Vite-plugin test suites.
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plugin } from "vite";

// A throwaway repo whose apps/web/package.json declares a devSite host.
export function makeRepo(host = "web.test.internal") {
  const repo = mkdtempSync(join(tmpdir(), "devsite-repo-"));
  mkdirSync(join(repo, "apps", "web"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "web", "package.json"),
    JSON.stringify({ name: "web", devSite: { host } }),
  );
  return repo;
}

// A throwaway directory with no devSite route anywhere.
export function makeEmptyRepo() {
  return mkdtempSync(join(tmpdir(), "devsite-empty-"));
}

// A path to a Caddyfile that does not exist, in its own scratch dir — dry
// runs only ever read it, so one can serve a whole suite.
export function scratchCaddyfile() {
  return join(mkdtempSync(join(tmpdir(), "devsite-none-")), "Caddyfile");
}

// A throwaway Vite root; pkg (when given) becomes its package.json.
export function makeViteRoot(pkg?: object) {
  const root = mkdtempSync(join(tmpdir(), "devsite-vite-"));
  if (pkg !== undefined) writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}

export function viteConfigHook(plugin: Plugin) {
  const hook = plugin.config;
  if (typeof hook !== "function") throw new Error("config hook is not callable");
  return hook;
}

export function viteConfigureServerHook(plugin: Plugin) {
  const hook = plugin.configureServer;
  if (typeof hook !== "function") throw new Error("configureServer hook is not callable");
  return hook;
}

// A fake Vite dev server: an EventEmitter posing as httpServer with a fixed
// bound port, plus the captured logger output.
export function fakeViteServer(port: number) {
  const httpServer = new EventEmitter() as EventEmitter & { address: () => { port: number } };
  httpServer.address = () => ({ port });
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    httpServer,
    infos,
    warns,
    server: {
      httpServer,
      config: {
        logger: { info: (m: string) => infos.push(m), warn: (m: string) => warns.push(m) },
      },
    },
  };
}
