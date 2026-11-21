// The machine settings in ~/.config/devsite/config.json: each one hands a change devsite would make to a shared thing over to the user (ADR 0004).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "./context";

export type CaddyUser = "user" | "root";

export type Settings = {
  caddy: {
    // The main Caddy config, for an install devsite does not know.
    config?: string;
    // The user Caddy runs as; overrides what devsite found.
    user?: CaddyUser;
    // "manual": init writes devsite's files and the user reloads Caddy.
    reload?: "manual";
  };
};

export function settingsPath(ctx: CliContext): string {
  const base = ctx.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "devsite", "config.json");
}

const RULES: Record<keyof Settings["caddy"], { valid: (v: unknown) => boolean; expected: string }> =
  {
    config: {
      valid: (v) => typeof v === "string" && v.startsWith("/"),
      expected: "an absolute path",
    },
    user: { valid: (v) => v === "user" || v === "root", expected: '"user" or "root"' },
    reload: { valid: (v) => v === "manual", expected: '"manual"' },
  };

// A missing file is no settings. A file devsite cannot use stops the command: a setting the user wrote and devsite ignored would act on the shared thing the user took over.
export function readSettings(
  ctx: CliContext,
): { ok: true; settings: Settings } | { ok: false; error: string } {
  const path = settingsPath(ctx);
  if (!existsSync(path)) return { ok: true, settings: { caddy: {} } };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  const caddy = (raw as { caddy?: unknown } | null)?.caddy ?? {};
  if (typeof caddy !== "object" || caddy === null || Array.isArray(caddy)) {
    return { ok: false, error: `${path}: "caddy" must be an object` };
  }
  for (const [key, value] of Object.entries(caddy)) {
    const rule = RULES[key as keyof Settings["caddy"]];
    if (rule === undefined) {
      return {
        ok: false,
        error: `${path}: unknown setting caddy.${key} (known: ${Object.keys(RULES)
          .map((k) => `caddy.${k}`)
          .join(", ")})`,
      };
    }
    if (!rule.valid(value)) {
      return {
        ok: false,
        error: `${path}: caddy.${key} must be ${rule.expected}, not ${JSON.stringify(value)}`,
      };
    }
  }
  return { ok: true, settings: { caddy: caddy as Settings["caddy"] } };
}
