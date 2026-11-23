// The install seam: where this Mac's Caddy lives and how it runs, so init and doctor never assume one install. This file knows the Homebrew kind; another kind stops init with a message that names the caddy.config setting.
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { CliContext } from "./context";
import { exec } from "./io";
import { type CaddyUser, type Settings, settingsPath } from "./settings";

export type CaddyProcess = {
  pid: number;
  ppid: number;
  user: string;
  binary: string;
  config: string | null;
  adapter: string | null;
};

// "json": a config file of another format, which Caddy loads as JSON; "api": no config file, the config came through the admin API. init can load neither, because a reload of a Caddyfile would replace that config.
type ConfigFile =
  | { configKind: "caddyfile" | "json"; config: string }
  | { configKind: "api"; config: null };

export type CaddyInstall =
  | { kind: "unknown"; why: string }
  | (ConfigFile & {
      // "other": a kind devsite does not know, with the paths from the caddy.config setting.
      kind: "homebrew" | "other";
      prefix: string | null;
      installed: boolean;
      configSource: string;
      devsiteDir: string;
      log: string | null;
      running: CaddyProcess | null;
      manager: string | null;
      user: CaddyUser;
      userSource: string;
    });

export type KnownInstall = Exclude<CaddyInstall, { kind: "unknown" }>;

// `caddy run` is the process every way of starting Caddy leaves behind (`caddy start` forks one). ps joins argv with spaces, so --config is read up to the next flag, which keeps a path with spaces whole.
function findCaddyProcess(ctx: CliContext): CaddyProcess | null {
  const r = exec("ps", ["-axo", "pid=,ppid=,user=,args="], ctx, true);
  if (r.status !== 0) return null;
  for (const line of r.out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (m === null) continue;
    const args = m[4] as string;
    const [binary = "", sub] = args.split(/\s+/);
    if (!/(?:^|\/)caddy$/.test(binary) || sub !== "run") continue;
    const config = args.match(/\s--config[= ](.+?)(?=\s--|$)/)?.[1]?.trim() ?? null;
    const adapter = args.match(/\s--adapter[= ](\S+)/)?.[1] ?? null;
    return { pid: Number(m[1]), ppid: Number(m[2]), user: m[3] as string, binary, config, adapter };
  }
  return null;
}

type BrewService = { pid?: number | null; log_path?: string | null };

function brewService(ctx: CliContext): BrewService | null {
  const r = exec("brew", ["services", "info", "caddy", "--json"], ctx, true);
  if (r.status !== 0) return null;
  try {
    return (JSON.parse(r.out) as BrewService[])[0] ?? null;
  } catch {
    return null;
  }
}

// DEVSITE_BREW_PREFIX points the seam at a scratch Homebrew prefix in tests, in place of `brew --prefix`.
export function brewPrefix(ctx: CliContext): string | null {
  if (ctx.env.DEVSITE_BREW_PREFIX) return ctx.env.DEVSITE_BREW_PREFIX;
  const r = exec("brew", ["--prefix"], ctx, true);
  return r.status === 0 && r.out !== "" ? r.out : null;
}

function realpath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function findCaddy(settings: Settings, ctx: CliContext): CaddyInstall {
  const prefix = brewPrefix(ctx);
  const proc = findCaddyProcess(ctx);
  // Homebrew links every formula it installed at <prefix>/opt/<formula>; its bin/caddy and the Cellar binary resolve to the same file. A caddy put under the prefix by hand (on Intel, /usr/local/bin) has no opt link.
  const formula = prefix === null ? null : realpath(join(prefix, "opt", "caddy", "bin", "caddy"));
  // A bare `caddy` in argv came from PATH, so it is Homebrew's when the PATH caddy under the prefix is.
  const fromBrew = (binary: string) =>
    formula !== null &&
    realpath(binary === "caddy" ? join(prefix as string, "bin", "caddy") : binary) === formula;
  const homebrew = prefix !== null && (proc === null || fromBrew(proc.binary));
  const set = settings.caddy;

  if (set.config === undefined && !homebrew) {
    const why =
      proc !== null
        ? `Caddy runs from ${proc.binary}, which is not Homebrew's Caddy`
        : "Homebrew is not on this Mac";
    return { kind: "unknown", why };
  }

  const apiOnly = set.config === undefined && proc !== null && proc.config === null;
  let file: ConfigFile = { configKind: "api", config: null };
  if (!apiOnly) {
    const config = set.config ?? proc?.config ?? join(prefix as string, "etc", "Caddyfile");
    const adapter = set.config === undefined ? (proc?.adapter ?? null) : null;
    file = { configKind: isCaddyfile(config, adapter) ? "caddyfile" : "json", config };
  }
  const configSource =
    set.config !== undefined
      ? "the caddy.config setting"
      : proc === null
        ? "Homebrew's default"
        : apiOnly
          ? `Caddy runs (pid ${proc.pid}) with no --config, so its config came through the admin API`
          : "the running Caddy's --config";

  const service = homebrew && proc !== null ? brewService(ctx) : null;
  let manager: string | null = null;
  if (proc !== null) {
    if (service?.pid === proc.pid) manager = "brew services";
    else if (proc.ppid === 1) manager = "launchd";
    else manager = `a foreground process (pid ${proc.pid})`;
  }

  const log =
    service?.log_path ?? (homebrew ? join(prefix as string, "var", "log", "caddy.log") : null);

  const user: CaddyUser = set.user ?? (proc?.user === "root" ? "root" : "user");
  const userSource =
    set.user !== undefined
      ? "the caddy.user setting"
      : proc !== null
        ? "the running Caddy"
        : "devsite's default";

  return {
    kind: homebrew ? "homebrew" : "other",
    prefix: homebrew ? prefix : null,
    installed: proc !== null || formula !== null || !homebrew,
    ...file,
    configSource,
    devsiteDir: join(
      file.config === null ? join(prefix as string, "etc") : dirname(file.config),
      "devsite.d",
    ),
    log,
    running: proc,
    manager,
    user,
    userSource,
  };
}

// Caddy's own rule (cmd/main.go, isCaddyfile): the caddyfile adapter by flag, or with no adapter a file named Caddyfile* or *.caddyfile; any other file loads as JSON.
function isCaddyfile(config: string, adapter: string | null): boolean {
  if (adapter !== null) return adapter === "caddyfile";
  const base = basename(config).toLowerCase();
  if (base.endsWith(".json")) return false;
  return base.startsWith("caddyfile") || base.endsWith(".caddyfile");
}

export function unknownFix(ctx: CliContext): string {
  return `set caddy.config to the path of your main Caddy config in ${settingsPath(ctx)}`;
}

export function describeKind(install: KnownInstall): string {
  return install.kind === "homebrew"
    ? `Homebrew at ${install.prefix}`
    : "an install devsite does not know";
}
