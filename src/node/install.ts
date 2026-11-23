// How init installs the node (ADR 0005): the devsite program it runs from goes into Application Support, and a per-user LaunchAgent starts it at login and again after a crash.
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { callNode, NODE_PORT } from "../client.mjs";
import type { CliContext } from "../context";
import { exec, xml } from "../io";
import { launchAgentsDir, nodeLog, nodeProgramDir } from "../paths";
import type { Status } from "./server";

export const NODE_LABEL = "ai.den.devsite.node";

export const plistPath = (ctx: CliContext) => join(launchAgentsDir(ctx.env), `${NODE_LABEL}.plist`);
export const installedProgram = (ctx: CliContext) => join(nodeProgramDir(ctx.env), "cli.js");

// The file this code runs from: `bun build` makes the whole CLI one file, dist/cli.js, which runs the node too.
const programSource = () => fileURLToPath(import.meta.url);

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

const NODE_WAIT_MS = 5000;

// DEVSITE_NODE_WAIT_MS shortens the wait in tests.
async function waitForNode(ctx: CliContext): Promise<number | null> {
  const set = Number(ctx.env.DEVSITE_NODE_WAIT_MS);
  const waitMs = ctx.env.DEVSITE_NODE_WAIT_MS && Number.isFinite(set) ? set : NODE_WAIT_MS;
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await readNode()).ok) return null;
    if (Date.now() >= deadline) return waitMs;
    await new Promise((r) => setTimeout(r, 100));
  }
}

export const nodeAddress = () => `127.0.0.1:${NODE_PORT}`;

// A bootout of a node that is not loaded fails, and the install goes on: only the bootstrap must work.
export async function installNode(ctx: CliContext) {
  const uid = ctx.env.DEVSITE_UID ? Number(ctx.env.DEVSITE_UID) : (process.getuid?.() ?? -1);
  const program = installedProgram(ctx);
  const log = nodeLog(ctx.env);
  mkdirSync(dirname(program), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  mkdirSync(launchAgentsDir(ctx.env), { recursive: true });
  copyFileSync(programSource(), program);
  writeFileSync(plistPath(ctx), renderNodePlist(stableRuntime(process.execPath), program, log));
  exec("launchctl", ["bootout", `gui/${uid}/${NODE_LABEL}`], ctx, true);
  const boot = exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath(ctx)], ctx, true);
  if (boot.status !== 0)
    throw new Error(`\`launchctl bootstrap gui/${uid} ${plistPath(ctx)}\` failed`);
  const waited = await waitForNode(ctx);
  if (waited !== null) {
    throw new Error(`the node did not answer within ${waited / 1000} s. See its log: ${log}`);
  }
}
