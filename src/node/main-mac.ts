// Which Mac is the main Mac (#110): the one the `internal` split DNS route names. Its node writes the route; every other node follows it over one open connection that carries a signal each interval, and takes over when the main Mac says it is going or misses 3 signals.
import { type IncomingMessage, request, type ServerResponse } from "node:http";
import { readSecret } from "../keychain";
import { IPV4 } from "../tailscale";
import { type ServesEnv, servesNames } from "./serves";
import { type ApiEnv, makeSplitDnsApi, type SplitDnsApi } from "./split-dns-api";
import { askPeer, type Peer, PROTOCOL, PROTOCOL_HEADER, type Tailnet } from "./tailnet";

// The signal interval; 3 missed signals start a takeover. DEVSITE_SIGNAL_MS shortens it in tests.
export const SIGNAL_MS = 2000;
const MISSED = 3;
// How often the main Mac reads the route again, in signal intervals: another Mac may have written it while this one restarted or had no network, and nothing then tells this Mac.
const RECHECK = 15;
// A sleep that macOS cancels may send no wake, so the node reads the route again after this long.
const SLEEP_MS = 60_000;
const BEAT = "beat\n";
const GOING = "going\n";

export type MainMacEnv = ApiEnv &
  ServesEnv & { DEVSITE_SECURITY?: string; DEVSITE_SIGNAL_MS?: string };

// no-secret: the login Keychain holds no OAuth client secret. unknown: the route is not read yet, or Tailscale's API gave no answer; why says which.
export type RouteState =
  | { role: "main"; ip: string }
  | { role: "follower"; mac: string; ip: string }
  | { role: "no-secret" }
  | { role: "unknown"; why: string };

export type MainMac = {
  // Each tailnet refresh calls it; it reads the route when this node does not know it.
  tick: () => void;
  // Reads the secret and the route again now, whatever the state, for `init` once it stored the secret.
  settleNow: () => Promise<RouteState>;
  state: () => RouteState;
  // Whether this node can take the route, for another node's vote: it holds a secret that Tailscale's API did not just refuse, and its Mac serves `.internal` names. A node that just started reads the Keychain first, so it answers right.
  canWrite: () => Promise<boolean>;
  // Another node's open connection for signals.
  serveSignals: (req: IncomingMessage, res: ServerResponse) => void;
  // This Mac goes to sleep: tells every node that follows this one, and reads no route until the wake.
  sleep: () => Promise<void>;
  wake: () => void;
  // Tells every node that follows this one that it is going.
  close: () => Promise<void>;
};

type Deps = { env: MainMacEnv; tailnet: () => Tailnet | null; peersAt: () => number };

const sameList = (a: string[], b: string[]) => [...a].sort().join() === [...b].sort().join();

// The Tailscale device name decides which Mac takes over: the first in this order. Two Macs can have one name; then the IP decides, in an order every node computes alike.
const byName = (a: Peer, b: Peer) => {
  const [x, y] = [a.mac.toLowerCase(), b.mac.toLowerCase()];
  if (x !== y) return x < y ? -1 : 1;
  return a.ip > b.ip ? -1 : 1;
};

export const selfIp = (t: Tailnet) => t.ips.find((a) => IPV4.test(a)) ?? t.ips[0];

