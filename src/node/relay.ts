// The relay (#109): a request for a name live on another Mac goes over HTTPS to that Mac's Caddy, never to its dev server, which stays on 127.0.0.1 behind the LAN guard (ADR 0002). Every Mac serves from one CA root (#104), so this Mac's root checks the other Mac's certificate.
import type { IncomingMessage, ServerResponse } from "node:http";
import { Agent, request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { caddy } from "../caddy-admin";
import { addressOf, type Peer } from "./tailnet";

// The receiving node serves a request with this header from its own projects only, so two nodes never pass one request back and forth.
export const RELAYED_HEADER = "devsite-relayed";

// Every Mac's Caddy listens on 443; DEVSITE_PEER_CADDY_PORT gives the test's stand-in Caddy its port.
export type RelayEnv = { DEVSITE_PEER_CADDY_PORT?: string };
const caddyPort = (env: RelayEnv) => Number(env.DEVSITE_PEER_CADDY_PORT) || 443;

const ADMIN_MS = 2000;
// A Mac that sleeps or left the tailnet drops the packets, so a relay with no answer gives up: the TLS handshake of a WebSocket after CONNECT_MS, a request with no response headers after RESPONSE_MS, which leaves a dev server time to build a large module.
const CONNECT_MS = 1500;
const RESPONSE_MS = 10_000;

// A page loads many modules, so the TLS connections to each Caddy stay open between requests.
const agent = new Agent({ keepAlive: true });

// root: another CA root signed the certificate. tls: the handshake failed for another reason (a name the certificate does not hold, an alert from that Caddy). unreachable: no answer.
export type RelayFailure =
  | { kind: "no-root" | "root" | "unreachable" }
  | { kind: "tls"; code: string };

const ROOT_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "CERT_SIGNATURE_FAILURE",
]);

// bun puts the code on the error, Node on its cause.
const codeOf = (err: unknown) => {
  const e = err as { code?: unknown; cause?: { code?: unknown } };
  return String(e.code ?? e.cause?.code ?? "");
};

// An upgrade request as it arrived, written again for the next hop, which then carries the raw bytes both ways.
export function requestHead(req: IncomingMessage, extraHeaders: string[] = []): string {
  const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  return `${[...lines, ...extraHeaders].join("\r\n")}\r\n\r\n`;
}

const hostnameOf = (host: string) => host.replace(/:\d+$/, "");

function failureText(failure: RelayFailure, host: string, peer: Peer, port: number): string {
  const name = hostnameOf(host);
  const at = addressOf(peer.ip, port);
  switch (failure.kind) {
    case "no-root":
      return `devsite: ${name} runs on ${peer.mac}, and this Mac's node cannot read the CA root from Caddy's admin API (GET /pki/ca/local), so it cannot check ${peer.mac}'s certificate.\n`;
    case "root":
      return `devsite: ${name} runs on ${peer.mac}, whose Caddy serves a certificate this Mac's CA root does not sign. Run \`devsite ca export\` on this Mac, and pipe its output into \`devsite init --ca -\` on ${peer.mac}.\n`;
    case "tls":
      return `devsite: ${name} runs on ${peer.mac}, and the TLS handshake with its Caddy at ${at} failed (${failure.code}).\n`;
    case "unreachable":
      return `devsite: ${name} runs on ${peer.mac}, and its Caddy does not answer at ${at}.\n`;
  }
}

export function makeRelay(env: RelayEnv) {
  // Read once and kept until another root signs a certificate, as `init --ca -` can replace this Mac's root.
  let root: string | null = null;

  const readRoot = async (): Promise<string | null> => {
    if (root !== null) return root;
    try {
      const res = await caddy("/pki/ca/local", { signal: AbortSignal.timeout(ADMIN_MS) });
      if (!res.ok) return null;
      const pem = ((await res.json()) as { root_certificate?: unknown }).root_certificate;
      root = typeof pem === "string" ? pem : null;
      return root;
    } catch {
      return null;
    }
  };

  const failureOf = (err: unknown): RelayFailure => {
    const code = codeOf(err);
    if (ROOT_CODES.has(code)) {
      root = null;
      return { kind: "root" };
    }
    if (/CERT|SSL|TLS|ALTNAME/.test(code)) return { kind: "tls", code };
    return { kind: "unreachable" };
  };

  const send = async (
    req: IncomingMessage,
    res: ServerResponse,
    peer: Peer,
  ): Promise<RelayFailure | null> => {
    const ca = await readRoot();
    if (ca === null) return { kind: "no-root" };
    const host = req.headers.host ?? "";
    return new Promise((resolve) => {
      const up = httpsRequest({
        host: peer.ip,
        port: caddyPort(env),
        servername: hostnameOf(host),
        ca,
        agent,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, [RELAYED_HEADER]: "1" },
      });
      const noAnswer = setTimeout(() => up.destroy(new Error("no response")), RESPONSE_MS);
      up.on("response", (r) => {
        clearTimeout(noAnswer);
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
        r.on("error", () => res.destroy());
        resolve(null);
      });
      let browserLeft = false;
      up.on("error", (err) => {
        clearTimeout(noAnswer);
        if (browserLeft) return resolve(null);
        if (res.headersSent) {
          res.destroy();
          return resolve(null);
        }
        resolve(failureOf(err));
      });
      res.on("close", () => {
        if (res.writableFinished) return;
        browserLeft = true;
        up.destroy();
      });
      req.pipe(up);
    });
  };

  // HMR's WebSocket.
  const tunnel = async (
    req: IncomingMessage,
    socket: Socket,
    head: Buffer,
    peer: Peer,
  ): Promise<RelayFailure | null> => {
    const ca = await readRoot();
    if (ca === null) return { kind: "no-root" };
    return new Promise((resolve) => {
      let connected = false;
      const up = tlsConnect(
        {
          host: peer.ip,
          port: caddyPort(env),
          servername: hostnameOf(req.headers.host ?? ""),
          ca,
        },
        () => {
          connected = true;
          clearTimeout(noAnswer);
          up.write(requestHead(req, [`${RELAYED_HEADER}: 1`]));
          if (head.length > 0) up.write(head);
          socket.pipe(up).pipe(socket);
          resolve(null);
        },
      );
      const noAnswer = setTimeout(() => up.destroy(new Error("no handshake")), CONNECT_MS);
      up.on("error", (err) => {
        clearTimeout(noAnswer);
        if (connected) return socket.destroy();
        resolve(failureOf(err));
      });
      socket.on("error", () => up.destroy());
    });
  };

  const explain = (failure: RelayFailure, host: string, peer: Peer) =>
    failureText(failure, host, peer, caddyPort(env));

  return { send, tunnel, explain };
}
