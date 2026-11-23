// Tailscale as devsite reads it: this Mac's Tailscale IP, and the split DNS route that sends the phone's `.internal` lookups to this Mac's dnsmasq. The route is set only in the Tailscale admin console, so devsite reads it and never writes it.
import type { Result } from "./checks";
import type { CliContext } from "./context";
import { exec } from "./io";

const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
export const ADMIN_DNS_URL = "https://login.tailscale.com/admin/dns";
export const SPLIT_DNS_DOMAIN = "internal";
export const TWO_MACS_ISSUE = "https://github.com/dendotai/devsite/issues/66";
const SPLIT_DNS_LABEL = "the Tailscale split DNS route for .internal points to this Mac";

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
  | { state: "elsewhere"; others: string[] };

export function readSplitDns(ip: string, ctx: CliContext): SplitDns {
  const nameservers = splitDnsNameservers(ctx);
  if (nameservers === null) return { state: "unreadable" };
  if (nameservers.length === 0) return { state: "none" };
  const others = nameservers.filter((n) => n !== ip);
  if (others.length === 0) return { state: "this-mac" };
  return {
    state: "elsewhere",
    others: others.map((n) => {
      const name = deviceName(n, ctx);
      return name === null
        ? `${n}, another device's Tailscale IP`
        : `${n}, the Tailscale IP of ${name}`;
    }),
  };
}

export const splitDnsValues = (ip: string) => [
  `nameserver: ${ip}`,
  `restrict to domain: ${SPLIT_DNS_DOMAIN}`,
];

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

// Two Macs on one tailnet each want the route to point to themselves (#66): devsite names the other device and leaves the choice to the user.
export function splitDnsCheck(ip: string, split: SplitDns): Result {
  const label = `${SPLIT_DNS_LABEL} (${ip})`;
  if (split.state === "this-mac") return { state: "green", label };
  const detail = splitDnsDetail(split);
  const add = `add a split DNS nameserver in the Tailscale admin console (${ADMIN_DNS_URL}): domain ${SPLIT_DNS_DOMAIN}, nameserver ${ip}`;
  switch (split.state) {
    case "none":
      return { state: "red", label, detail, fix: add, repair: "split-dns" };
    case "unreadable":
      return {
        state: "red",
        label,
        detail,
        fix: "update Tailscale, so `tailscale dns status` lists the split DNS routes",
      };
    case "elsewhere":
      return {
        state: "red",
        label,
        detail,
        fix: `change the nameserver of the domain ${SPLIT_DNS_DOMAIN} to ${ip} in the Tailscale admin console (${ADMIN_DNS_URL}), so the phone opens this Mac's projects: it opens one Mac's projects per tailnet (${TWO_MACS_ISSUE})`,
        repair: "split-dns",
      };
  }
}

// This Mac's Tailscale IP with the route as Tailscale lists it.
export type SplitDnsRoute = { ip: string; split: SplitDns };

// route is null with no Tailscale IP.
export type TailscaleProbe = { route: SplitDnsRoute | null; checks: Result[] };

// A Mac with no Tailscale gets no checks: devsite runs no dnsmasq there.
export function probeTailscale(t: TailscaleIp, ctx: CliContext): TailscaleProbe {
  const upLabel = "Tailscale is up";
  if (t.state === "absent") return { route: null, checks: [] };
  if (t.state === "no-ip") {
    return {
      route: null,
      checks: [
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
      ],
    };
  }
  const split = readSplitDns(t.ip, ctx);
  return {
    route: { ip: t.ip, split },
    checks: [{ state: "green", label: `${upLabel}, with IP ${t.ip}` }, splitDnsCheck(t.ip, split)],
  };
}
