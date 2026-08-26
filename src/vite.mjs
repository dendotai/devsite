// devsite Vite plugin — the dev-time half of devsite.
//
// `devsite init` (src/commands/init.ts) is the one-time privileged bootstrap: local CA,
// always-on Caddy service, and a placeholder route per `package.json#devSite`
// host. This plugin is the per-run half: it has Vite bind an OS-assigned
// ephemeral port (`port: 0`) and live-updates the host's route through Caddy's
// admin API on localhost — no sudo, no configured ports, so any number of
// projects can run simultaneously. The plugin never picks a port itself: the
// number exists only once the server is bound (ADR 0001), so it is read in the
// `listening` callback.
//
// Plain .mjs (not .ts): Vite's config loader externalizes bare imports and
// hands them to the Node runtime, which won't execute TypeScript from
// node_modules. Types live in vite.d.mts.
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Caddy's admin endpoint. DEVSITE_CADDY_ADMIN overrides it so tests can point
// the plugin at a local mock; read per call, so the override needs no
// import-order care. The default is Caddy's real local admin address.
const DEFAULT_ADMIN = "http://localhost:2019";
function adminBase() {
  return process.env.DEVSITE_CADDY_ADMIN ?? DEFAULT_ADMIN;
}

// Node's fetch (undici) sends no Origin header and Caddy's admin API then sees
// an empty origin and 403s; sending it explicitly satisfies the origin check.
// Caller headers are normalized through Headers and the pin set last, so it
// wins over any caller-supplied Origin in any casing (a plain spread is
// case-sensitive and would keep both keys). Exported for the tests that
// assert exactly that.
export function caddy(path, init = {}) {
  const admin = adminBase();
  const headers = new Headers(init.headers);
  headers.set("origin", admin);
  return fetch(`${admin}${path}`, { ...init, headers });
}

function devsiteRoute(host, port) {
  return {
    match: [{ host: [host] }],
    handle: [{ handler: "reverse_proxy", upstreams: [{ dial: `localhost:${port}` }] }],
    terminal: true,
  };
}

async function registerRoute(host, port) {
  const res = await caddy("/config/apps/http/servers");
  if (!res.ok) throw new Error(`Caddy admin API: HTTP ${res.status}`);
  const servers = (await res.json()) ?? {};

  for (const [name, srv] of Object.entries(servers)) {
    const i = (srv.routes ?? []).findIndex((r) =>
      (r.match ?? []).some((m) => (m.host ?? []).includes(host)),
    );
    if (i !== -1) {
      const patch = await caddy(`/config/apps/http/servers/${name}/routes/${i}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(devsiteRoute(host, port)),
      });
      if (!patch.ok) throw new Error(`Caddy route update: HTTP ${patch.status}`);
      return;
    }
  }

  // Host not in the running config (devsite init not run for it yet) — append
  // to the :443 server so this session still works; init makes it permanent.
  const https = Object.entries(servers).find(([, s]) =>
    (s.listen ?? []).some((l) => String(l).endsWith(":443")),
  );
  if (!https)
    throw new Error(
      "no :443 server in the Caddy config — run `bunx devsite init` from the repo root",
    );
  const post = await caddy(`/config/apps/http/servers/${https[0]}/routes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(devsiteRoute(host, port)),
  });
  if (!post.ok) throw new Error(`Caddy route append: HTTP ${post.status}`);
}

export function devsite() {
  let host;
  return {
    name: "devsite",
    apply: "serve",
    config(userConfig) {
      const root = userConfig.root ?? process.cwd();
      // A Vite root without a (readable, parseable) package.json simply has no
      // devSite host — no-op, never crash the dev server over it.
      let pkg;
      try {
        pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      } catch {
        return;
      }
      host = pkg.devSite?.host;
      if (!host) return;
      return {
        server: {
          // 0 = the OS assigns the port at bind time; there is no pre-picked
          // number to race over. The real port is read in `configureServer`.
          port: 0,
          // Listen beyond loopback so the Tailscale-reachable Caddy proxy
          // (https://<host>) can reach the dev server.
          host: true,
          allowedHosts: [host],
          // Caddy terminates TLS on :443 and proxies to the dev port, so the
          // HMR client must connect back over wss to the proxy host, not the
          // raw port. Browse via https://<host> everywhere so HMR works.
          ws: { host, protocol: "wss", clientPort: 443 },
        },
      };
    },
    configureServer(server) {
      if (!host) return;
      const h = host;
      server.httpServer?.once("listening", () => {
        const addr = server.httpServer?.address();
        const p = typeof addr === "object" && addr ? addr.port : undefined;
        if (!p) return;
        registerRoute(h, p).then(
          () => server.config.logger.info(`devsite: https://${h} → localhost:${p}`),
          (err) =>
            server.config.logger.warn(
              `devsite: could not register https://${h} with Caddy (${err instanceof Error ? err.message : err}). ` +
                "Is the Caddy service running (`bunx devsite init` from the repo root sets it up)? " +
                "Falling back to the raw local URL below — HMR only works via the https host.",
            ),
        );
      });
    },
  };
}
