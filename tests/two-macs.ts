// Nodes on two Macs of one tailnet (#66), as two real nodes on loopback: this Mac's Tailscale IP is 127.0.0.1 and the other Mac's is ::1, both on one peer port, as every Mac uses one fixed port. The fake tailscale gives each node its own `status --json` and `whois --json` answers.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { startTestNode } from "./node-helpers";

export const ME = 1001;
export const SOMEONE_ELSE = 2002;
export const THIS_MAC = { ip: "127.0.0.1", name: "MacBook Pro" };
export const OTHER_MAC = { ip: "::1", name: "Mac mini" };

type Device = { ip: string; name: string };

export function statusJson(self: Device, peers: Array<Device & { os?: string; user?: number }>) {
  return {
    BackendState: "Running",
    Self: { HostName: self.name, OS: "macOS", UserID: ME, TailscaleIPs: [self.ip] },
    Peer: Object.fromEntries(
      peers.map((p, i) => [
        `nodekey:${i}`,
        {
          HostName: p.name,
          OS: p.os ?? "macOS",
          UserID: p.user ?? ME,
          TailscaleIPs: [p.ip],
          Online: true,
        },
      ]),
    ),
  };
}

// caller: the device a call comes from, as Tailscale names its addresses.
const whois = (user: number, caller: Device) => ({
  Node: { User: user, Addresses: [`${caller.ip}/${caller.ip.includes(":") ? 128 : 32}`] },
  UserProfile: { ID: user },
});

// A port free on both loopback addresses, for a port every Mac shares.
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return port;
}

// This Mac's node and the other Mac's node, each of user ME, each seeing the other as a peer. On loopback a call comes from the address it goes to, so each node's whois answer is keyed by its own address. otherSeesCaller: the user the other Mac's whois names for every caller. hereEnv, thereEnv: what each node's process gets on top.
export async function twoMacs(
  opts: {
    otherSeesCaller?: number;
    hereEnv?: Record<string, string>;
    thereEnv?: Record<string, string>;
  } = {},
) {
  const peerPort = await freePort();
  const here = await startTestNode(undefined, {
    peerPort,
    env: opts.hereEnv,
    tailnet: {
      status: statusJson(THIS_MAC, [OTHER_MAC]),
      whois: { [THIS_MAC.ip]: whois(ME, OTHER_MAC) },
    },
  });
  const there = await startTestNode(undefined, {
    peerPort,
    env: opts.thereEnv,
    tailnet: {
      status: statusJson(OTHER_MAC, [THIS_MAC]),
      whois: { [OTHER_MAC.ip]: whois(opts.otherSeesCaller ?? ME, THIS_MAC) },
    },
  });
  return { here, there, peerPort };
}
