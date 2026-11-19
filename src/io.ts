// The output and command helpers that init, doctor, and their shared checks all use.
import type { CliContext } from "./context";

export function exec(cmd: string, args: string[], ctx: CliContext, capture = false) {
  const r = ctx.runCommand(cmd, args, { capture });
  // outRaw exists for diff output, where trimming could eat a meaningful trailing context line (a lone space) and corrupt the patch.
  return { status: r.status, out: r.stdout.trim(), outRaw: r.stdout, error: r.error };
}

// NO_COLOR: https://no-color.org. The basic 8 colours take the terminal theme's palette.
export type Paint = (code: number, text: string) => string;
export function painter(stream: CliContext["stdout"], ctx: CliContext): Paint {
  const on = (stream as { isTTY?: boolean }).isTTY === true && !ctx.env.NO_COLOR;
  return (code, text) => (on ? `\x1b[${code}m${text}\x1b[0m` : text);
}
export const BOLD = 1;
export const DIM = 2;
export const RED = 31;
export const GREEN = 32;
export const YELLOW = 33;
export const CYAN = 36;
