// A Mac as init and doctor see it: a scratch Caddy dir, a test CA, a local mock of Caddy's admin API, and a real node in-process.
import { afterEach, beforeAll } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type AdminOp, applyOp } from "../src/caddy-json";
import { NODE_ROUTE_FILE, renderGuardFile, renderNodeRoute } from "../src/commands/init";
import { type RunningNode, startNode } from "../src/node/server";
import { scratchCaddyfile } from "./helpers";

export const HOST = "web.internal";

// The other CA comes with its key and its own served chain, so a test can import it as a second Mac's root.
export type Pki = {
  root: string;
  rootKey: string;
  served: string;
  otherRoot: string;
  otherKey: string;
  otherServed: string;
};
export const pki: Pki = {
  root: "",
  rootKey: "",
  served: "",
  otherRoot: "",
  otherKey: "",
  otherServed: "",
};

function openssl(args: string[], cwd: string) {
  const r = spawnSync("openssl", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`openssl ${args.join(" ")}: ${r.stderr}`);
}

// Two CAs: the one in Caddy's storage (root → intermediate → leaf, the chain Caddy serves) and an unrelated one.
function makePki() {
  const dir = mkdtempSync(join(tmpdir(), "devsite-pki-"));
  const req = (name: string, cn: string) =>
    openssl(
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2"].concat([
        "-keyout",
        `${name}.key`,
        "-out",
        `${name}.crt`,
        "-subj",
        `/CN=${cn}`,
      ]),
      dir,
    );
  const signed = (name: string, cn: string, ca: string) => {
    openssl(
      ["req", "-newkey", "rsa:2048", "-nodes", "-keyout", `${name}.key`].concat([
        "-out",
        `${name}.csr`,
        "-subj",
        `/CN=${cn}`,
      ]),
      dir,
    );
    openssl(
      ["x509", "-req", "-in", `${name}.csr`, "-CA", `${ca}.crt`, "-CAkey", `${ca}.key`].concat([
        "-CAcreateserial",
        "-days",
        "2",
        "-out",
        `${name}.crt`,
      ]),
      dir,
    );
  };
  req("root", "Test Root");
  req("other", "Other Root");
  signed("inter", "Test Intermediate", "root");
  signed("leaf", HOST, "inter");
  signed("otherInter", "Other Intermediate", "other");
  signed("otherLeaf", HOST, "otherInter");
  const read = (n: string) => readFileSync(join(dir, `${n}.crt`), "utf8");
  const key = (n: string) => readFileSync(join(dir, `${n}.key`), "utf8");
  Object.assign(pki, {
    root: read("root"),
    rootKey: key("root"),
    served: read("leaf") + read("inter"),
    otherRoot: read("other"),
    otherKey: key("other"),
    otherServed: read("otherLeaf") + read("otherInter"),
  });
}

// --- the admin API mock ---

const servers: Server[] = [];

// Each suite calls this once at its top: a hook registered at this module's load would bind only to the first suite that imports it.
export function useMachine() {
  const saved = {
    admin: process.env.DEVSITE_CADDY_ADMIN,
    node: process.env.DEVSITE_NODE,
    home: process.env.DEVSITE_USER_HOME,
  };
  beforeAll(makePki);
  afterEach(async () => {
    process.env.DEVSITE_CADDY_ADMIN = saved.admin;
    process.env.DEVSITE_NODE = saved.node;
    process.env.DEVSITE_USER_HOME = saved.home;
    await Promise.all(nodes.splice(0).map((n) => n.close()));
    await Promise.all(
      servers.splice(0).map((s) => {
        s.closeAllConnections();
        return new Promise((r) => s.close(r));
      }),
    );
  });
}

// The live config the mock serves, which a scripted `caddy reload` of a JSON file replaces with loadAdminConfig.
let liveConfig: unknown = null;
export function loadAdminConfig(config: unknown) {
  liveConfig = config;
}

// Each PUT and PATCH the mock took, in order.
export const adminWrites: { method: string; path: string; body: unknown }[] = [];

