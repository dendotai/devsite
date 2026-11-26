// The `internal` split DNS route through Tailscale's API (#110), with an OAuth client secret of the `dns` scope. The API docs: https://tailscale.com/kb/1215/oauth-clients (the token), and the API's OpenAPI schema (`getSplitDns`, `updateSplitDns`).
import { SPLIT_DNS_DOMAIN } from "../tailscale";

export type ApiEnv = { DEVSITE_TAILSCALE_API?: string };

const API_MS = 5000;

// DEVSITE_TAILSCALE_API points the node at a fake of the API in tests.
const base = (env: ApiEnv) => env.DEVSITE_TAILSCALE_API || "https://api.tailscale.com";

// The tailnet `-` names the tailnet that owns the credential.
const splitDnsUrl = (env: ApiEnv) => `${base(env)}/api/v2/tailnet/-/dns/split-dns`;

export type SplitDnsApi = {
  // The nameservers of the route, [] for none; null when the API gave no answer.
  read: () => Promise<string[] | null>;
  write: (ip: string) => Promise<boolean>;
};

// The secret carries its client ID (`tskey-client-<ID>-<secret>`); Tailscale's own client sends a placeholder ID with it (feature/oauthkey/oauthkey.go).
const clientIdOf = (secret: string) => secret.match(/^tskey-client-([^-]+)-/)?.[1] ?? "";

export function makeSplitDnsApi(secret: string, env: ApiEnv): SplitDnsApi {
  // Each token lasts an hour; it is taken again a minute before it ends.
  let token: { value: string; until: number } | null = null;

  const accessToken = async (): Promise<string | null> => {
    if (token !== null && token.until > Date.now()) return token.value;
    const res = await fetch(`${base(env)}/api/v2/oauth/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientIdOf(secret),
        client_secret: secret,
      }),
      signal: AbortSignal.timeout(API_MS),
    });
    if (!res.ok) {
      console.error(`devsite node: Tailscale refused the OAuth client secret (HTTP ${res.status})`);
      return null;
    }
    const body = (await res.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string") return null;
    const seconds = typeof body.expires_in === "number" ? body.expires_in : 3600;
    token = { value: body.access_token, until: Date.now() + (seconds - 60) * 1000 };
    return token.value;
  };

  const call = async (init: RequestInit): Promise<Record<string, unknown> | null> => {
    try {
      const t = await accessToken();
      if (t === null) return null;
      const res = await fetch(splitDnsUrl(env), {
        ...init,
        headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(API_MS),
      });
      if (!res.ok) {
        console.error(`devsite node: Tailscale's split DNS API answered HTTP ${res.status}`);
        return null;
      }
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      console.error(`devsite node: Tailscale's API gave no answer: ${(err as Error).message}`);
      return null;
    }
  };

  const nameservers = (map: Record<string, unknown>) => {
    const list = map[SPLIT_DNS_DOMAIN];
    return Array.isArray(list) ? list.filter((n): n is string => typeof n === "string") : [];
  };

  return {
    read: async () => {
      const map = await call({ method: "GET" });
      return map === null ? null : nameservers(map);
    },
    // PATCH changes only the domains it names, so the user's other routes stay.
    write: async (ip) => {
      const map = await call({
        method: "PATCH",
        body: JSON.stringify({ [SPLIT_DNS_DOMAIN]: [ip] }),
      });
      return map !== null && nameservers(map).join() === ip;
    },
  };
}
