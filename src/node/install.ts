// How init installs the node (ADR 0005): the devsite program it runs from goes into Application Support, and a per-user LaunchAgent starts it at login and again after a crash.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callNode, NODE_PORT } from "../client.mjs";
import type { CliContext } from "../context";
import { exec, xml } from "../io";
import { launchAgentsDir, nodeLog, nodeProgramDir } from "../paths";
import type { PeerState, Status } from "./server";

export const NODE_LABEL = "ai.den.devsite.node";

export const plistPath = (ctx: CliContext) => join(launchAgentsDir(ctx.env), `${NODE_LABEL}.plist`);
export const installedProgram = (ctx: CliContext) => join(nodeProgramDir(ctx.env), "cli.js");

// The file this code runs from: `bun build` makes the whole CLI one file, dist/cli.js, which runs the node too. Run from source, it is this .ts file, which cannot run alone. DEVSITE_NODE_PROGRAM names the file to copy in tests, which run from source.
const programSource = (ctx: CliContext) =>
  ctx.env.DEVSITE_NODE_PROGRAM || fileURLToPath(import.meta.url);

// A Homebrew runtime runs from its versioned Cellar dir, which `brew upgrade` deletes; its opt link follows the upgrade.
export function stableRuntime(execPath: string): string {
  return execPath.replace(/^(.*)\/Cellar\/([^/]+)\/[^/]+\/(.*)$/, "$1/opt/$2/$3");
}

// KeepAlive with SuccessfulExit false starts the node again only after a crash: the SIGTERM of a bootout exits 0, so a stopped node stays stopped. launchd waits at least 10 s between starts.
export function renderNodePlist(runtime: string, program: string, log: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "\t<key>Label</key>",
    `\t<string>${NODE_LABEL}</string>`,
    "\t<key>ProgramArguments</key>",
    "\t<array>",
    `\t\t<string>${xml(runtime)}</string>`,
    `\t\t<string>${xml(program)}</string>`,
    "\t\t<string>node</string>",
    "\t</array>",
    "\t<key>RunAtLoad</key>",
    "\t<true/>",
    "\t<key>KeepAlive</key>",
    "\t<dict>",
    "\t\t<key>SuccessfulExit</key>",
    "\t\t<false/>",
    "\t</dict>",
    "\t<key>StandardOutPath</key>",
    `\t<string>${xml(log)}</string>`,
    "\t<key>StandardErrorPath</key>",
    `\t<string>${xml(log)}</string>`,
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export type NodeAnswer = { ok: true; status: Status } | { ok: false; why: string };

export async function readNode(): Promise<NodeAnswer> {
  try {
    const res = await callNode("/status", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    return { ok: true, status: (await res.json()) as Status };
  } catch {
    return { ok: false, why: "no answer" };
  }
}

// The node's answer can take 3 s for `tailscale status` plus 1.5 s for a Mac that does not reply, so the wait is longer than both.
export async function readPeers(): Promise<PeerState[]> {
  try {
    const res = await callNode("/peers", { signal: AbortSignal.timeout(6000) });
    return res.ok ? ((await res.json()) as PeerState[]) : [];
  } catch {
    return [];
  }
}

const NODE_WAIT_MS = 5000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// DEVSITE_NODE_WAIT_MS shortens the wait in tests.
function nodeWaitMs(ctx: CliContext): number {
  const set = Number(ctx.env.DEVSITE_NODE_WAIT_MS);
  return ctx.env.DEVSITE_NODE_WAIT_MS && Number.isFinite(set) ? set : NODE_WAIT_MS;
}

// Polls the node until its answer is `wanted` or the wait ends; returns the last answer.
async function waitForAnswer(wanted: boolean, waitMs: number): Promise<NodeAnswer> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const answer = await readNode();
    if (answer.ok === wanted || Date.now() >= deadline) return answer;
    await sleep(100);
  }
}

export const nodeAddress = () => `127.0.0.1:${NODE_PORT}`;

// launchd can refuse a bootstrap while the job of the bootout before it still exits ("Bootstrap failed: 5").
const BOOTSTRAP_TRIES = 5;
const BOOTSTRAP_GAP_MS = 500;

// A bootout of a node that is not loaded fails, and the install goes on: only the bootstrap must work.
export async function installNode(ctx: CliContext) {
  const source = programSource(ctx);
  if (!source.endsWith(".js")) {
    throw new Error(
      "init installs the node from the built devsite: run `bun run build`, then `node dist/cli.js init`",
    );
  }
  const uid = ctx.env.DEVSITE_UID ? Number(ctx.env.DEVSITE_UID) : (process.getuid?.() ?? -1);
  const program = installedProgram(ctx);
  const log = nodeLog(ctx.env);
  mkdirSync(dirname(program), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  mkdirSync(launchAgentsDir(ctx.env), { recursive: true });
  copyFileSync(source, program);
  writeFileSync(plistPath(ctx), renderNodePlist(stableRuntime(process.execPath), program, log));
  const waitMs = nodeWaitMs(ctx);
  exec("launchctl", ["bootout", `gui/${uid}/${NODE_LABEL}`], ctx, true);
  // A node that still answers after the bootout is not the LaunchAgent's: the new node could not bind its port, and init would read the old one as installed.
  const old = await waitForAnswer(false, waitMs);
  if (old.ok) {
    throw new Error(
      `process ${old.status.pid} (devsite ${old.status.version}) holds ${nodeAddress()}, and it is not the node's LaunchAgent. Stop it, then run init again.`,
    );
  }
  for (let tries = 1; ; tries++) {
    const boot = exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath(ctx)], ctx, true);
    if (boot.status === 0) break;
    if (tries === BOOTSTRAP_TRIES) {
      throw new Error(`\`launchctl bootstrap gui/${uid} ${plistPath(ctx)}\` failed`);
    }
    await sleep(BOOTSTRAP_GAP_MS);
  }
  if (!(await waitForAnswer(true, waitMs)).ok) {
    throw new Error(`the node did not answer within ${waitMs / 1000} s. See its log: ${log}`);
  }
}
