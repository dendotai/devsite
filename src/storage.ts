// The storage Caddy already uses, so devsite never moves Caddy to a new CA the user's devices do not trust: the user's own `storage` line, else the running Caddy's data dir, else the data dir Caddy starts with.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { caddy } from "./caddy-admin";
import type { CliContext } from "./context";
import type { KnownInstall } from "./install";
import { exec } from "./io";

// root is null when devsite cannot read the storage: a kind other than file_system, or a running Caddy whose environment ps does not show (one of another user). fromConfig is true when the config names the storage, so init writes no pin.
export type Storage = { root: string | null; source: string; fromConfig: boolean };

type JsonStorage = { module?: string; root?: string } | null;

function fromCaddyfile(text: string): Storage | null {
  const source = "the Caddyfile's storage line";
  const block = text.match(/^\s*storage\s+file_system\s*\{[^}]*?^\s*root\s+"?([^"\n]+?)"?\s*$/m);
  const line = text.match(/^\s*storage\s+file_system\s+"?([^"{\s][^"\n]*?)"?\s*$/m);
  const root = block?.[1] ?? line?.[1];
  if (root !== undefined) return { root, source, fromConfig: true };
  const kind = text.match(/^\s*storage\s+(\S+)/m)?.[1];
  if (kind !== undefined)
    return { root: null, source: `${source}, storage ${kind}`, fromConfig: true };
  return null;
}

function fromJson(storage: JsonStorage, source: string): Storage | null {
  if (storage === null || typeof storage !== "object") return null;
  if (storage.module === "file_system" && typeof storage.root === "string") {
    return { root: storage.root, source, fromConfig: true };
  }
  return { root: null, source: `${source}, storage ${storage.module}`, fromConfig: true };
}

async function configuredStorage(install: KnownInstall): Promise<Storage | null> {
  if (install.configKind === "caddyfile") {
    const path = install.config;
    return fromCaddyfile(existsSync(path) ? readFileSync(path, "utf8") : "");
  }
  if (install.configKind === "json") {
    try {
      const json = JSON.parse(readFileSync(install.config, "utf8")) as { storage?: JsonStorage };
      return fromJson(json.storage ?? null, "the JSON config's storage");
    } catch {
      return null;
    }
  }
  try {
    const res = await caddy("/config/storage", { signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS) });
    return res.ok ? fromJson((await res.json()) as JsonStorage, "the live config's storage") : null;
  } catch {
    return null;
  }
}

// Caddy's AppDataDir (storage.go): $XDG_DATA_HOME/caddy, else $HOME/Library/Application Support/Caddy on macOS. ps shows the environment only of the user's own processes.
function runningDataDir(pid: number, ctx: CliContext): string | null {
  const r = exec("ps", ["-E", "-ww", "-o", "command=", "-p", String(pid)], ctx, true);
  if (r.status !== 0) return null;
  const env = (name: string) => r.out.match(new RegExp(`(?:^|\\s)${name}=(\\S+)`))?.[1];
  const xdg = env("XDG_DATA_HOME");
  if (xdg !== undefined) return join(xdg, "caddy");
  const home = env("HOME");
  return home === undefined ? null : join(home, "Library", "Application Support", "Caddy");
}

export async function findStorage(install: KnownInstall, ctx: CliContext): Promise<Storage> {
  const configured = await configuredStorage(install);
  if (configured !== null) return configured;
  if (install.running !== null) {
    const source = "the running Caddy's data dir";
    const root = runningDataDir(install.running.pid, ctx);
    return root === null
      ? {
          root: null,
          source: `${source}: Caddy runs as ${install.running.user}`,
          fromConfig: false,
        }
      : { root, source, fromConfig: false };
  }
  // A stopped Homebrew Caddy is started with `brew services`, whose formula sets XDG_DATA_HOME to <prefix>/var/lib.
  if (install.prefix !== null) {
    return {
      root: join(install.prefix, "var", "lib", "caddy"),
      source: "the data dir `brew services` gives Caddy",
      fromConfig: false,
    };
  }
  return {
    root: join(homedir(), "Library", "Application Support", "Caddy"),
    source: "Caddy's default",
    fromConfig: false,
  };
}

const ADMIN_TIMEOUT_MS = 2000;

export const rootCrtIn = (storageRoot: string) =>
  join(storageRoot, "pki", "authorities", "local", "root.crt");

// The CA root file of the storage; for a storage devsite cannot read, the running Caddy's root written to `fallback`, because `security verify-cert` and the phone both need a file.
export async function caRootFile(storage: Storage, fallback: string): Promise<string | null> {
  if (storage.root !== null) return rootCrtIn(storage.root);
  try {
    const res = await caddy("/pki/ca/local", { signal: AbortSignal.timeout(ADMIN_TIMEOUT_MS) });
    if (!res.ok) return null;
    const pem = ((await res.json()) as { root_certificate?: unknown }).root_certificate;
    if (typeof pem !== "string") return null;
    mkdirSync(dirname(fallback), { recursive: true });
    writeFileSync(fallback, pem);
    return fallback;
  } catch {
    return null;
  }
}