// Serves `routes` as server srv0's route list, as Caddy's GET /config/apps/http/servers does, or `config` as the whole live config (GET /config/); `storage` as the live config's storage (Caddy answers null when there is none), and `caRoot` as the local CA's root, as GET /pki/ca/local does. A PUT or PATCH changes the live config as Caddy's admin API does.
export async function mockAdmin(
  routes: unknown[],
  opts: { caRoot?: string; storage?: object; config?: object | null } = {},
) {
  adminWrites.length = 0;
  liveConfig =
    opts.config === undefined
      ? { apps: { http: { servers: { srv0: { listen: [":443"], routes } } } } }
      : opts.config;
  const json = (res: import("node:http").ServerResponse, body: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = createServer(async (req, res) => {
    if (req.method === "PUT" || req.method === "PATCH") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const op = { method: req.method, path: req.url ?? "", body: JSON.parse(body) };
      adminWrites.push(op);
      try {
        liveConfig = applyOp(liveConfig, { ...op, shown: "" } as AdminOp);
      } catch (e) {
        res.statusCode = 404;
        json(res, { error: (e as Error).message });
        return;
      }
      res.end();
      return;
    }
    if (req.method !== "GET") {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url === "/config/") {
      json(res, liveConfig);
      return;
    }
    if (req.url === "/config/apps/http/servers") {
      json(
        res,
        (liveConfig as { apps?: { http?: { servers?: unknown } } } | null)?.apps?.http?.servers ??
          null,
      );
      return;
    }
    if (req.url === "/config/storage") {
      json(res, opts.storage ?? null);
      return;
    }
    if (req.url === "/pki/ca/local" && opts.caRoot !== undefined) {
      json(res, { id: "local", root_certificate: opts.caRoot });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.env.DEVSITE_CADDY_ADMIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// devsite's route as Caddy holds it once it loaded devsite.d: what `caddy adapt` makes of the files init writes.
export function nodeRoute(): unknown {
  const dir = mkdtempSync(join(tmpdir(), "devsite-adapt-"));
  writeFileSync(join(dir, "guard.caddy"), renderGuardFile());
  writeFileSync(join(dir, NODE_ROUTE_FILE), renderNodeRoute());
  writeFileSync(join(dir, "Caddyfile"), `import ${join(dir, NODE_ROUTE_FILE)}\n`);
  const r = spawnSync("caddy", ["adapt", "--config", join(dir, "Caddyfile")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`caddy adapt failed: ${r.stderr}`);
  const servers = JSON.parse(r.stdout).apps.http.servers as Record<string, { routes: unknown[] }>;
  return Object.values(servers)[0]?.routes[0];
}

// --- the node ---

const nodes: RunningNode[] = [];

// A real node in this process, on a free port and the test's home, with each project registered as `bun dev` registers it. Its dev server ports answer nothing, so no project is live.
export async function useNodeWith(
  projects: Record<string, { folder?: string; devsiteVersion?: string }> = {},
  { peerPort }: { peerPort?: number } = {},
) {
  const home = process.env.DEVSITE_USER_HOME ?? "";
  const node = await startNode({
    port: 0,
    peerPort,
    env: {
      DEVSITE_USER_HOME: home,
      DEVSITE_TAILSCALE: process.env.DEVSITE_TAILSCALE,
      DEVSITE_SECURITY: process.env.DEVSITE_SECURITY,
      DEVSITE_TAILSCALE_API: process.env.DEVSITE_TAILSCALE_API,
      DEVSITE_SLEEP_LISTENER: process.env.DEVSITE_SLEEP_LISTENER,
      DEVSITE_DNSMASQ_AT: process.env.DEVSITE_DNSMASQ_AT,
      DEVSITE_CADDY_AT: process.env.DEVSITE_CADDY_AT,
    },
  });
  nodes.push(node);
  process.env.DEVSITE_NODE = `http://127.0.0.1:${node.port}`;
  let port = 1;
  for (const [name, p] of Object.entries(projects)) {
    await fetch(`http://127.0.0.1:${node.port}/projects/${name}`, {
      method: "PUT",
      body: JSON.stringify({
        port: port++,
        folder: p.folder ?? `/Users/me/Projects/${name}`,
        ...p,
      }),
    });
  }
  return node;
}

// --- the scratch Caddy dir ---

export type Machine = {
  caddyfile: string;
  dir: string;
  storage: string;
  prefix: string;
  home: string;
};

// A Caddy dir as init leaves it: Homebrew's caddy binary in the scratch prefix (unless `installed` is false), a Caddyfile that pins storage and asks the node (or `caddyfile`, with STORAGE standing for the storage path), the CA root in that storage, and devsite.d with devsite's route and guard snippet (unless `devsiteFiles` is false). A fresh home holds devsite's own files.
export function setUpMachine(
  opts: {
    root?: string | null;
    caddyfile?: string;
    installed?: boolean;
    devsiteFiles?: boolean;
  } = {},
): Machine {
  const caddyfile = scratchCaddyfile();
  const dir = dirname(caddyfile);
  const prefix = dirname(dir);
  if (opts.installed !== false) {
    // As Homebrew lays it out: the formula under opt/, and bin/caddy a link to it.
    mkdirSync(join(prefix, "opt", "caddy", "bin"), { recursive: true });
    writeFileSync(join(prefix, "opt", "caddy", "bin", "caddy"), "");
    mkdirSync(join(prefix, "bin"));
    symlinkSync(join(prefix, "opt", "caddy", "bin", "caddy"), join(prefix, "bin", "caddy"));
  }
  const storage = join(dir, "storage");
  const text = opts.caddyfile ?? SET_UP_CADDYFILE;
  writeFileSync(caddyfile, text.replaceAll("STORAGE", storage));
  const root = opts.root === undefined ? pki.root : opts.root;
  if (root !== null) {
    const local = join(storage, "pki", "authorities", "local");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "root.crt"), root);
  }
  const home = mkdtempSync(join(tmpdir(), "devsite-home-"));
  process.env.DEVSITE_USER_HOME = home;
  if (opts.devsiteFiles !== false) {
    mkdirSync(join(dir, "devsite.d"));
    writeFileSync(join(dir, "devsite.d", NODE_ROUTE_FILE), renderNodeRoute());
    writeFileSync(join(dir, "devsite.d", "guard.caddy"), renderGuardFile());
  }
  return { caddyfile, dir, storage, prefix, home };
}

// devsite's route file as an older devsite left it, so init rewrites it.
export function staleRoute(m: Machine): Machine {
  writeFileSync(
    join(m.dir, "devsite.d", NODE_ROUTE_FILE),
    `# an older devsite\n${renderNodeRoute()}`,
  );
  return m;
}

// A Caddyfile with a global options block of the user's own, as init leaves it: init keeps the block as it is.
export const USER_CADDYFILE = [
  "{",
  "\temail dev@example.com",
  "\tstorage file_system {",
  '\t\troot "STORAGE"',
  "\t}",
  "\ton_demand_tls {",
  "\t\task http://127.0.0.1:47380/tls-allowed",
  "\t}",
  "}",
  "",
  "import devsite.d/*.caddy # devsite",
  "",
].join("\n");

// The Caddyfile init writes on a Mac with no Caddyfile and Caddy's storage at STORAGE.
export const SET_UP_CADDYFILE = [
  "{",
  "\t# Pin PKI storage so Caddy's local CA is the SAME no matter how Caddy runs",
  "\t# it (the always-on service vs a foreground process). Every device trusts",
  "\t# this one CA root: STORAGE/pki/authorities/local/root.crt",
  "\tstorage file_system {",
  '\t\troot "STORAGE"',
  "\t}",
  "\t# devsite: Caddy asks the devsite node before it signs a certificate for a name.",
  "\ton_demand_tls {",
  "\t\task http://127.0.0.1:47380/tls-allowed",
  "\t}",
  "}",
  "",
  "import devsite.d/*.caddy # devsite",
  "",
].join("\n");

// Every file under dir with its content: a run that wrote nothing leaves it equal.
export function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) {
      const p = join(f.parentPath, f.name);
      out[p] = readFileSync(p, "utf8");
    }
  }
  return out;
}
