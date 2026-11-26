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
// name: this Mac's Tailscale device name. macs: every other Mac of this user; peers: those Tailscale lists as online.
export type Tailnet = { ips: string[]; name: string; user: number; macs: Peer[]; peers: Peer[] };

// DEVSITE_TAILSCALE names the CLI the node runs, for a stand-in in tests. The Mac App Store and standalone Tailscale apps put no `tailscale` on PATH; their CLI sits inside the app.
// That CLI, run with no terminal as launchd runs the node, starts the Tailscale GUI and prints no answer; TAILSCALE_BE_CLI=1 makes it act as the CLI.
function tailscale(args: string[], env: TailnetEnv): Promise<string | null> {
  const run = (cmd: string) =>
    new Promise<{ out: string | null; missing: boolean }>((resolve) => {
      const cliEnv = { ...process.env, TAILSCALE_BE_CLI: "1" };
      execFile(cmd, args, { timeout: TAILSCALE_MS, env: cliEnv }, (err, stdout) => {
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

// This Mac's Tailscale IPs and user, and the other Macs of the same user: a phone runs no node. A request asks only those Tailscale lists as online, which spares a wait on a Mac that sleeps; the takeover vote asks every Mac. null when Tailscale is not running.
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
  const peerOf = (d: Device): Peer[] => {
    if (d.OS !== "macOS" || d.UserID !== user) return [];
    const ips = ipsOf(d);
    const ip = ips.find((a) => IPV4.test(a)) ?? ips[0];
    return ip !== undefined && typeof d.HostName === "string" ? [{ mac: d.HostName, ip }] : [];
  };
  const devices = Object.values(s.Peer ?? {});
  const macs = devices.flatMap(peerOf);
  const peers = devices.filter((d) => d.Online !== false).flatMap(peerOf);
  const name = typeof s.Self.HostName === "string" ? s.Self.HostName : "";
  return { ips: ipsOf(s.Self), name, user, macs, peers };
}

// The Tailscale user who owns a tailnet IP, and every IP of that device; null for an address outside the tailnet.
export async function whois(
  ip: string,
  env: TailnetEnv,
): Promise<{ user: number; ips: string[] } | null> {
  const out = await tailscale(["whois", "--json", ip], env);
  if (out === null) return null;
  try {
    const w = JSON.parse(out) as { Node?: { Addresses?: unknown }; UserProfile?: { ID?: unknown } };
    const id = w.UserProfile?.ID;
    if (typeof id !== "number") return null;
    const addresses = Array.isArray(w.Node?.Addresses) ? w.Node.Addresses : [];
    const ips = addresses.flatMap((a) => (typeof a === "string" ? [a.replace(/\/\d+$/, "")] : []));
    return { user: id, ips };
  } catch {
    return null;
  }
}

// denied: a node on this protocol refused the call (its whois named another user). refused: the Mac is reachable and nothing listens on the port (no devsite, or its node stopped). timeout: no reply (the Mac sleeps, is off, or its firewall drops the call). not-a-node: another program on the port: an answer with no protocol header, one that is no HTTP, or a connection it closes.
export type PeerAnswer =
  | { state: "answer"; body: unknown }
  | { state: "other-protocol"; protocol: number | null }
  | { state: "refused" | "timeout" | "not-a-node" | "denied" };

// bun puts the code on the error, Node on its cause.
const codeOf = (err: unknown) => {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return e.code ?? e.cause?.code;
};

// The Mac is out of reach, as a Mac that sleeps or is off.
const NO_ROUTE = new Set(["EHOSTUNREACH", "ENETUNREACH", "EHOSTDOWN", "ETIMEDOUT"]);

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
    const code = codeOf(err);
    if (code === "ECONNREFUSED") return { state: "refused" };
    const noReply = (err as Error).name === "TimeoutError" || NO_ROUTE.has(String(code));
    return noReply ? { state: "timeout" } : { state: "not-a-node" };
  }
}

// A node whose peer port another program holds on its Tailscale IP listens on the first free port of these instead, so every node can find it with no lookup service.
export const fallbackPorts = (port: number) => [1, 2, 3, 4].map((i) => port + i);

// Nothing, or another program, at the port: the Mac's node may listen on a fallback port. A timeout is not one: the Mac sleeps or drops the call, and its fallback ports would wait as long.
const nodeMayBeElsewhere = (a: PeerAnswer) => a.state === "refused" || a.state === "not-a-node";
// A node answered: on this protocol or another, or with a refusal of its own.
const fromNode = (a: PeerAnswer) => !nodeMayBeElsewhere(a) && a.state !== "timeout";

export type PeerCaller = {
  // askPeer at the peer port; after a refusal or another program's answer there, at the fallback ports, all at once.
  ask: (peer: Peer, path: string) => Promise<PeerAnswer>;
  // The fallback port the peer's node last answered on, else the peer port.
  portOf: (peer: Peer) => number;
};

export function makePeerCaller(peersAt: () => number): PeerCaller {
  // Peer IP → the fallback port its node answered on.
  const found = new Map<string, number>();
  const ask = async (peer: Peer, path: string): Promise<PeerAnswer> => {
    const known = found.get(peer.ip);
    if (known !== undefined) {
      const a = await askPeer(peer, known, path);
      if (!nodeMayBeElsewhere(a)) return a;
      found.delete(peer.ip);
    }
    const first = await askPeer(peer, peersAt(), path);
    if (!nodeMayBeElsewhere(first)) return first;
    const tries = await Promise.all(
      fallbackPorts(peersAt()).map(async (port) => ({ port, a: await askPeer(peer, port, path) })),
    );
    const hit = tries.find((t) => fromNode(t.a));
    if (hit === undefined) return first;
    found.set(peer.ip, hit.port);
    return hit.a;
  };
  return { ask, portOf: (peer) => found.get(peer.ip) ?? peersAt() };
}
