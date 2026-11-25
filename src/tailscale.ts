// Tailscale as init and doctor read it: this Mac's Tailscale IP, and the split DNS route that sends the phone's `.internal` lookups to the main Mac's dnsmasq. The node writes the route (src/node/main-mac.ts); init and doctor only read it.
import type { Result } from "./checks";
import type { CliContext } from "./context";
import { exec } from "./io";
import { hasSecret } from "./keychain";
import type { PeerState } from "./node/server";
import { nodeLog } from "./paths";

export const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
export const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
export const SPLIT_DNS_DOMAIN = "internal";
export const TRUST_CREDENTIALS_URL =
  "https://console.tailscale.com/admin/settings/trust-credentials";
const SPLIT_DNS_LABEL =
  "the Tailscale split DNS route for .internal points to a Mac whose node answers";
const SECRET_LABEL =
  "the login Keychain holds the Tailscale OAuth client secret, so the node can write the split DNS route";

export type TailscaleIp = { state: "absent" } | { state: "no-ip" } | { state: "ip"; ip: string };

// The Mac App Store and standalone Tailscale apps put no `tailscale` on PATH; their CLI sits inside the app.
function tailscale(args: string[], ctx: CliContext) {
  const r = exec("tailscale", args, ctx, true);
  return r.error ? exec(TAILSCALE_APP_CLI, args, ctx, true) : r;
}

// A Tailscale switched off with `tailscale down` still reports its IP (`tailscale ip -4` too), so only BackendState "Running" counts as an IP in use.
export function tailscaleIp(ctx: CliContext): TailscaleIp {
  const r = tailscale(["status", "--json"], ctx);
  if (r.error) return { state: "absent" };
  let status: { BackendState?: unknown; Self?: { TailscaleIPs?: unknown } };
  try {
    status = JSON.parse(r.out);
  } catch {
    return { state: "no-ip" };
  }
  const ips = Array.isArray(status.Self?.TailscaleIPs) ? status.Self.TailscaleIPs : [];
  const ip = ips.find((a): a is string => typeof a === "string" && IPV4.test(a));
  return status.BackendState !== "Running" || ip === undefined
    ? { state: "no-ip" }
    : { state: "ip", ip };
}

// The nameservers of the `internal` route, or null when `tailscale dns status` gives no answer. Its section reads `Split DNS Routes:`, then one `  - <domain> -> <nameserver>` line per nameserver; Tailscale marks the format as preliminary.
function splitDnsNameservers(ctx: CliContext): string[] | null {
  const r = tailscale(["dns", "status"], ctx);
  if (r.status !== 0) return null;
  const lines = r.out.split("\n");
  const start = lines.findIndex((l) => l.trim() === "Split DNS Routes:");
  if (start === -1) return [];
  const out: string[] = [];
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s*-\s+(\S+)\s+->\s+(\S+)\s*$/);
    if (m === null) {
      if (l.trim() === "" || /^\S/.test(l)) break;
      continue;
    }
    if (m[1]?.replace(/\.$/, "").toLowerCase() === SPLIT_DNS_DOMAIN && m[2]) out.push(m[2]);
  }
  return out;
}

// `tailscale status` lists one device per line: its Tailscale IP, then its name.
function deviceName(ip: string, ctx: CliContext): string | null {
  const r = tailscale(["status"], ctx);
  if (r.status !== 0) return null;
  for (const l of r.out.split("\n")) {
    const [addr, name] = l.trim().split(/\s+/);
    if (addr === ip && name) return name;
  }
  return null;
}

export type SplitDns =
  | { state: "this-mac" }
  | { state: "none" }
  | { state: "unreadable" }
  // The route names nameservers that are not this Mac, each with its device's name when Tailscale lists it.
  | { state: "elsewhere"; ips: string[]; others: string[] };

