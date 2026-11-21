// devsite's user-space state: per-host last-used dates (#48) and per-host port files.
//
// Each dev-server start stamps `host → date` into last-used.json here; `doctor` lists the hosts unseen for 30+ days. User-space by design: the plugin writes only its own state, never `devsite.d`, which `init` owns.
//
// Plain .mjs for the same reason as vite.mjs, which imports it: Vite's config loader hands bare imports to the Node runtime, which won't execute TypeScript from node_modules.
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * @param {{ DEVSITE_STATE_DIR?: string; XDG_STATE_HOME?: string; [key: string]: string | undefined }} [env]
 * @param {string} [platform]
 * @param {string} [home]
 */
export function resolveStateDir(env = process.env, platform = process.platform, home = homedir()) {
  if (env.DEVSITE_STATE_DIR) return env.DEVSITE_STATE_DIR;
  if (platform === "darwin") return join(home, "Library", "Application Support", "devsite");
  return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "devsite");
}

let stampSeq = 0;

/**
 * Stamp `host → today` (UTC date) into last-used.json, preserving other hosts' entries. Rejects on failure — the caller decides how loudly.
 *
 * The `dir` default is evaluated at call time, synchronously — so an env-based redirect (tests) cannot be restored out from under a stamp that is still in flight, and callers can inject a dir directly.
 *
 * @param {string} host
 * @param {string} [dir]
 */
export async function stampLastUsed(host, dir = resolveStateDir()) {
  const file = join(dir, "last-used.json");
  await mkdir(dir, { recursive: true });
  // Null prototype, so every host name is stampable — on a plain object, assigning to "__proto__" is a silent no-op.
  /** @type {Record<string, string>} */
  const stamps = Object.create(null);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(stamps, parsed);
    }
  } catch (err) {
    // Missing or unparseable — the data is advisory; start fresh. Any other read failure (EMFILE, EIO, …) must rethrow: writing from {} after one would silently drop every other host's entry.
    if (!(err instanceof SyntaxError) && /** @type {{code?: string}} */ (err).code !== "ENOENT") {
      throw err;
    }
  }
  stamps[host] = new Date().toISOString().slice(0, 10);
  // Write-then-rename: a reader (or a kill mid-write) never sees a truncated file. The tmp name is unique per call — pid against other processes, the counter against concurrent stamps in this one. Concurrent stampers can still lose one date to the other — acceptable for advisory data; a corrupted file is not.
  const tmp = join(dir, `.last-used.${process.pid}.${stampSeq++}.tmp`);
  await writeFile(tmp, `${JSON.stringify(stamps, null, 2)}\n`);
  await rename(tmp, file);
}

// The placeholder a host's port file holds while no dev server runs. Caddy raises a 503 that the host file's handle_errors answers; a server that died answers 502 instead (its route still dials the dead port), so the offline page can tell the two apart (#14).
export const PORT_PLACEHOLDER = "error 503";

/** @param {number} port */
export const liveProxy = (port) => `reverse_proxy 127.0.0.1:${port}`;

/**
 * The file the host's Caddyfile site block imports for its handler: the live proxy while a dev server runs, the placeholder otherwise. A missing file makes every `caddy reload` fail, so nothing deletes it.
 *
 * @param {string} host
 * @param {string} [dir]
 */
export function portFilePath(host, dir = resolveStateDir()) {
  return join(dir, "ports", `${host}.caddy`);
}

/**
 * Sync, so a dev server that exits right after its `close` event still leaves the placeholder behind.
 *
 * @param {string} host
 * @param {string} directive
 * @param {string} [dir]
 */
export function writePortFile(host, directive, dir = resolveStateDir()) {
  const file = portFilePath(host, dir);
  mkdirSync(dirname(file), { recursive: true });
  // Write-then-rename: a `caddy reload` never reads a truncated file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${directive}\n`);
  renameSync(tmp, file);
}
