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
export function initPrintsJson(install: KnownInstall, settings: Settings): boolean {
  if (install.configKind === "caddyfile") return false;
  if (install.configKind === "api") return settings.caddy.reload === "manual";
  return readJsonConfig(install.config) === null;
}

// What `caddy adapt` makes of devsite's route and the ask, untagged.
export type DevsiteObjects = { route: object; errors: object; policy: object; ask: object };

// One admin API request. A PUT to a path whose last segment is an array index inserts there; any other PUT sets a key the config lacks.
export type AdminOp = { method: "PUT" | "PATCH"; path: string; body: unknown; shown: string };

type Json = Record<string, unknown>;

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
    if ((node as Json)["@id"] === tag) return node;
    for (const v of Object.values(node)) {
      const found = findTagged(v, tag);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function at(config: unknown, path: string[]): unknown {
  let node = config;
  for (const key of path) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Json)[key];
  }
  return node;
}

const urlOf = (path: string[]) => `/config/${path.map(encodeURIComponent).join("/")}`;

// Sets the value at path with one PUT at the first key the config lacks, because Caddy's PUT needs the parent to exist.
function putPath(config: unknown, path: string[], value: unknown, shown: string): AdminOp {
  let i = 0;
  while (i < path.length && at(config, path.slice(0, i + 1)) !== undefined) i++;
  if (i === path.length) throw new Error(`${urlOf(path)} already exists`);
  let body = value;
  for (let j = path.length - 1; j > i; j--) body = { [path[j] as string]: body };
  return { method: "PUT", path: urlOf(path.slice(0, i + 1)), body, shown };
}

// First place in the array at path, or a new array.
function putFirst(config: unknown, path: string[], item: unknown, shown: string): AdminOp {
  return Array.isArray(at(config, path))
    ? { method: "PUT", path: urlOf([...path, "0"]), body: item, shown }
    : putPath(config, path, [item], shown);
}

// The ops that bring devsite's objects in config up to date, in the order they run. Each op is planned against the config the ops before it leave, so a later op never recreates a parent an earlier one made.
export function planOps(config: CaddyConfig | null, objects: DevsiteObjects): AdminOp[] {
  let current: unknown = config ?? {};
  const ops: AdminOp[] = [];
  const push = (op: AdminOp | null) => {
    if (op === null) return;
    ops.push(op);
    current = applyOp(current, op);
  };
  // A tagged object anywhere is devsite's: replaced by tag when it differs, wherever the user moved it.
  const replace = (tag: string, want: object, what: string): AdminOp | null | undefined => {
    const live = findTagged(current, tag);
    if (live === undefined) return undefined;
    return isDeepStrictEqual(live, want)
      ? null
      : { method: "PATCH", path: `/id/${tag}`, body: want, shown: `replaces ${what} (${tag})` };
  };

  const servers = (at(current, ["apps", "http", "servers"]) ?? {}) as Json;
  const targets = Object.keys(servers).filter((s) => listensOn443(servers[s]));
  if (targets.length === 0) {
    const route = tagged(TAG.route(SERVER), objects.route);
    const errors = tagged(TAG.errors(SERVER), objects.errors);
    const server = { listen: [":443"], routes: [route], errors: { routes: [errors] } };
    push(
      putPath(
        current,
        ["apps", "http", "servers", SERVER],
        server,
        `adds a server ${SERVER} that listens on :443, with devsite's route`,
      ),
    );
  }
  for (const s of targets) {
    const route = tagged(TAG.route(s), objects.route);
    const r = replace(TAG.route(s), route, `devsite's route in server ${s}`);
    push(
      r !== undefined
        ? r
        : putFirst(
            current,
            ["apps", "http", "servers", s, "routes"],
            route,
            `adds devsite's route first in server ${s}`,
          ),
    );
    const errors = tagged(TAG.errors(s), objects.errors);
    const e = replace(TAG.errors(s), errors, `devsite's "node not running" page in server ${s}`);
    push(
      e !== undefined
        ? e
        : putFirst(
            current,
            ["apps", "http", "servers", s, "errors", "routes"],
            errors,
            `adds devsite's "node not running" page first in the error routes of server ${s}`,
          ),
    );
  }

  const policy = tagged(TAG.policy, objects.policy);
  const p = replace(TAG.policy, policy, "devsite's TLS policy");
  push(
    p !== undefined
      ? p
      : putFirst(
          current,
          ["apps", "tls", "automation", "policies"],
          policy,
          "adds devsite's TLS policy first: Caddy's own CA signs each devsite name at its first visit",
        ),
  );

  // An ask of the user's own has no tag and stays, as the Caddyfile path keeps a user's on_demand_tls block.
  const ask = tagged(TAG.ask, objects.ask);
  const k = replace(TAG.ask, ask, "devsite's on-demand ask");
  const path = ["apps", "tls", "automation", "on_demand"];
  push(
    k !== undefined
      ? k
      : at(current, path) !== undefined
        ? null
        : putPath(
            current,
            path,
            ask,
            "sets the on-demand ask: Caddy asks the node before it signs a certificate",
          ),
  );
  return ops;
}

// What an op does to a config, as Caddy's admin API does it: for a JSON file init edits, and for the plan of the ops after it.
export function applyOp(config: unknown, op: AdminOp): unknown {
  const next = structuredClone(config ?? {}) as Json;
  if (op.method === "PATCH") {
    const tag = op.path.replace(/^\/id\//, "");
    const swap = (node: unknown): boolean => {
      if (node === null || typeof node !== "object") return false;
      for (const [key, v] of Object.entries(node)) {
        if (v !== null && typeof v === "object" && (v as Json)["@id"] === tag) {
          (node as Json)[key] = structuredClone(op.body);
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
  const parent = at(next, path.slice(0, -1)) as Json | unknown[];
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
