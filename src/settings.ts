// The machine settings in devsite's Application Support folder: each one hands a change devsite would make to a shared thing over to the user (ADR 0004).
import { existsSync, readFileSync } from "node:fs";
import type { CliContext } from "./context";
import { settingsFile } from "./paths";

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
  dnsmasq: {
    // "manual": init runs no dnsmasq of devsite's, and the user makes a DNS server answer .internal on the Tailscale IP.
    run?: "manual";
  };
};

export function settingsPath(ctx: CliContext): string {
  return settingsFile(ctx.env);
}

type Rule = { valid: (v: unknown) => boolean; expected: string };

const RULES: { [S in keyof Settings]: Record<keyof Settings[S], Rule> } = {
  caddy: {
    config: {
      valid: (v) => typeof v === "string" && v.startsWith("/"),
      expected: "an absolute path",
    },
    user: { valid: (v) => v === "user" || v === "root", expected: '"user" or "root"' },
    reload: { valid: (v) => v === "manual", expected: '"manual"' },
  },
  dnsmasq: {
    run: { valid: (v) => v === "manual", expected: '"manual"' },
  },
};

const known = Object.entries(RULES)
  .flatMap(([section, rules]) => Object.keys(rules).map((k) => `${section}.${k}`))
  .join(", ");

// A missing file is no settings. A file devsite cannot use stops the command: a setting the user wrote and devsite ignored would act on the shared thing the user took over.
export function readSettings(
  ctx: CliContext,
): { ok: true; settings: Settings } | { ok: false; error: string } {
  const path = settingsPath(ctx);
  const settings: Settings = { caddy: {}, dnsmasq: {} };
  if (!existsSync(path)) return { ok: true, settings };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `${path} is not valid JSON: ${(err as Error).message}` };
  }
  for (const [section, value] of Object.entries(raw ?? {})) {
    const rules = RULES[section as keyof Settings] as Record<string, Rule> | undefined;
    if (rules === undefined) {
      return { ok: false, error: `${path}: unknown section ${section} (known: ${known})` };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: `${path}: ${section} must be an object` };
    }
    for (const [key, v] of Object.entries(value)) {
      const rule = rules[key];
      if (rule === undefined) {
        return { ok: false, error: `${path}: unknown setting ${section}.${key} (known: ${known})` };
      }
      if (!rule.valid(v)) {
        return {
          ok: false,
          error: `${path}: ${section}.${key} must be ${rule.expected}, not ${JSON.stringify(v)}; delete the key to use the default`,
        };
      }
    }
    Object.assign(settings[section as keyof Settings], value);
  }
  return { ok: true, settings };
}
