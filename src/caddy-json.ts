// devsite's part of a Caddy JSON config, for a Caddy with no Caddyfile: the route to the node and its error route (the "node not running" page and the pass to the main Mac) first in each server that listens on 443, the TLS policy, and the on-demand ask. Each carries an `@id` tag, so a rerun replaces devsite's own objects by tag and never touches an object of the user's (#86).
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { KnownInstall } from "./install";
import type { Settings } from "./settings";

export type CaddyConfig = Record<string, unknown>;

// A config file that parses as a JSON object; null for one that does not (another adapter's format) or cannot be read.
export function readJsonConfig(path: string): { text: string; config: CaddyConfig } | null {
  try {
    const text = readFileSync(path, "utf8");
    const config = JSON.parse(text) as unknown;
    return config !== null && typeof config === "object" && !Array.isArray(config)
      ? { text, config: config as CaddyConfig }
      : null;
  } catch {
    return null;
  }
}

// Where init cannot put devsite's objects into Caddy, it prints them as JSON for the user to add: a Caddy with no config file whose loads the caddy.reload setting hands to the user (a write through the admin API is the load), or a config file that is not JSON.
// file: the JSON file as init read it, so the decision and the edit see one read.
export function initPrintsJson(
  install: KnownInstall,
  settings: Settings,
  file = install.configKind === "json" ? readJsonConfig(install.config) : null,
): boolean {
  if (install.configKind === "caddyfile") return false;
  if (install.configKind === "api") return settings.caddy.reload === "manual";
  return file === null;
}

// What `caddy adapt` makes of devsite's route and the ask, untagged.
export type DevsiteObjects = { route: object; errors: object; policy: object; ask: object };

// One admin API request. A PUT to a path whose last segment is an array index inserts there; any other PUT sets a key the config lacks.
// planLine: what the request does, as the plan prints it.
export type AdminOp = { method: "PUT" | "PATCH"; path: string; body: unknown; planLine: string };

// The parts of an adapted config that make devsite's objects: the one server's first route and first error route, the first TLS policy, and the ask.
export function devsiteObjects(adapted: unknown): DevsiteObjects {
  const a = adapted as {
    apps?: {
      http?: { servers?: Record<string, { routes?: object[]; errors?: { routes?: object[] } }> };
      tls?: { automation?: { policies?: object[]; on_demand?: object } };
    };
  };
  const server = Object.values(a.apps?.http?.servers ?? {})[0];
  const route = server?.routes?.[0];
  const errors = server?.errors?.routes?.[0];
  const policy = a.apps?.tls?.automation?.policies?.[0];
  const ask = a.apps?.tls?.automation?.on_demand;
  if (!route || !errors || !policy || !ask) {
    throw new Error("`caddy adapt` made no route, error route, TLS policy, or ask for devsite");
  }
  return { route, errors, policy, ask };
}

export const SERVER = "devsite";
export const TAG = {
  route: (server: string) => `devsite.node.${server}`,
  errors: (server: string) => `devsite.errors.${server}`,
  policy: "devsite.tls",
  ask: "devsite.ask",
};

const tagged = (tag: string, o: object) => ({ "@id": tag, ...o });

