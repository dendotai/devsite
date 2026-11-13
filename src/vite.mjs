// devsite Vite plugin — the dev-time half of devsite.
//
// `devsite init` (src/commands/init.ts) is the one-time privileged bootstrap: local CA, always-on Caddy service, and a placeholder route per `package.json#devSite` host. This plugin is the per-run half: it has Vite bind an OS-assigned ephemeral port (`port: 0`) and live-updates the host's route through Caddy's admin API on localhost — no sudo, no configured ports, so any number of projects can run simultaneously. The plugin never picks a port itself: the number exists only once the server is bound (ADR 0001), so it is read in the `listening` callback.
//
// Plain .mjs (not .ts): Vite's config loader externalizes bare imports and hands them to the Node runtime, which won't execute TypeScript from node_modules. The published type surface lives in vite.types.d.mts — named so it does NOT shadow this module in the typecheck program (tsc skips a .js root file when an adjacent same-named .d.ts exists, and checkJs would then never look at this file); the exports map wires the two together.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { devSiteName, hostsOf } from "./names.mjs";
import { stampLastUsed } from "./state.mjs";

// DEVSITE_CADDY_ADMIN overrides the admin endpoint so tests can point the plugin at a local mock; read per call, so the override needs no import-order care.
const DEFAULT_ADMIN = "http://localhost:2019";
function adminBase() {
  return process.env.DEVSITE_CADDY_ADMIN ?? DEFAULT_ADMIN;
}

// Node's fetch (undici) sends no Origin header and Caddy's admin API then sees an empty origin and 403s; sending it explicitly satisfies the origin check. Caller headers are normalized through Headers and the pin set last, so it wins over any caller-supplied Origin in any casing (a plain spread is case-sensitive and would keep both keys). Exported for the tests that assert exactly that.
/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
export function caddy(path, init = {}) {
  const admin = adminBase();
  const headers = new Headers(init.headers);
  headers.set("origin", admin);
  return fetch(`${admin}${path}`, { ...init, headers });
}

/**
 * @param {string[]} hosts
 * @param {number} port
 */
function devsiteRoute(hosts, port) {
  return {
    match: [{ host: hosts }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `localhost:${port}` }] }],
    terminal: true,
  };
}

/**
 * One route for all the project's hosts, found by the first: the one `devsite init` gives a placeholder route. Only that route is updated, in place: Caddy matches routes top to bottom, and its Caddyfile adapter sorts an exact host above a wildcard, so its position is the one where the host answers (#15).
 *
 * @param {string[]} hosts
 * @param {number} port
 */
async function registerRoute(hosts, port) {
  const res = await caddy("/config/apps/http/servers").catch((cause) => {
    throw new Error(
      "the Caddy admin API does not answer — is the Caddy service running? `bunx devsite init` from the repo root sets it up",
      { cause },
    );
  });
  // A Caddy that runs with no HTTP app (init never ran on this machine) answers 400 here.
  if (!res.ok)
    throw new Error(
      `Caddy admin API: HTTP ${res.status} for its HTTP servers — \`bunx devsite init\` from the repo root sets them up`,
    );
  // The slice of Caddy's config shape this function walks; everything else in the response is passed through untyped.
  const servers = /** @type {Record<string, { routes?: { match?: { host?: string[] }[] }[] }>} */ (
    (await res.json()) ?? {}
  );

  for (const [name, srv] of Object.entries(servers)) {
    const i = (srv.routes ?? []).findIndex((r) =>
      (r.match ?? []).some((m) => (m.host ?? []).includes(hosts[0] ?? "")),
    );
    if (i !== -1) {
      const patch = await caddy(`/config/apps/http/servers/${name}/routes/${i}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(devsiteRoute(hosts, port)),
      });
      if (!patch.ok) throw new Error(`Caddy route update: HTTP ${patch.status}`);
      return;
    }
  }

  throw new Error(`no Caddy route for ${hosts[0]} — run \`bunx devsite init\` from the repo root`);
}

/**
 * `api.settled` is a test seam with no stability promise: it resolves once the listening callback's async work (last-used stamp + route registration) has settled, so tests can await it instead of polling logger output. It stays pending if the server never reaches `listening`.
 *
 * @returns {import("vite").Plugin & { api: { settled: Promise<void> } }}
 */
export function devsite() {
  // Assigned in one hook, read in another — the closure split defeats tsc's evolving-any inference, so the type is spelled out.
  /** @type {string | undefined} */
  let name;
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
      name = devSiteName(pkg, join(root, "package.json"));
      if (!name) return;
      const host = hostsOf(name).internal;
      return {
        server: {
          // 0 = the OS assigns the port at bind time; there is no pre-picked number to race over. The real port is read in `configureServer`.
          port: 0,
          // Listen beyond loopback so the Tailscale-reachable Caddy proxy
          // (https://<host>) can reach the dev server.
          host: true,
          allowedHosts: [host],
          // Caddy terminates TLS on :443 and proxies to the dev port, so the HMR client must connect back over wss on 443, not the raw port. No `host`: the client then uses the page's own host, `.internal` or `.localhost`.
          ws: { protocol: "wss", clientPort: 443 },
        },
      };
    },
    configureServer(server) {
      if (!name) {
        settle();
        return;
      }
      const { internal: h, localhost: local } = hostsOf(name);
      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        const p = typeof addr === "object" && addr ? addr.port : undefined;
        if (!p) {
          settle();
          return;
        }
        // Last-used stamp (#48): fire-and-forget, independent of the Caddy registration outcome — the dev server started either way.
        const stamped = stampLastUsed(h).catch((err) =>
          server.config.logger.warn(
            `devsite: could not record last-used date for ${h} (${err instanceof Error ? err.message : err})`,
          ),
        );
        const registered = registerRoute([h, local], p).then(
          () =>
            server.config.logger.info(
              `devsite: https://${h} and https://${local} → localhost:${p}`,
            ),
          (err) =>
            server.config.logger.warn(
              `devsite: could not register https://${h} with Caddy (${err instanceof Error ? err.message : err}). ` +
                "Falling back to the raw local URL below — HMR only works via the https host.",
            ),
        );
        // Every branch above is handled, so no promise can reject.
        void Promise.all([stamped, registered]).then(settle);
      });
    },
  };
}