export function makeMainMac({ env, tailnet, peersAt }: Deps): MainMac {
  const signalMs = Number(env.DEVSITE_SIGNAL_MS) || SIGNAL_MS;
  let state: RouteState = { role: "unknown", why: "the route is not read yet" };
  let secret: string | null = null;
  let api: SplitDnsApi | null = null;
  // Whether Tailscale's API answered this node's last call.
  let apiAnswered = true;
  let busy: Promise<void> | null = null;
  // A read of the route that found no main Mac waits this long before the next one, so a node does not call Tailscale's API each signal.
  let nextSettle = 0;
  let sleepingUntil = 0;
  const signals = new Set<ServerResponse>();

  // The connection to the main Mac's node, while this node follows it.
  let follow: {
    peer: Peer;
    route: string[];
    lastSignal: number;
    conn: IncomingMessage | null;
    connecting: boolean;
  } | null = null;

  const log = (s: string) => console.error(`devsite node: ${s}`);

  const set = (next: RouteState) => {
    const was = JSON.stringify(state);
    state = next;
    if (JSON.stringify(next) === was) return;
    if (next.role === "main") log(`this Mac is the main Mac: the split DNS route names ${next.ip}`);
    if (next.role === "follower") log(`the main Mac is ${next.mac} (${next.ip})`);
    if (next.role === "unknown") log(`the main Mac is unknown: ${next.why}`);
  };

  const stopFollowing = () => {
    follow?.conn?.destroy();
    follow = null;
  };

  const loadApi = async (): Promise<SplitDnsApi | null> => {
    const read = await readSecret(env);
    if (read !== secret) {
      secret = read;
      api = read === null ? null : makeSplitDnsApi(read, env);
      apiAnswered = true;
    }
    return api;
  };

  const readRoute = async (a: SplitDnsApi): Promise<string[] | null> => {
    const route = await a.read();
    apiAnswered = route !== null;
    return route;
  };

  // Only one read or write of the route runs at a time.
  const exclusive = (work: () => Promise<void>): Promise<void> => {
    if (busy !== null) return busy;
    busy = work().finally(() => {
      busy = null;
    });
    return busy;
  };

  const settle = async () => {
    const t = tailnet();
    if (t === null) return set({ role: "unknown", why: "Tailscale is not running" });
    const a = await loadApi();
    if (a === null) {
      stopFollowing();
      return set({ role: "no-secret" });
    }
    const route = await readRoute(a);
    if (route === null) return set({ role: "unknown", why: "Tailscale's API gave no answer" });
    applyRoute(route, t);
    if (state.role === "unknown") await elect(null, route, t);
  };

  let nextRecheck = 0;

  const recheck = async () => {
    const t = tailnet();
    // Set before the read: a follower that leaves during it sets 0, so one more read follows.
    nextRecheck = Date.now() + RECHECK * signalMs;
    const route = api === null ? null : await readRoute(api);
    if (t !== null && route !== null) return applyRoute(route, t);
    // A read that failed runs again at the next tailnet refresh.
    nextRecheck = 0;
  };

  // A route that names a device Tailscale does not list as a Mac of this user is followed like a Mac: it counts as gone only after missed signals, never by Tailscale's online flag.
  const applyRoute = (route: string[], t: Tailnet) => {
    const ip = selfIp(t);
    if (ip !== undefined && route.includes(ip)) {
      stopFollowing();
      return set({ role: "main", ip });
    }
    const named = route[0];
    if (named === undefined) {
      stopFollowing();
      return set({ role: "unknown", why: "the split DNS route names no Mac" });
    }
    const peer = t.macs.find((p) => route.includes(p.ip)) ?? { mac: named, ip: named };
    if (follow?.peer.ip !== peer.ip) {
      stopFollowing();
      follow = { peer, route, lastSignal: Date.now(), conn: null, connecting: false };
      connect();
    }
    set({ role: "follower", mac: peer.mac, ip: peer.ip });
  };

  // gone: the main Mac that went, left out of the vote. seen: the route as this node last read it.
  const elect = async (gone: Peer | null, seen: string[], t: Tailnet) => {
    const ip = selfIp(t);
    const answers = await Promise.all(
      t.macs
        .filter((p) => p.ip !== gone?.ip)
        .map(async (p) => {
          const a = await askPeer(p, peersAt(), "/hello");
          const writes =
            a.state === "answer" && (a.body as { routeWriter?: unknown } | null)?.routeWriter;
          return writes === true ? [p] : [];
        }),
    );
    const voters: { mac: string; ip: string }[] = answers.flat();
    const serves = ip !== undefined && (await servesNames(ip, env));
    if (api !== null && ip !== undefined && serves) voters.push({ mac: t.name, ip });
    const first = voters.sort(byName)[0];
    if (first === undefined || first.ip !== ip || api === null || ip === undefined) {
      nextSettle = Date.now() + 2 * signalMs;
      return set({
        role: "unknown",
        why:
          first === undefined
            ? `${serves ? "no Mac's node can write" : "this Mac does not serve .internal names yet, and no other Mac can take over"} the split DNS route`
            : `${first.mac} takes over the split DNS route`,
      });
    }
    const now = await readRoute(api);
    if (now === null) return set({ role: "unknown", why: "Tailscale's API gave no answer" });
    if (!sameList(now, seen)) return applyRoute(now, t);
    // This Mac went to sleep during the vote: a Mac that sleeps serves nothing.
    if (Date.now() < sleepingUntil) return;
    if (!(await api.write(ip))) {
      apiAnswered = false;
      nextSettle = Date.now() + 2 * signalMs;
      return set({ role: "unknown", why: "Tailscale's API did not take the new route" });
    }
    log(`wrote ${ip} into the split DNS route for .internal`);
    stopFollowing();
    set({ role: "main", ip });
  };

  const takeOver = (why: string) => {
    if (follow === null) return;
    const { peer, route } = follow;
    log(`${peer.mac} ${why}: a takeover of the split DNS route starts`);
    stopFollowing();
    set({ role: "unknown", why: `${peer.mac} ${why}` });
    const t = tailnet();
    if (t !== null) void exclusive(() => elect(peer, route, t));
  };

  const connect = () => {
    const f = follow;
    if (f === null || f.conn !== null || f.connecting) return;
    f.connecting = true;
    const req = request({
      host: f.peer.ip,
      port: peersAt(),
      path: "/signals",
      headers: { [PROTOCOL_HEADER]: String(PROTOCOL) },
      timeout: signalMs,
    });
    req.on("response", (res) => {
      f.connecting = false;
      if (follow !== f) return res.destroy();
      // The time limit is for the answer; missed signals judge the open connection.
      req.setTimeout(0);
      // A node that answers but sends no signals (another protocol, an older devsite) does not count as gone; a program that is no node does.
      if (res.headers[PROTOCOL_HEADER] !== String(PROTOCOL) || res.statusCode !== 200) {
        if (res.headers[PROTOCOL_HEADER] !== undefined) f.lastSignal = Date.now();
        res.resume();
        return;
      }
      f.conn = res;
      res.setEncoding("utf8");
      let buf = "";
      res.on("data", (chunk: string) => {
        buf += chunk;
        for (let i = buf.indexOf("\n"); i !== -1; i = buf.indexOf("\n")) {
          const line = `${buf.slice(0, i)}\n`;
          buf = buf.slice(i + 1);
          if (line === BEAT) f.lastSignal = Date.now();
          if (line === GOING) return takeOver("is going");
        }
      });
      const lost = () => {
        if (f.conn === res) f.conn = null;
      };
      res.on("close", lost);
      res.on("error", lost);
    });
    // No answer: the next signal interval tries again, and missed signals start the takeover.
    req.on("timeout", () => req.destroy());
    req.on("error", () => {
      f.connecting = false;
    });
    req.end();
  };

  const sendGoing = async () => {
    await Promise.all(
      [...signals].map(
        (res) =>
          new Promise<void>((resolve) => {
            const done = setTimeout(resolve, 500);
            res.end(GOING, () => {
              clearTimeout(done);
              resolve();
            });
          }),
      ),
    );
  };

  let lastTimer = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    // A gap of 2 intervals is shorter than the 3 missed signals after which another Mac takes over, so this node reads the route before it could act on a stale one.
    const asleep = now - lastTimer > 2 * signalMs;
    lastTimer = now;
    // This Mac slept, or its process was stopped: what it knew of the route may be stale, so it reads the route first.
    if (asleep && state.role !== "no-secret") {
      stopFollowing();
      set({ role: "unknown", why: "this Mac woke" });
      nextSettle = 0;
      sleepingUntil = 0;
      return;
    }
    for (const res of signals) res.write(BEAT);
    if (follow === null) return;
    if (now - follow.lastSignal > MISSED * signalMs) return takeOver(`missed ${MISSED} signals`);
    connect();
  }, signalMs);
  timer.unref();

  return {
    tick: () => {
      if (busy !== null || Date.now() < sleepingUntil) return;
      if (state.role === "main") {
        if (Date.now() >= nextRecheck) void exclusive(recheck);
        return;
      }
      if (state.role === "follower") return;
      if (Date.now() < nextSettle) return;
      void exclusive(settle);
    },
    settleNow: async () => {
      await busy;
      nextSettle = 0;
      await exclusive(settle);
      return state;
    },
    state: () => state,
    canWrite: async () => {
      const t = tailnet();
      const ip = t === null ? undefined : selfIp(t);
      if (ip === undefined || (api ?? (await loadApi())) === null) return false;
      return apiAnswered && (await servesNames(ip, env));
    },
    serveSignals: (req, res) => {
      res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" });
      res.write(BEAT);
      signals.add(res);
      req.socket.setNoDelay(true);
      // A node that stops following may have taken the route over while this Mac's network was gone, so the main Mac reads the route again.
      res.on("close", () => {
        signals.delete(res);
        if (state.role !== "main") return;
        nextRecheck = 0;
        void exclusive(recheck);
      });
    },
    sleep: async () => {
      sleepingUntil = Date.now() + SLEEP_MS;
      stopFollowing();
      set({ role: "unknown", why: "this Mac goes to sleep" });
      await sendGoing();
    },
    wake: () => {
      sleepingUntil = 0;
      nextSettle = 0;
      // A read that is still running may have started before the sleep.
      void Promise.resolve(busy).then(() => exclusive(settle));
    },
    close: async () => {
      clearInterval(timer);
      stopFollowing();
      await sendGoing();
    },
  };
}