// Caddy's listen addresses: an optional network (`tcp/`), a host, and a port or a port range.
function listensOn443(server: unknown): boolean {
  const listen = (server as { listen?: unknown }).listen;
  if (!Array.isArray(listen)) return false;
  return listen.some((l) => {
    const port =
      String(l)
        .replace(/^[a-z0-9]+\//, "")
        .split(":")
        .pop() ?? "";
    const [from, to = from] = port.split("-").map(Number);
    return from !== undefined && from <= 443 && 443 <= (to as number);
  });
}

function findTagged(node: unknown, tag: string): unknown {
  if (Array.isArray(node)) {
    for (const v of node) {
      const found = findTagged(v, tag);
      if (found !== undefined) return found;
    }
  } else if (node !== null && typeof node === "object") {
    if ((node as CaddyConfig)["@id"] === tag) return node;
    for (const v of Object.values(node)) {
      const found = findTagged(v, tag);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function valueAt(config: unknown, path: string[]): unknown {
  let node = config;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as CaddyConfig)[key];
  }
  return node;
}

const urlOf = (path: string[]) => `/config/${path.map(encodeURIComponent).join("/")}`;

// Sets the value at path with one PUT at the first key the config lacks, because Caddy's PUT needs the parent to exist.
function putPath(config: unknown, path: string[], value: unknown, planLine: string): AdminOp {
  let i = 0;
  while (i < path.length && valueAt(config, path.slice(0, i + 1)) !== undefined) i++;
  if (i === path.length) throw new Error(`${urlOf(path)} already exists`);
  let body = value;
  for (let j = path.length - 1; j > i; j--) body = { [path[j] as string]: body };
  return { method: "PUT", path: urlOf(path.slice(0, i + 1)), body, planLine };
}

// First place in the array at path, or a new array.
function putFirst(config: unknown, path: string[], item: unknown, planLine: string): AdminOp {
  return Array.isArray(valueAt(config, path))
    ? { method: "PUT", path: urlOf([...path, "0"]), body: item, planLine }
    : putPath(config, path, [item], planLine);
}

// The ops that bring devsite's objects in config up to date, in the order they run. Each op is planned against the config the ops before it leave, so a later op never recreates a parent an earlier one made.
export function planOps(config: CaddyConfig | null, objects: DevsiteObjects): AdminOp[] {
  let current: unknown = config ?? {};
  const ops: AdminOp[] = [];
  // A tagged object anywhere is devsite's: replaced by tag when it differs, wherever the user moved it. An untagged one is the user's: add plans the op that adds devsite's beside it, or null to leave it.
  const upsert = (
    tag: string,
    object: object,
    what: string,
    add: (want: object) => AdminOp | null,
  ) => {
    const want = tagged(tag, object);
    const live = findTagged(current, tag);
    const op: AdminOp | null =
      live === undefined
        ? add(want)
        : isDeepStrictEqual(live, want)
          ? null
          : {
              method: "PATCH",
              path: `/id/${tag}`,
              body: want,
              planLine: `replaces ${what} (${tag})`,
            };
    if (op === null) return;
    ops.push(op);
    current = applyOp(current, op);
  };

  const servers = (valueAt(current, ["apps", "http", "servers"]) ?? {}) as CaddyConfig;
  // A server devsite added keeps devsite's route wherever the user points its listen.
  const on443 = Object.keys(servers).filter((s) => listensOn443(servers[s]));
  const targets = on443.length === 0 && SERVER in servers ? [SERVER] : on443;
  if (targets.length === 0) {
    const server = {
      listen: [":443"],
      routes: [tagged(TAG.route(SERVER), objects.route)],
      errors: { routes: [tagged(TAG.errors(SERVER), objects.errors)] },
    };
    const planLine = `adds a server ${SERVER} that listens on :443, with devsite's route`;
    const op = putPath(current, ["apps", "http", "servers", SERVER], server, planLine);
    ops.push(op);
    current = applyOp(current, op);
  }
  for (const s of targets) {
    const server = ["apps", "http", "servers", s];
    upsert(TAG.route(s), objects.route, `devsite's route in server ${s}`, (want) =>
      putFirst(current, [...server, "routes"], want, `adds devsite's route first in server ${s}`),
    );
    const page = `devsite's "node not running" page`;
    upsert(TAG.errors(s), objects.errors, `${page} in server ${s}`, (want) =>
      putFirst(
        current,
        [...server, "errors", "routes"],
        want,
        `adds ${page} first in the error routes of server ${s}`,
      ),
    );
  }
  upsert(TAG.policy, objects.policy, "devsite's TLS policy", (want) =>
    putFirst(
      current,
      ["apps", "tls", "automation", "policies"],
      want,
      "adds devsite's TLS policy first: Caddy's own CA signs each devsite name at its first visit",
    ),
  );
  // An ask of the user's own stays, as the Caddyfile path keeps a user's on_demand_tls block.
  const ask = ["apps", "tls", "automation", "on_demand"];
  upsert(TAG.ask, objects.ask, "devsite's on-demand ask", (want) =>
    valueAt(current, ask) !== undefined
      ? null
      : putPath(
          current,
          ask,
          want,
          "sets the on-demand ask: Caddy asks the node before it signs a certificate",
        ),
  );
  return ops;
}

// What an op does to a config, as Caddy's admin API does it: for a JSON file init edits, and for the plan of the ops after it.
export function applyOp(config: unknown, op: AdminOp): unknown {
  const next = structuredClone(config ?? {}) as CaddyConfig;
  if (op.method === "PATCH") {
    const tag = op.path.replace(/^\/id\//, "");
    const swap = (node: unknown): boolean => {
      if (node === null || typeof node !== "object") return false;
      for (const [key, v] of Object.entries(node)) {
        if (v !== null && typeof v === "object" && (v as CaddyConfig)["@id"] === tag) {
          (node as CaddyConfig)[key] = structuredClone(op.body);
          return true;
        }
        if (swap(v)) return true;
      }
      return false;
    };
    if (!swap(next)) throw new Error(`unknown object ID '${tag}'`);
    return next;
  }
  const path = op.path
    .replace(/^\/config\/?/, "")
    .split("/")
    .filter((p) => p !== "")
    .map(decodeURIComponent);
  if (path.length === 0) return structuredClone(op.body);
  const parent = valueAt(next, path.slice(0, -1)) as CaddyConfig | unknown[];
  const last = path[path.length - 1] as string;
  if (Array.isArray(parent)) parent.splice(Number(last), 0, structuredClone(op.body));
  else parent[last] = structuredClone(op.body);
  return next;
}

// The file keeps its own indent: a tab, a number of spaces, or none for a file on one line.
export function formatLike(text: string, config: unknown): string {
  const unit = text.match(/\n([ \t]+)\S/)?.[1];
  const indent = unit === undefined ? 0 : unit.startsWith("\t") ? "\t" : unit.length;
  return `${JSON.stringify(config, null, indent)}${text.endsWith("\n") ? "\n" : ""}`;
}
