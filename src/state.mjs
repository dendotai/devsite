// devsite's user-space state: per-host last-used dates (#48).
//
// Each dev-server start stamps `host → date` into last-used.json here, so a
// future `clean`/`doctor` can flag hosts unseen for N days. No reader ships
// yet — the data only accrues. User-space by design: the Vite plugin runs
// unprivileged and cannot touch the sudo-owned devsite.d files.
//
// Plain .mjs for the same reason as vite.mjs (its only importer): Vite's
// config loader hands bare imports to the Node runtime, which won't execute
// TypeScript from node_modules.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

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
 * Stamp `host → today` (UTC date) into last-used.json, preserving other
 * hosts' entries. Rejects on failure — the caller decides how loudly.
 *
 * The `dir` default is evaluated at call time, synchronously — so an
 * env-based redirect (tests) cannot be restored out from under a stamp that
 * is still in flight, and callers can inject a dir directly.
 *
 * @param {string} host
 * @param {string} [dir]
 */
export async function stampLastUsed(host, dir = resolveStateDir()) {
  const file = join(dir, "last-used.json");
  await mkdir(dir, { recursive: true });
  // Null prototype, so every host name is stampable — on a plain object,
  // assigning to "__proto__" is a silent no-op.
  /** @type {Record<string, string>} */
  const stamps = Object.create(null);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      Object.assign(stamps, parsed);
    }
  } catch (err) {
    // Missing or unparseable — the data is advisory; start fresh. Any other
    // read failure (EMFILE, EIO, …) must rethrow: writing from {} after one
    // would silently drop every other host's entry.
    if (!(err instanceof SyntaxError) && /** @type {{code?: string}} */ (err).code !== "ENOENT") {
      throw err;
    }
  }
  stamps[host] = new Date().toISOString().slice(0, 10);
  // Write-then-rename: a reader (or a kill mid-write) never sees a truncated
  // file. The tmp name is unique per call — pid against other processes, the
  // counter against concurrent stamps in this one. Concurrent stampers can
  // still lose one date to the other — acceptable for advisory data; a
  // corrupted file is not.
  const tmp = join(dir, `.last-used.${process.pid}.${stampSeq++}.tmp`);
  await writeFile(tmp, `${JSON.stringify(stamps, null, 2)}\n`);
  await rename(tmp, file);
}
