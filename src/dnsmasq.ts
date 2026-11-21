// devsite's own dnsmasq (ADR 0003): one root dnsmasq under devsite's LaunchDaemon, listening on this Mac's Tailscale IP only and answering `.internal` with that IP, so the phone resolves dev URLs through Tailscale split DNS. A dnsmasq the user runs is never changed, and no /etc/resolver file is written.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Result } from "./checks";
import type { CliContext } from "./context";
import { brewPrefix } from "./install";
import { exec } from "./io";
import { type Settings, settingsPath } from "./settings";

const LABEL = "ai.den.devsite.dnsmasq";
const TAILSCALE_APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
// Any name answers: devsite's config answers every `.internal` name.
const PROBE_NAME = "devsite-check.internal";
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export type TailscaleIp = { state: "absent" } | { state: "no-ip" } | { state: "ip"; ip: string };

type DnsFile = { abs: string; current: string | null; next: string };

export type Dnsmasq = {
  ip: string;
  // Homebrew's dnsmasq; null with no Homebrew on this Mac.
  binary: string | null;
  installed: boolean;
  conf: DnsFile;
  plist: DnsFile;
  loaded: boolean;
  // The listen address of devsite's config on disk, when it names another IP.
  staleIp: string | null;
};

// The Mac App Store and standalone Tailscale apps put no `tailscale` on PATH; their CLI sits inside the app.
function tailscaleIp(ctx: CliContext): TailscaleIp {
  let r = exec("tailscale", ["ip", "-4"], ctx, true);
  if (r.error) r = exec(TAILSCALE_APP_CLI, ["ip", "-4"], ctx, true);
  if (r.error) return { state: "absent" };
  const ip =
    r.status === 0
      ? r.out
          .split("\n")
          .map((l) => l.trim())
          .find((l) => IPV4.test(l))
      : undefined;
  return ip === undefined ? { state: "no-ip" } : { state: "ip", ip };
}

// DEVSITE_SYSTEM_ROOT points the root-owned paths at a scratch dir in tests.
function systemPath(ctx: CliContext, ...parts: string[]): string {
  return join(ctx.env.DEVSITE_SYSTEM_ROOT || "/", ...parts);
}

