// devsite's objects in a Caddy JSON config (#86): which admin API requests init plans for a config, and what they leave.
import { expect, test } from "bun:test";
import {
  type AdminOp,
  applyOp,
  type CaddyConfig,
  type DevsiteObjects,
  formatLike,
  planOps,
} from "../src/caddy-json";

const objects: DevsiteObjects = {
  route: { match: [{ host: ["*.internal", "*.localhost"] }], handle: [{ handler: "node" }] },
  errors: { match: [{ host: ["*.internal", "*.localhost"] }], handle: [{ handler: "page" }] },
  policy: { subjects: ["*.internal", "*.localhost"], issuers: [{ module: "internal" }] },
  ask: { permission: { module: "http", endpoint: "http://127.0.0.1:47380/tls-allowed" } },
};

const userRoute = { match: [{ host: ["site.example.com"] }], handle: [] };

const applyAll = (config: CaddyConfig | null, ops: AdminOp[]) =>
  ops.reduce<unknown>((c, op) => applyOp(c, op), config) as CaddyConfig;

const requests = (ops: AdminOp[]) => ops.map((o) => `${o.method} ${o.path}`);

test("a server on :443: devsite's route and error route go first in it, the policy and the ask into a new tls app", () => {
  const config = {
    apps: { http: { servers: { mine: { listen: [":443"], routes: [userRoute] } } } },
  };
  const ops = planOps(config, objects);
  expect(requests(ops)).toEqual([
    "PUT /config/apps/http/servers/mine/routes/0",
    "PUT /config/apps/http/servers/mine/errors",
    "PUT /config/apps/tls",
    "PUT /config/apps/tls/automation/on_demand",
  ]);
  const after = applyAll(config, ops) as {
    apps: { http: { servers: { mine: { routes: object[]; errors: object } } }; tls: object };
  };
  expect(after.apps.http.servers.mine.routes).toEqual([
    { "@id": "devsite.node.mine", ...objects.route },
    userRoute,
  ]);
  expect(after.apps.http.servers.mine.errors).toEqual({
    routes: [{ "@id": "devsite.errors.mine", ...objects.errors }],
  });
  expect(after.apps.tls).toEqual({
    automation: {
      policies: [{ "@id": "devsite.tls", ...objects.policy }],
      on_demand: { "@id": "devsite.ask", ...objects.ask },
    },
  });
});

test("each server that listens on 443 takes the route; one on another port does not", () => {
  const config = {
    apps: {
      http: {
        servers: {
          a: { listen: ["tcp/0.0.0.0:443"], routes: [] },
          b: { listen: [":8080"], routes: [] },
          c: { listen: [":440-450"] },
        },
      },
    },
  };
  const ops = planOps(config, objects);
  expect(requests(ops).filter((r) => r.includes("/servers/"))).toEqual([
    "PUT /config/apps/http/servers/a/routes/0",
    "PUT /config/apps/http/servers/a/errors",
    "PUT /config/apps/http/servers/c/routes",
    "PUT /config/apps/http/servers/c/errors",
  ]);
});

test("no server on 443: init adds a server devsite that listens on :443", () => {
  const config = { apps: { http: { servers: { other: { listen: [":8080"] } } } } };
  const ops = planOps(config, objects);
  expect(ops[0]).toEqual({
    method: "PUT",
    path: "/config/apps/http/servers/devsite",
    body: {
      listen: [":443"],
      routes: [{ "@id": "devsite.node.devsite", ...objects.route }],
      errors: { routes: [{ "@id": "devsite.errors.devsite", ...objects.errors }] },
    },
    planLine: "adds a server devsite that listens on :443, with devsite's route",
  });
});

test("an empty config: one PUT for the apps, one for the tls app, one for the ask", () => {
  expect(requests(planOps(null, objects))).toEqual([
    "PUT /config/apps",
    "PUT /config/apps/tls",
    "PUT /config/apps/tls/automation/on_demand",
  ]);
});

test("a config that already holds devsite's objects: nothing to do", () => {
  const config = { apps: { http: { servers: { mine: { listen: [":443"] } } } } };
  const applied = applyAll(config, planOps(config, objects));
  expect(planOps(applied, objects)).toEqual([]);
});

test("a changed route: a rerun replaces it by its tag, wherever it sits, and nothing else", () => {
  const config = {
    apps: { http: { servers: { mine: { listen: [":443"], routes: [userRoute] } } } },
  };
  const applied = applyAll(config, planOps(config, objects)) as {
    apps: { http: { servers: { mine: { routes: object[] } } } };
  };
  // The user moved devsite's route below their own.
  applied.apps.http.servers.mine.routes.reverse();
  const newer = { ...objects, route: { ...objects.route, handle: [{ handler: "node", v: 2 }] } };
  const ops = planOps(applied as CaddyConfig, newer);
  expect(requests(ops)).toEqual(["PATCH /id/devsite.node.mine"]);
  const after = applyAll(applied as CaddyConfig, ops) as typeof applied;
  expect(after.apps.http.servers.mine.routes).toEqual([
    userRoute,
    { "@id": "devsite.node.mine", ...newer.route },
  ]);
});

test("an ask of the user's own, with no tag, stays", () => {
  const ask = { permission: { module: "http", endpoint: "http://127.0.0.1:9/mine" } };
  const config = {
    apps: {
      http: { servers: { mine: { listen: [":443"] } } },
      tls: { automation: { on_demand: ask } },
    },
  };
  const ops = planOps(config, objects);
  expect(requests(ops)).not.toContain("PUT /config/apps/tls/automation/on_demand");
  expect(
    (applyAll(config, ops) as { apps: { tls: { automation: object } } }).apps.tls.automation,
  ).toMatchObject({ on_demand: ask });
});

test("a route of the user's that looks like devsite's has no tag: it stays, and devsite's goes before it", () => {
  const config = {
    apps: { http: { servers: { mine: { listen: [":443"], routes: [objects.route] } } } },
  };
  const after = applyAll(config, planOps(config, objects)) as {
    apps: { http: { servers: { mine: { routes: object[] } } } };
  };
  expect(after.apps.http.servers.mine.routes).toEqual([
    { "@id": "devsite.node.mine", ...objects.route },
    objects.route,
  ]);
});

test("a server devsite the user moved off 443 keeps devsite's route; init adds no second server", () => {
  const config = { apps: { http: { servers: { devsite: { listen: [":8443"] } } } } };
  expect(requests(planOps(config, objects)).filter((r) => r.includes("/servers/"))).toEqual([
    "PUT /config/apps/http/servers/devsite/routes",
    "PUT /config/apps/http/servers/devsite/errors",
  ]);
});

test("a JSON file keeps its indent and its last newline", () => {
  expect(formatLike('{\n\t"a": 1\n}\n', { a: 2 })).toBe('{\n\t"a": 2\n}\n');
  expect(formatLike('{\n    "a": 1\n}', { a: 2 })).toBe('{\n    "a": 2\n}');
  expect(formatLike('{"a":1}\n', { a: 2 })).toBe('{"a":2}\n');
});