export function readSplitDns(ip: string, ctx: CliContext): SplitDns {
  const nameservers = splitDnsNameservers(ctx);
  if (nameservers === null) return { state: "unreadable" };
  if (nameservers.length === 0) return { state: "none" };
  const others = nameservers.filter((n) => n !== ip);
  if (others.length === 0) return { state: "this-mac" };
  return {
    state: "elsewhere",
    ips: others,
    others: others.map((n) => {
      const name = deviceName(n, ctx);
      return name === null
        ? `${n}, another device's Tailscale IP`
        : `${n}, the Tailscale IP of ${name}`;
    }),
  };
}

// What `tailscale dns status` shows, for a route that is not this Mac's alone.
export function splitDnsDetail(split: Exclude<SplitDns, { state: "this-mac" }>): string {
  switch (split.state) {
    case "none":
      return "no route";
    case "unreadable":
      return "`tailscale dns status` gave no answer";
    case "elsewhere":
      return `it points to ${split.others.join("; ")}`;
  }
}

// The route may name this Mac or another Mac of this user whose node answers, on any protocol: that Mac is the main Mac, and its node relays to every other Mac (#66).
function splitDnsCheck(
  ip: string,
  split: SplitDns,
  peers: PeerState[],
  secretHeld: boolean,
  ctx: CliContext,
): Result {
  if (split.state === "this-mac") {
    return { state: "green", label: `${SPLIT_DNS_LABEL} (this Mac, ${ip})` };
  }
  const main =
    split.state === "elsewhere" && split.ips.length === 1
      ? peers.find((p) => p.ip === split.ips[0] && /-protocol$/.test(p.state))
      : undefined;
  if (main !== undefined) {
    return { state: "green", label: `${SPLIT_DNS_LABEL} (${main.mac}, ${main.ip})` };
  }
  const label = SPLIT_DNS_LABEL;
  const detail = splitDnsDetail(split);
  if (split.state === "unreadable") {
    return {
      state: "red",
      label,
      detail,
      fix: "update Tailscale, so `tailscale dns status` lists the split DNS routes",
    };
  }
  const log = nodeLog(ctx.env);
  if (!secretHeld) {
    return {
      state: "red",
      label,
      detail,
      fix: "the node writes the route once the login Keychain holds the OAuth client secret: see the check above",
    };
  }
  return {
    state: "red",
    label,
    detail,
    fix:
      split.state === "none"
        ? `the node writes the route within 10 s; its log says why it has not: ${log}`
        : `the node takes the route over about 6 s after the Mac it names stops answering; its log says why it has not: ${log}`,
  };
}

function secretCheck(ctx: CliContext): Result {
  return hasSecret(ctx)
    ? { state: "green", label: SECRET_LABEL }
    : {
        state: "red",
        label: SECRET_LABEL,
        detail: "no secret",
        fix: "run `bunx devsite init`. It asks for a Tailscale OAuth client secret and tells you where to create one.",
        repair: "tailscale-secret",
      };
}

// A Mac with no Tailscale gets none: devsite runs no dnsmasq there. peers: the other Macs' nodes, as this Mac's node reaches them.
export function tailscaleChecks(t: TailscaleIp, peers: PeerState[], ctx: CliContext): Result[] {
  const upLabel = "Tailscale is up";
  if (t.state === "absent") return [];
  if (t.state === "no-ip") {
    return [
      {
        state: "red",
        label: upLabel,
        detail: "Tailscale is down (no IP)",
        fix: "start Tailscale and log in",
      },
      {
        state: "skipped",
        label: SPLIT_DNS_LABEL,
        detail: "Tailscale is down (no IP)",
      },
    ];
  }
  const split = readSplitDns(t.ip, ctx);
  const secret = secretCheck(ctx);
  return [
    { state: "green", label: `${upLabel}, with IP ${t.ip}` },
    secret,
    splitDnsCheck(t.ip, split, peers, secret.state === "green", ctx),
  ];
}
