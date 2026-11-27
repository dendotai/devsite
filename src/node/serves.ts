// Whether this Mac can serve `.internal` names (#110): a Mac whose node answers but whose dnsmasq or Caddy does not would take every name down by taking the route.
import { Resolver } from "node:dns/promises";
import { connect, isIPv6 } from "node:net";
import { PROBE_NAME } from "../dnsmasq";
import { addressOf } from "./tailnet";

// DEVSITE_DNSMASQ_AT and DEVSITE_CADDY_AT (host:port) name stand-ins for this Mac's dnsmasq and Caddy in tests.
export type ServesEnv = { DEVSITE_DNSMASQ_AT?: string; DEVSITE_CADDY_AT?: string };

const DNS_MS = 500;
const CADDY_MS = 500;

async function dnsmasqAnswers(ip: string, env: ServesEnv): Promise<boolean> {
  const resolver = new Resolver({ timeout: DNS_MS, tries: 1 });
  resolver.setServers([env.DEVSITE_DNSMASQ_AT || addressOf(ip, 53)]);
  try {
    const answers = isIPv6(ip)
      ? await resolver.resolve6(PROBE_NAME)
      : await resolver.resolve4(PROBE_NAME);
    return answers.includes(ip);
  } catch {
    return false;
  }
}

function caddyAccepts(ip: string, env: ServesEnv): Promise<boolean> {
  const at = new URL(`tcp://${env.DEVSITE_CADDY_AT || addressOf(ip, 443)}`);
  return new Promise((resolve) => {
    const s = connect({ host: at.hostname.replace(/^\[|\]$/g, ""), port: Number(at.port) });
    const done = (ok: boolean) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(CADDY_MS, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

export async function servesNames(ip: string, env: ServesEnv): Promise<boolean> {
  const [dns, caddy] = await Promise.all([dnsmasqAnswers(ip, env), caddyAccepts(ip, env)]);
  return dns && caddy;
}
