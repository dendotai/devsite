// devsite Vite plugin — a client of the node (ADR 0005).
//
// The plugin has Vite bind an OS-assigned port (`port: 0`) and tells the node the project's name, port and folder once the server listens; the node does the rest. It never changes the node or Caddy, and needs no sudo. The port exists only once the server is bound (ADR 0001), so it is read in the `listening` callback.
//
// Plain .mjs (not .ts): Vite's config loader externalizes bare imports and hands them to the Node runtime, which won't execute TypeScript from node_modules. The published type surface lives in vite.types.d.mts — named so it does NOT shadow this module in the typecheck program (tsc skips a .js root file when an adjacent same-named .d.ts exists, and checkJs would then never look at this file); the exports map wires the two together.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callNode } from "./client.mjs";
import { devSiteName, hostsOf } from "./names.mjs";

const VERSION = /** @type {{ version: string }} */ (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
).version;

/**
 * @param {string} name
 * @param {{ port: number; folder: string; project: string }} project
 */
async function register(name, project) {
  const res = await callNode(`/projects/${name}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...project, devsiteVersion: VERSION }),
  }).catch((cause) => {
    throw new Error("the node does not answer — run bunx devsite doctor", { cause });
  });
  if (!res.ok) throw new Error(`the node answered HTTP ${res.status} — run bunx devsite doctor`);
}

/**
 * `api.settled` is a test seam with no stability promise: it resolves once the listening callback's request to the node has settled, so tests can await it instead of polling logger output. It stays pending if the server never reaches `listening`.
 *
 * @returns {import("vite").Plugin & { api: { settled: Promise<void> } }}
 */
export function devsite() {
  // Assigned in one hook, read in another — the closure split defeats tsc's evolving-any inference, so the types are spelled out.
  /** @type {string | undefined} */
  let name;
  /** @type {string} */
  let folder = "";
  /** @type {string} */
  let project = "";
  let settle = () => {};
  /** @type {Promise<void>} */
  const settled = new Promise((r) => {
    settle = r;
  });
  return {
    name: "devsite",
    apply: "serve",
    api: { settled },
    config(userConfig) {
      const root = userConfig.root ?? process.cwd();
      // A Vite root without a (readable, parseable) package.json simply has no devSite name — no-op, never crash the dev server over it.
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      } catch {
        return;
      }
      const declared = devSiteName(pkg, join(root, "package.json"));
      if (!declared) return;
      name = declared.toLowerCase();
      folder = root;
      project = typeof pkg.name === "string" ? pkg.name : name;
      return {
        server: {
          // 0 = the OS assigns the port at bind time; there is no pre-picked number to race over. The real port is read when the server starts listening.
          port: 0,
          // The node, on this Mac, is the only client: other devices reach the dev server through Caddy and the node, never on this port.
          host: "127.0.0.1",
          allowedHosts: [hostsOf(name).internal],
          // Caddy terminates TLS on :443 and the node passes the WebSocket on, so the HMR client must connect back over wss on 443, not the raw port. No `host`: the client then uses the page's own host, `.internal` or `.localhost`.
          ws: { protocol: "wss", clientPort: 443 },
        },
      };
    },
    configureServer(server) {
      const n = name;
      if (!n) {
        settle();
        return;
      }
      const { internal, localhost } = hostsOf(n);
      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        const port = typeof addr === "object" && addr ? addr.port : undefined;
        if (!port) {
          settle();
          return;
        }
        // A dev server that ends with no close event (Ctrl-C) is found by the node at the next request.
        server.httpServer?.once("close", () => {
          callNode(`/projects/${n}/stop`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ port }),
          }).catch(() => {});
        });
        register(n, { port, folder, project })
          .then(
            () =>
              server.config.logger.info(
                `devsite: https://${internal} and https://${localhost} → 127.0.0.1:${port}`,
              ),
            (err) =>
              server.config.logger.warn(
                `devsite: ${err instanceof Error ? err.message : err}\n` +
                  `devsite: the dev server runs at http://127.0.0.1:${port}/ only; HMR works only through the https names.`,
              ),
          )
          .then(settle);
      });
    },
  };
}
