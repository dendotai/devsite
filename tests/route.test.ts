// Caddy's one route for every devsite name, the LAN guard, and the "node not running" page, checked through the real `caddy adapt`, which is what a reload loads.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_ROUTE_FILE, renderGuardFile, renderNodeRoute } from "../src/commands/init";
import { SET_UP_CADDYFILE } from "./machine";

const PAGE = [
  "<title>devsite</title>",
  "<style> a { color: red; } </style>",
  "",
  "<p>down</p>",
].join("\n");

type Handler = Record<string, unknown> & { handler: string };
type ErrorRoute = { handle: { routes: { handle: Handler[] }[] }[] };

type Config = {
  apps: {
    http: {
      servers: Record<
        string,
        {
          routes: {
            match: { host: string[] }[];
            handle: { routes: { match?: unknown[]; handle: Handler[] }[] }[];
          }[];
          errors: {
            routes: { handle: { routes: { handle: { routes: ErrorRoute[] }[] }[] }[] }[];
          };
        }
      >;
    };
    tls: { automation: { policies: unknown[]; on_demand: unknown } };
  };
};

// devsite's files laid out as init lays them out, behind a Caddyfile as init writes it, adapted by the real Caddy. page: the "node not running" page; the shipped one when left out.
function adapt(page?: string): Config {
  const dir = mkdtempSync(join(tmpdir(), "devsite-route-"));
  writeFileSync(join(dir, "guard.caddy"), renderGuardFile());
  writeFileSync(join(dir, NODE_ROUTE_FILE), renderNodeRoute(page));
  const caddyfile = SET_UP_CADDYFILE.replaceAll("STORAGE", join(dir, "storage")).replace(
    "import devsite.d/*.caddy",
    `import ${join(dir, "*.caddy")}`,
  );
  writeFileSync(join(dir, "Caddyfile"), caddyfile);
  const r = spawnSync("caddy", ["adapt", "--config", join(dir, "Caddyfile")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`caddy adapt failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

// The handlers of the last error route: the node did not answer, and the request went to no main Mac (tests/pass-to-main.test.ts).
const downHandlers = (c: Config) =>
  server(c).errors.routes[0]?.handle[0]?.routes[0]?.handle[0]?.routes.at(-1)?.handle[0]?.routes[0]
    ?.handle ?? [];

const server = (c: Config) =>
  Object.values(c.apps.http.servers)[0] as Config["apps"]["http"]["servers"][string];

test("one route takes every .internal and .localhost name, and guards it before it proxies to the node", () => {
  const route = server(adapt(PAGE)).routes[0];
  expect(route?.match).toEqual([{ host: ["*.internal", "*.localhost"] }]);
  const [guard, toMain, proxy] = route?.handle[0]?.routes ?? [];
  expect(guard).toEqual({
    match: [{ not: [{ remote_ip: { ranges: ["127.0.0.1", "::1", "100.64.0.0/10"] } }] }],
    handle: [{ handler: "static_response", abort: true }],
  });
  expect(toMain?.match).toEqual([{ header: { "Devsite-Pass": ["to-main"] } }]);
  expect(proxy?.handle).toMatchObject([
    { handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:47380" }] },
  ]);
});

test("every answer but a WebSocket's 101 tells the browser not to use HTTP/3", () => {
  const proxy = server(adapt(PAGE)).routes[0]?.handle[0]?.routes[2]?.handle[0];
  expect(proxy?.handle_response).toEqual([
    {
      match: { status_code: [2, 3, 4, 5] },
      routes: [
        {
          handle: [
            { handler: "headers", response: { deferred: true, set: { "Alt-Svc": ["clear"] } } },
            { handler: "copy_response" },
          ],
        },
      ],
    },
  ]);
});

test("Caddy signs each name's certificate at its first handshake, from its own CA, after it asks the node", () => {
  const c = adapt(PAGE);
  expect(c.apps.tls.automation.policies).toEqual([
    {
      subjects: ["*.internal", "*.localhost"],
      issuers: [{ module: "internal", lifetime: 432000000000000 }],
      on_demand: true,
    },
  ]);
  expect(c.apps.tls.automation.on_demand).toEqual({
    permission: { endpoint: "http://127.0.0.1:47380/tls-allowed", module: "http" },
  });
});

test("a node that does not answer: Caddy answers the 'node not running' page as HTML, with 502", () => {
  const handlers = downHandlers(adapt(PAGE));
  expect(handlers[0]).toEqual({
    handler: "headers",
    response: {
      set: {
        "Alt-Svc": ["clear"],
        "Cache-Control": ["no-store"],
        Connection: ["close"],
        "Content-Type": ["text/html; charset=utf-8"],
      },
    },
  });
  expect(handlers[1]).toEqual({ handler: "static_response", status_code: 502, body: PAGE });
});

test("the shipped 'node not running' page passes the render checks", () => {
  expect(downHandlers(adapt())[1]?.body).toContain("the devsite node is not running");
});

test("a page with a brace Caddy would read as a placeholder is refused", () => {
  expect(() => renderNodeRoute("<p>{env.HOME}</p>")).toThrow(
    "assets/node-down.html line 1 holds `{e`, which Caddy reads as a placeholder",
  );
});

test("a page with a line equal to the heredoc marker is refused", () => {
  expect(() => renderNodeRoute("<p>\n  HTML\n</p>")).toThrow(
    "assets/node-down.html line 2 is `HTML`, which ends the page early",
  );
});

test("the JSON printed for a Caddy with no Caddyfile answers in one line of text, not the page", () => {
  const file = renderNodeRoute(null);
  expect(file).toContain(
    '\t\trespond "devsite: the node does not answer — run bunx devsite doctor" 502',
  );
  expect(file).toContain("\t\t\tConnection close");
  expect(file).not.toContain("<html");
});
