// What makes a Mac able to serve `.internal` names (#110), for the node's check before it takes the route: a DNS server on UDP that answers `ip` for every name, and an open TCP port in place of Caddy.
import { afterEach } from "bun:test";
import { createSocket, type Socket } from "node:dgram";
import { type AddressInfo, createServer, isIPv6, type Server } from "node:net";

const open: (Socket | Server)[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
});

// The 16 bytes of an IPv6 address, or the 4 of an IPv4 one.
function bytesOf(ip: string): Buffer {
  if (!isIPv6(ip)) return Buffer.from(ip.split(".").map(Number));
  const [head = "", tail = ""] = ip.split("::");
  const groups = (s: string) => (s === "" ? [] : s.split(":").map((g) => Number.parseInt(g, 16)));
  const out = Buffer.alloc(16);
  groups(head).forEach((g, i) => {
    out.writeUInt16BE(g, i * 2);
  });
  groups(tail)
    .reverse()
    .forEach((g, i) => {
      out.writeUInt16BE(g, 14 - i * 2);
    });
  return out;
}

// dns: the address the DNS server answers, or null for no reply; a function gives it per query. caddy: false closes the port. Returns what the node's process gets.
export async function serving(
  ip: string,
  { dns = ip, caddy = true }: { dns?: string | null | (() => string | null); caddy?: boolean } = {},
): Promise<{ DEVSITE_DNSMASQ_AT: string; DEVSITE_CADDY_AT: string }> {
  const udp = createSocket("udp4");
  udp.on("message", (q, from) => {
    const address = typeof dns === "function" ? dns() : dns;
    if (address === null) return;
    let end = 12;
    while (q[end] !== 0) end += (q[end] ?? 0) + 1;
    const question = q.subarray(12, end + 5);
    const data = bytesOf(address);
    const head = Buffer.from([q[0] ?? 0, q[1] ?? 0, 0x85, 0x80, 0, 1, 0, 1, 0, 0, 0, 0]);
    const answer = Buffer.from([
      ...[0xc0, 0x0c, 0, data.length === 16 ? 28 : 1, 0, 1],
      ...[0, 0, 0, 0, 0, data.length],
    ]);
    udp.send(Buffer.concat([head, question, answer, data]), from.port, from.address);
  });
  await new Promise<void>((r) => udp.bind(0, "127.0.0.1", r));
  const tcp = createServer((s) => s.destroy());
  await new Promise<void>((r) => tcp.listen(0, "127.0.0.1", r));
  const caddyPort = (tcp.address() as AddressInfo).port;
  if (caddy) open.push(tcp);
  else await new Promise((r) => tcp.close(r));
  open.push(udp);
  return {
    DEVSITE_DNSMASQ_AT: `127.0.0.1:${udp.address().port}`,
    DEVSITE_CADDY_AT: `127.0.0.1:${caddyPort}`,
  };
}
