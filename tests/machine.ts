// A Mac as init and doctor see it: a scratch Caddy dir, a test CA, and a local mock of Caddy's admin API.
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
import {
  OFFLINE_FRAGMENT,
  renderGuardFile,
  renderHostFile,
  renderOfflineFragment,
} from "../src/commands/init";
import { guardedRoute } from "../src/guard.mjs";
import { PORT_PLACEHOLDER, portFilePath, writePortFile } from "../src/state.mjs";
import { scratchCaddyfile } from "./helpers";

export const HOST = "web.test.internal";

export type Pki = { root: string; served: string; otherRoot: string };
export const pki: Pki = { root: "", served: "", otherRoot: "" };

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
  const read = (n: string) => readFileSync(join(dir, `${n}.crt`), "utf8");
  Object.assign(pki, {
    root: read("root"),
    served: read("leaf") + read("inter"),
    otherRoot: read("other"),
  });
}

// --- the admin API mock ---

const servers: Server[] = [];

// Each suite calls this once at its top: a hook registered at this module's load would bind only to the first suite that imports it.
export function useMachine() {
  const savedAdmin = process.env.DEVSITE_CADDY_ADMIN;
  const savedState = process.env.DEVSITE_STATE_DIR;
  beforeAll(makePki);
  afterEach(async () => {
    if (savedAdmin === undefined) delete process.env.DEVSITE_CADDY_ADMIN;
    else process.env.DEVSITE_CADDY_ADMIN = savedAdmin;
    process.env.DEVSITE_STATE_DIR = savedState;
    await Promise.all(
      servers.splice(0).map((s) => {
        s.closeAllConnections();
        return new Promise((r) => s.close(r));
      }),
    );
  });
}

// Serves `routes` as server srv0's route list, as Caddy's GET /config/apps/http/servers does; `storage` as the live config's storage (Caddy answers null when there is none), and `caRoot` as the local CA's root, as GET /pki/ca/local does.
export async function mockAdmin(
  routes: unknown[],
  opts: { caRoot?: string; storage?: object } = {},
) {
  const json = (res: import("node:http").ServerResponse, body: unknown) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    if (req.method !== "GET") {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url === "/config/apps/http/servers") {
      json(res, { srv0: { listen: [":443"], routes } });
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

export const placeholder = () =>
  guardedRoute([HOST], [{ handler: "static_response", status_code: 503 }]);

// --- the scratch Caddy dir ---

export type Machine = {
  caddyfile: string;
  dir: string;
  storage: string;
  prefix: string;
  stateDir: string;
};

// A Caddy dir as init leaves it: Homebrew's caddy binary in the scratch prefix (unless `installed` is false), a Caddyfile that pins storage (or `caddyfile`, with STORAGE standing for the storage path), the CA root in that storage, and one host file of project "web" beside devsite's guard snippet and offline page file (unless `offlineFragment` is false). A fresh state dir holds the host's port file (unless `portFile` is false).
export function setUpMachine(
  opts: {
    root?: string | null;
    hostFile?: string | null;
    caddyfile?: string;
    installed?: boolean;
    portFile?: boolean;
    offlineFragment?: boolean;
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
  const text =
    opts.caddyfile ??
    '{\n\tstorage file_system {\n\t\troot "STORAGE"\n\t}\n}\n\nimport devsite.d/*.caddy # devsite\n';
  writeFileSync(caddyfile, text.replace("STORAGE", storage));
  const root = opts.root === undefined ? pki.root : opts.root;
  if (root !== null) {
    const local = join(storage, "pki", "authorities", "local");
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "root.crt"), root);
  }
  const stateDir = mkdtempSync(join(tmpdir(), "devsite-state-"));
  process.env.DEVSITE_STATE_DIR = stateDir;
  if (opts.portFile !== false) writePortFile(HOST, PORT_PLACEHOLDER, stateDir);
  const hostFile = opts.hostFile === undefined ? hostFileOf("web") : opts.hostFile;
  if (hostFile !== null) {
    mkdirSync(join(dir, "devsite.d"));
    writeFileSync(join(dir, "devsite.d", `${HOST}.caddy`), hostFile);
    writeFileSync(join(dir, "devsite.d", "guard.caddy"), renderGuardFile());
    if (opts.offlineFragment !== false) writeOfflineFragment(join(dir, "devsite.d"));
  }
  return { caddyfile, dir, storage, prefix, stateDir };
}

// The offline page file in a devsite dir, where init writes it; page stands in for assets/offline.html.
export function writeOfflineFragment(devsiteDir: string, page?: string) {
  mkdirSync(join(devsiteDir, dirname(OFFLINE_FRAGMENT)), { recursive: true });
  writeFileSync(join(devsiteDir, OFFLINE_FRAGMENT), renderOfflineFragment(page));
}

// The host file init writes for HOST, for the state dir the latest setUpMachine set.
export function hostFileOf(project: string): string {
  return renderHostFile({ host: HOST, project }, portFilePath(HOST, process.env.DEVSITE_STATE_DIR));
}

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
