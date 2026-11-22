// The offline page (#14): init renders devsite.d/fragments/offline.caddy from assets/offline.html, and each host file imports it. Checked with the real `caddy adapt`, which is what a reload loads.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OFFLINE_FRAGMENT,
  renderGuardFile,
  renderHostFile,
  renderOfflineFragment,
} from "../src/commands/init";
import { writeOfflineFragment } from "./machine";

const PAGE = [
  "<title>__HOST__</title>",
  '<body data-status="__STATUS_CODE__">',
  "<b>__PROJECT__</b> <code>__CMD__</code>",
  "<style> a { color: red; } </style>",
  "",
  "</body>",
].join("\n");

type HeadersHandler = { handler: "headers"; response: { set: Record<string, string[]> } };
type ResponseHandler = { handler: "static_response"; status_code: number; body: string };
type Handlers = [HeadersHandler, ResponseHandler];
type ErrorRoute = { handle: { routes: { handle: { routes: { handle: Handlers }[] }[] }[] }[] };

// The handlers of the host's error route, from what `caddy adapt` makes of devsite's files laid out as init lays them out.
function errorHandlers(project: string, page = PAGE): Handlers {
  const dir = mkdtempSync(join(tmpdir(), "devsite-offline-"));
  writeOfflineFragment(join(dir, "devsite.d"), page);
  writeFileSync(join(dir, "devsite.d", "guard.caddy"), renderGuardFile());
  writeFileSync(
    join(dir, "devsite.d", "web.test.internal.caddy"),
    renderHostFile({ host: "web.test.internal", project }, join(dir, "port.caddy")),
  );
  writeFileSync(join(dir, "port.caddy"), "error 503\n");
  writeFileSync(join(dir, "Caddyfile"), "import devsite.d/*.caddy\n");
  const r = spawnSync(
    "caddy",
    ["adapt", "--config", join(dir, "Caddyfile"), "--adapter", "caddyfile"],
    { encoding: "utf8" },
  );
  if (r.status !== 0) throw new Error(`caddy adapt failed: ${r.stderr}`);
  const config = JSON.parse(r.stdout);
  const server = Object.values(config.apps.http.servers)[0] as { errors: { routes: ErrorRoute[] } };
  const handlers = server.errors.routes[0]?.handle[0]?.routes[0]?.handle[0]?.routes[0]?.handle;
  if (handlers === undefined) throw new Error("no error route for the host");
  return handlers;
}

test("both offline states answer the page as HTML, with the visited host and the status filled in by Caddy", () => {
  const [header, response] = errorHandlers("web");
  expect(header).toEqual({
    handler: "headers",
    response: {
      set: { "Cache-Control": ["no-store"], "Content-Type": ["text/html; charset=utf-8"] },
    },
  });
  expect(response).toEqual({
    handler: "static_response",
    status_code: 503,
    body: [
      "<title>{http.request.host}</title>",
      '<body data-status="{http.error.status_code}">',
      "<b>web</b> <code>bun dev</code>",
      "<style> a { color: red; } </style>",
      "",
      "</body>",
    ].join("\n"),
  });
});

test("a project name with markup or a Caddy placeholder reaches the page as text", () => {
  const [, response] = errorHandlers('@acme/<web> {env.HOME} "x"');
  expect(response.body).toContain(
    "<b>@acme/&#60;web&#62;&#32;&#123;env.HOME&#125;&#32;&#34;x&#34;</b>",
  );
});

test("a page with a brace Caddy would read as a placeholder is refused", () => {
  expect(() => renderOfflineFragment("<p>{env.HOME}</p>")).toThrow(
    "assets/offline.html line 1 holds `{e`, which Caddy reads as a placeholder",
  );
});

test("a page with a line equal to the heredoc marker is refused", () => {
  expect(() => renderOfflineFragment("<p>\n  HTML\n</p>")).toThrow(
    "assets/offline.html line 2 is `HTML`, which ends the page early",
  );
});

test("the shipped page passes the render checks", () => {
  expect(renderOfflineFragment()).toContain("{http.error.status_code}");
});

test("the JSON printed for a Caddy with no Caddyfile answers in one line of text, not the page", () => {
  const file = renderHostFile({ host: "web.test.internal", project: "web" }, null);
  expect(file).toContain(
    '\t\trespond "devsite: dev server for web.test.internal is not running (start it with bun dev)" 503',
  );
  expect(file).not.toContain(OFFLINE_FRAGMENT);
  expect(file).not.toContain("<html");
});
