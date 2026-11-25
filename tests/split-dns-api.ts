// A local fake of Tailscale's OAuth token endpoint and split DNS API (#110): a token for SECRET only, and the `internal` route with each write made to it.
import { afterEach } from "bun:test";

export const SECRET = "tskey-client-k123CNTRL-abc456";

export type Route = string[] | null;

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

export function fakeSplitDnsApi(route: Route) {
  // down: every call gets HTTP 503, as Tailscale's API out of reach. delayMs: each call waits this long.
  const state = { route, writes: [] as string[][], down: false, delayMs: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      await Bun.sleep(state.delayMs);
      if (state.down) return new Response("", { status: 503 });
      const url = new URL(req.url);
      if (url.pathname === "/api/v2/oauth/token") {
        const form = new URLSearchParams(await req.text());
        if (form.get("client_secret") !== SECRET) return new Response("", { status: 401 });
        return Response.json({
          access_token: "tskey-api-t",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      if (url.pathname !== "/api/v2/tailnet/-/dns/split-dns") {
        return new Response("", { status: 404 });
      }
      if (req.headers.get("authorization") !== "Bearer tskey-api-t") {
        return new Response("", { status: 401 });
      }
      if (req.method === "PATCH") {
        const body = (await req.json()) as { internal?: string[] };
        if (body.internal) {
          state.route = body.internal;
          state.writes.push(body.internal);
        }
      }
      return Response.json(state.route === null ? {} : { internal: state.route });
    },
  });
  servers.push(server);
  return { state, url: `http://127.0.0.1:${server.port}` };
}
