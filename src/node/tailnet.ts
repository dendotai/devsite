// The node's part of the tailnet (#66): the other Macs' nodes it asks, and the check it makes on each call it answers.
import { execFile } from "node:child_process";
import { IPV4, TAILSCALE_APP_CLI } from "../tailscale";

// Each call between nodes carries this number, and each answer carries the answering node's; a node on another number shows in `doctor`.
export const PROTOCOL = 1;
export const PROTOCOL_HEADER = "devsite-protocol";

// A Mac that is asleep or off drops the packets, so the call waits this long for no answer.
const PEER_MS = 1500;
const TAILSCALE_MS = 3000;

export type Peer = { mac: string; ip: string };
export type Tailnet = { ips: string[]; user: number; peers: Peer[] };

// DEVSITE_TAILSCALE names the CLI the node runs, for a stand-in in tests. The Mac App Store and standalone Tailscale apps put no `tailscale` on PATH; their CLI sits inside the app.
function tailscale(args: string[], env: TailnetEnv): Promise<string | null> {
  const run = (cmd: string) =>
    new Promise<{ out: string | null; missing: boolean }>((resolve) => {
      execFile(cmd, args, { timeout: TAILSCALE_MS }, (err, stdout) => {
        resolve({
          out: err ? null : stdout,
          missing: (err as { code?: unknown })?.code === "ENOENT",
        });
      });
    });
  if (env.DEVSITE_TAILSCALE) return run(env.DEVSITE_TAILSCALE).then((r) => r.out);
  return run("tailscale").then((r) =>
    r.missing ? run(TAILSCALE_APP_CLI).then((a) => a.out) : r.out,
  );
}

export type TailnetEnv = { DEVSITE_TAILSCALE?: string };

type Device = {
  HostName?: unknown;
  OS?: unknown;
  UserID?: unknown;
  TailscaleIPs?: unknown;
  Online?: unknown;
};

const ipsOf = (d: Device) =>
  Array.isArray(d.TailscaleIPs)
    ? d.TailscaleIPs.filter((a): a is string => typeof a === "string")
    : [];

// This Mac's Tailscale IPs and user, and the Macs of the same user that Tailscale lists as online: a phone runs no node, and Tailscale's own online flag spares a wait on a Mac that sleeps. null when Tailscale is not running.
export async function readTailnet(env: TailnetEnv): Promise<Tailnet | null> {
  const out = await tailscale(["status", "--json"], env);
  if (out === null) return null;
  let s: { BackendState?: unknown; Self?: Device; Peer?: Record<string, Device> };
  try {
    s = JSON.parse(out);
  } catch {
    return null;
  }
  const user = s.Self?.UserID;
  if (s.BackendState !== "Running" || s.Self === undefined || typeof user !== "number") return null;
  const peers = Object.values(s.Peer ?? {}).flatMap((d): Peer[] => {
    if (d.OS !== "macOS" || d.UserID !== user || d.Online === false) return [];
    const ips = ipsOf(d);
    const ip = ips.find((a) => IPV4.test(a)) ?? ips[0];
    return ip !== undefined && typeof d.HostName === "string" ? [{ mac: d.HostName, ip }] : [];
  });
  return { ips: ipsOf(s.Self), user, peers };
}

// The Tailscale user who owns a tailnet IP; null for an address outside the tailnet.
export async function whoisUser(ip: string, env: TailnetEnv): Promise<number | null> {
  const out = await tailscale(["whois", "--json", ip], env);
  if (out === null) return null;
  try {
    const id = (JSON.parse(out) as { UserProfile?: { ID?: unknown } }).UserProfile?.ID;
    return typeof id === "number" ? id : null;
  } catch {
    return null;
  }
}

// denied: a node on this protocol refused the call (its whois named another user). refused: the Mac is reachable and nothing listens on the port (no devsite, or its node stopped). timeout: no reply (the Mac sleeps, is off, or its firewall drops the call). not-a-node: a server with no protocol header, another program on the port.
export type PeerAnswer =
  | { state: "answer"; body: unknown }
  | { state: "other-protocol"; protocol: number | null }
  | { state: "refused" | "timeout" | "not-a-node" | "denied" };

// bun puts the code on the error, Node on its cause.
const codeOf = (err: unknown) => {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code ?? e.cause?.code;
};

// An IPv6 address takes brackets before its port.
export const addressOf = (ip: string, port: number) =>
  `${ip.includes(":") ? `[${ip}]` : ip}:${port}`;

export async function askPeer(peer: Peer, port: number, path: string): Promise<PeerAnswer> {
  try {
    const res = await fetch(`http://${addressOf(peer.ip, port)}${path}`, {
      headers: { [PROTOCOL_HEADER]: String(PROTOCOL) },
      signal: AbortSignal.timeout(PEER_MS),
    });
    const theirs = res.headers.get(PROTOCOL_HEADER);
    if (theirs === null) {
      await res.body?.cancel();
      return { state: "not-a-node" };
    }
    if (theirs !== String(PROTOCOL)) {
      await res.body?.cancel();
      const n = Number(theirs);
      return { state: "other-protocol", protocol: Number.isInteger(n) ? n : null };
    }
    if (!res.ok) {
      await res.body?.cancel();
      return { state: "denied" };
    }
    return { state: "answer", body: await res.json() };
  } catch (err) {
    return codeOf(err) === "ECONNREFUSED" ? { state: "refused" } : { state: "timeout" };
  }
}
