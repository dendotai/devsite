// The CLI's io contact surface with the process, as one injectable value.
// run() and the command handlers read and write only through this — tests pass
// buffers and plain objects instead of spying on console or mutating process
// state. Production uses processContext(), the real thing.

export type Writer = { write(chunk: string): unknown };

export type CliContext = {
  stdout: Writer;
  stderr: Writer;
  // confirm() reads the answer here; isTTY decides whether asking is possible.
  stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  cwd: string;
  env: Record<string, string | undefined>;
};

export function processContext(): CliContext {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    cwd: process.cwd(),
    env: process.env,
  };
}