export function renderConf(ip: string): string {
  return [
    "# devsite's dnsmasq (ADR 0003): answers .internal with this Mac's Tailscale IP, on that IP only.",
    "# `devsite init` rewrites this file when the Tailscale IP changes.",
    `listen-address=${ip}`,
    "bind-interfaces",
    "no-resolv",
    "no-hosts",
    "no-poll",
    // A Homebrew dnsmasq the user runs as root writes /var/run/dnsmasq.pid; an empty pid-file writes none.
    "pid-file=",
    `address=/internal/${ip}`,
    "",
  ].join("\n");
}

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// ADR 0003 rejects KeepAlive, which retries and logs every 10 s while Tailscale is off; the root watcher (#75) takes over starting and stopping dnsmasq.
export function renderPlist(binary: string, conf: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    `\t\t<string>${xml(binary)}</string>`,
    "\t\t<string>--keep-in-foreground</string>",
    `\t\t<string>--conf-file=${xml(conf)}</string>`,
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function readOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function findDnsmasq(ip: string, ctx: CliContext): Dnsmasq {
  const prefix = brewPrefix(ctx);
  const binary = prefix === null ? null : join(prefix, "opt", "dnsmasq", "sbin", "dnsmasq");
  const confPath = systemPath(ctx, "Library", "Application Support", "devsite", "dnsmasq.conf");
  const plistPath = systemPath(ctx, "Library", "LaunchDaemons", `${LABEL}.plist`);
  const confNow = readOrNull(confPath);
  const listen = confNow?.match(/^listen-address=(.+)$/m)?.[1]?.trim() ?? null;
  return {
    ip,
    binary,
    installed: binary !== null && existsSync(binary),
    conf: { abs: confPath, current: confNow, next: renderConf(ip) },
    plist: {
      abs: plistPath,
      current: readOrNull(plistPath),
      next: renderPlist(binary ?? "dnsmasq", confPath),
    },
    loaded: isLoaded(ctx),
    staleIp: listen !== null && listen !== ip ? listen : null,
  };
}

// `launchctl print` reads the system domain without root: exit 0 loaded, 113 not.
function isLoaded(ctx: CliContext): boolean {
  return exec("launchctl", ["print", `system/${LABEL}`], ctx, true).status === 0;
}

// What answers on the Tailscale IP: an A record, the status of a reply with none (NXDOMAIN, REFUSED), or null when no server replies.
export function digAnswer(ip: string, ctx: CliContext): string | null {
  const r = exec("dig", [`@${ip}`, "+time=1", "+tries=1", PROBE_NAME, "A"], ctx, true);
  const a = r.out.match(/^\S+\s+\d+\s+IN\s+A\s+(\S+)$/m)?.[1];
  if (a !== undefined) return a;
  const status = r.out.match(/status: (\w+)/)?.[1];
  if (status === undefined) return null;
  return status === "NOERROR" ? "no address" : status;
}

// dscacheutil asks macOS's resolver, the path every app on the Mac takes; dig would read only /etc/resolv.conf.
function macAnswer(ctx: CliContext): string | null {
  const r = exec("dscacheutil", ["-q", "host", "-a", "name", PROBE_NAME], ctx, true);
  return r.out.match(/^ip_address:\s*(\S+)$/m)?.[1] ?? null;
}

const changed = (f: DnsFile) => f.current !== f.next;

function answerCheck(d: Dnsmasq, answer: string | null, manual: string | null): Result {
  const label = `dnsmasq answers .internal with ${d.ip} on ${d.ip}`;
  if (answer === d.ip) return { state: "green", label };
  const heard = answer === null ? "no answer" : `answers ${answer}`;
  // No reply: devsite's dnsmasq is missing or stopped. An old IP in devsite's config: dnsmasq rereads its listen address only on a restart. Any other reply comes from a server that is not devsite's, which init leaves alone.
  if (answer !== null && d.staleIp === null) {
    return {
      state: "red",
      label,
      detail: `${heard}, from a DNS server that is not devsite's`,
      fix: `if it is your own dnsmasq, make it answer address=/internal/${d.ip}, or stop it listening on ${d.ip}`,
    };
  }
  if (manual !== null) {
    return {
      state: "red",
      label,
      detail: heard,
      fix: `dnsmasq.run is manual in ${manual}, so init runs no dnsmasq: make a DNS server on ${d.ip}:53 answer .internal with ${d.ip}`,
    };
  }
  if (d.binary === null) {
    return {
      state: "red",
      label,
      detail: `${heard}, and devsite finds dnsmasq through Homebrew, which is not on this Mac`,
      fix: "install Homebrew, then run bunx devsite init",
    };
  }
  const stale =
    d.staleIp === null
      ? ""
      : `: devsite's config names ${d.staleIp}, the Tailscale IP before it changed`;
  return {
    state: "red",
    label,
    detail: heard + stale,
    fix: "bunx devsite init",
    repair: "run-dnsmasq",
  };
}

function macCheck(d: Dnsmasq, answerGreen: boolean, ctx: CliContext): Result {
  const label = `this Mac resolves .internal to ${d.ip}`;
  const mac = macAnswer(ctx);
  if (mac === d.ip) return { state: "green", label };
  return {
    state: "red",
    label,
    detail: mac === null ? "no answer" : `resolves to ${mac}`,
    // With Tailscale on, the Mac asks through the split DNS route, which reaches the dnsmasq above.
    fix: answerGreen
      ? `in the Tailscale admin console (https://login.tailscale.com/admin/dns), add a split DNS nameserver: domain internal, nameserver ${d.ip}`
      : "fix the dnsmasq check above first",
  };
}

export type DnsmasqProbe = { tailscale: TailscaleIp; dnsmasq: Dnsmasq | null; checks: Result[] };

// With no Tailscale IP, devsite runs no dnsmasq: a Mac with no Tailscale gets no checks, a stopped Tailscale one skipped check.
export function probeDnsmasq(settings: Settings, ctx: CliContext): DnsmasqProbe {
  const tailscale = tailscaleIp(ctx);
  if (tailscale.state === "absent") return { tailscale, dnsmasq: null, checks: [] };
  if (tailscale.state === "no-ip") {
    const checks: Result[] = [
      {
        state: "skipped",
        label: "dnsmasq answers .internal on the Tailscale IP",
        detail: "Tailscale gives no IP: it is stopped or logged out",
      },
    ];
    return { tailscale, dnsmasq: null, checks };
  }
  const dnsmasq = findDnsmasq(tailscale.ip, ctx);
  const manual = settings.dnsmasq.run === "manual" ? settingsPath(ctx) : null;
  const answer = answerCheck(dnsmasq, digAnswer(dnsmasq.ip, ctx), manual);
  return {
    tailscale,
    dnsmasq,
    checks: [answer, macCheck(dnsmasq, answer.state === "green", ctx)],
  };
}

export function describeDnsmasq(p: DnsmasqProbe): string {
  if (p.tailscale.state === "absent") return "none, Tailscale is not on this Mac";
  const d = p.dnsmasq;
  if (d === null) return "none, Tailscale gives no IP";
  if (d.conf.current === null) {
    return `devsite's config ${d.conf.abs} is not written; the Tailscale IP is ${d.ip}`;
  }
  return `devsite's config ${d.conf.abs}, listens on ${d.staleIp ?? d.ip}`;
}

export type DnsmasqPlan = {
  install: boolean;
  text: string;
  details: string[];
  files: { abs: string; next: string }[];
  // The root commands that install the files root-owned, then load or restart dnsmasq; a staged file's path comes from the caller.
  rootCommands: (stage: (content: string) => string) => string[][];
};

// launchctl bootout returns before launchd has removed the job, and a bootstrap right after fails with "5: Input/output error", so the shell waits until the job is gone.
function waitUntilUnloaded(): string[] {
  return [
    "sh",
    "-c",
    `i=0; while launchctl print system/${LABEL} >/dev/null 2>&1; do i=$((i+1)); [ $i -ge 50 ] && exit 1; sleep 0.1; done`,
  ];
}

// One root step: write devsite's files when they differ, then load the LaunchDaemon, or restart dnsmasq so it rereads its config.
export function planDnsmasq(d: Dnsmasq): DnsmasqPlan {
  const files = [d.conf, d.plist].filter(changed).map((f) => ({ abs: f.abs, next: f.next }));
  const launchd: string[][] = [];
  if (d.loaded && changed(d.plist)) {
    launchd.push(["launchctl", "bootout", `system/${LABEL}`], waitUntilUnloaded());
  }
  if (!d.loaded || changed(d.plist)) {
    launchd.push(["launchctl", "bootstrap", "system", d.plist.abs]);
  } else {
    launchd.push(["launchctl", "kickstart", "-k", `system/${LABEL}`]);
  }
  // dnsmasq runs as root and reads its config as root, so both files are root-owned: a config the user could write would let any process of the user's run code as root.
  const rootCommands = (stage: (content: string) => string) => [
    ...(files.length > 0 ? [["install", "-d", "-m", "755", dirname(d.conf.abs)]] : []),
    ...files.map((f) => [
      "install",
      "-m",
      "644",
      "-o",
      "root",
      "-g",
      "wheel",
      stage(f.next),
      f.abs,
    ]),
    ...launchd,
  ];
  const details = [
    `devsite's LaunchDaemon ${d.plist.abs} runs dnsmasq as root with ${d.conf.abs}: it listens on ${d.ip} only and answers .internal with ${d.ip}`,
    ...(d.staleIp === null
      ? []
      : [
          `the Tailscale IP changed from ${d.staleIp}; dnsmasq rereads it only on a restart, so sudo runs again`,
        ]),
  ];
  return {
    install: !d.installed,
    text:
      files.length > 0
        ? `run devsite's dnsmasq on ${d.ip}`
        : `restart devsite's dnsmasq on ${d.ip}`,
    details,
    files,
    rootCommands,
  };
}
