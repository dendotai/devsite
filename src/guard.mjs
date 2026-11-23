// The LAN guard every devsite route starts with (ADR 0002): devsite's route to the node, and each site block of the user's own that imports devsite-guard.
export const ALLOWED_SOURCES = ["127.0.0.1", "::1", "100.64.0.0/10"];

export function guardCaddyfileLines() {
  return [`\t@outside not remote_ip ${ALLOWED_SOURCES.join(" ")}`, "\tabort @outside"];
}

/**
 * Whether a route from Caddy's live config starts the way Caddy's adapter makes guardCaddyfileLines(): a subroute whose first route aborts every request from outside the allowed sources. A guard that allows fewer sources still keeps the LAN out, so it passes.
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
