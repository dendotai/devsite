// The LAN guard every devsite route starts with (ADR 0002). One definition for both places a route comes from — init's placeholder (Caddyfile) and the Vite plugin's live route (admin API JSON) — because the plugin's PATCH replaces the whole route, guard included.
export const ALLOWED_SOURCES = ["127.0.0.1", "::1", "100.64.0.0/10"];

export function guardCaddyfileLines() {
  return [`\t@outside not remote_ip ${ALLOWED_SOURCES.join(" ")}`, "\tabort @outside"];
}

/**
 * A route whose handlers run only for a request from an allowed source; any other request is aborted with no HTTP response.
 *
 * @param {string[]} hosts
 * @param {object[]} handle
 */
export function guardedRoute(hosts, handle) {
  return {
    match: [{ host: hosts }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [{ not: [{ remote_ip: { ranges: ALLOWED_SOURCES } }] }],
            handle: [{ handler: "static_response", abort: true }],
          },
          { handle },
        ],
      },
    ],
    terminal: true,
  };
}

/**
 * Whether a route from Caddy's live config starts the way guardedRoute() builds it, and Caddy's adapter makes of guardCaddyfileLines(): a subroute whose first route aborts every request from outside the allowed sources. A guard that allows fewer sources still keeps the LAN out, so it passes.
 *
 * @param {{ handle?: unknown[] }} route
 */
export function startsWithGuard(route) {
  const sub =
    /** @type {{ handler?: string; routes?: { match?: unknown[]; handle?: unknown[] }[] } | undefined} */ (
      route.handle?.[0]
    );
  const first = sub?.handler === "subroute" ? sub.routes?.[0] : undefined;
  const not = /** @type {{ not?: { remote_ip?: { ranges?: string[] } }[] } | undefined} */ (
    first?.match?.[0]
  )?.not;
  const ranges = not?.length === 1 ? not[0]?.remote_ip?.ranges : undefined;
  const abort = /** @type {{ handler?: string; abort?: boolean } | undefined} */ (
    first?.handle?.[0]
  );
  return (
    first?.match?.length === 1 &&
    ranges !== undefined &&
    ranges.every((r) => ALLOWED_SOURCES.includes(r)) &&
    first.handle?.length === 1 &&
    abort?.handler === "static_response" &&
    abort.abort === true
  );
}
