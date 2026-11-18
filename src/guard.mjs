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
