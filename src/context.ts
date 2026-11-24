// The CLI's contact surface with the process (io, and every external command it runs), as one injectable value. run() and the command handlers read and write only through this — tests pass buffers and plain objects instead of spying on console or mutating process state. Production uses processContext(), the real thing.
import { spawnSync } from "node:child_process";
import { openSync } from "node:fs";
import { ReadStream } from "node:tty";
import { latinLettersOfThisMac } from "./keyboard-layout";

export type Writer = { write(chunk: string): unknown };

// capture: the child's stdout comes back in `stdout` and its stderr is dropped; otherwise the child shares the terminal (a sudo password prompt needs it) and `stdout` is "".
// timeoutMs: the child is stopped after it, and the run reads as failed.
export type CommandOptions = { capture: boolean; timeoutMs?: number };
// error is set when the command could not start at all (not on PATH); status is then 1.
export type CommandResult = { status: number; stdout: string; error?: Error };
export type CommandRunner = (cmd: string, args: string[], opts: CommandOptions) => CommandResult;

export type CliContext = {
  stdout: Writer;
  stderr: Writer;
  // confirm() reads the answer here; isTTY decides whether asking is possible.
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  // The terminal, opened apart from stdin: `init --ca -` reads the CA root from stdin and asks its questions here. null with no terminal (a CI run, a launchd job).
  terminal: () => (NodeJS.ReadableStream & { isTTY?: boolean }) | null;
  cwd: string;
  // The named keys are the full set of env vars the CLI reads; the index signature is what lets process.env (and test env objects) assign.
  env: {
    DEVSITE_UID?: string;
    DEVSITE_BREW_PREFIX?: string;
    DEVSITE_USER_HOME?: string;
    DEVSITE_SYSTEM_ROOT?: string;
    DEVSITE_SPLIT_DNS_WAIT_MS?: string;
    DEVSITE_NODE_WAIT_MS?: string;
    DEVSITE_PEER_PORT?: string;
    DEVSITE_TAILNET_REFRESH_MS?: string;
    DEVSITE_TAILSCALE?: string;
    [key: string]: string | undefined;
  };
  // Every external command the CLI runs goes through here, so a test scripts each answer and reads which commands ran.
  runCommand: CommandRunner;
  // Each letter the current keyboard layout types, to the Latin letter of the same key (`н` → `y` on Russian); a one-key prompt reads it.
  latinLetters: () => Promise<Map<string, string>>;
};

export const processRunner: CommandRunner = (cmd, args, { capture, timeoutMs }) => {
  const r = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    timeout: timeoutMs,
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", error: r.error };
};

export function processContext(): CliContext {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    terminal: openTerminal,
    cwd: process.cwd(),
    env: process.env,
    runCommand: processRunner,
    latinLetters: latinLettersOfThisMac,
  };
}

function openTerminal(): ReadStream | null {
  try {
    return new ReadStream(openSync("/dev/tty", "r"));
  } catch {
    return null;
  }
}
