// The CLI's contact surface with the process (io, and every external command it runs), as one injectable value. run() and the command handlers read and write only through this — tests pass buffers and plain objects instead of spying on console or mutating process state. Production uses processContext(), the real thing.
import { spawnSync } from "node:child_process";

export type Writer = { write(chunk: string): unknown };

// capture: the child's stdout comes back in `stdout` and its stderr is dropped; otherwise the child shares the terminal (a sudo password prompt needs it) and `stdout` is "".
export type CommandOptions = { capture: boolean };
// error is set when the command could not start at all (not on PATH); status is then 1.
export type CommandResult = { status: number; stdout: string; error?: Error };
export type CommandRunner = (cmd: string, args: string[], opts: CommandOptions) => CommandResult;

export type CliContext = {
  stdout: Writer;
  stderr: Writer;
  // confirm() reads the answer here; isTTY decides whether asking is possible.
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd: string;
  // The named keys are the full set of env vars the CLI reads; the index signature is what lets process.env (and test env objects) assign.
  env: {
    DEVSITE_UID?: string;
    DEVSITE_BREW_PREFIX?: string;
    DEVSITE_STATE_DIR?: string;
    DEVSITE_SYSTEM_ROOT?: string;
    DEVSITE_SPLIT_DNS_WAIT_MS?: string;
    XDG_CONFIG_HOME?: string;
    XDG_STATE_HOME?: string;
    [key: string]: string | undefined;
  };
  // Every external command the CLI runs goes through here, so a test scripts each answer and reads which commands ran.
  runCommand: CommandRunner;
};

export const processRunner: CommandRunner = (cmd, args, { capture }) => {
  const r = spawnSync(cmd, args, {
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
  });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", error: r.error };
};

export function processContext(): CliContext {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
    runCommand: processRunner,
  };
}
