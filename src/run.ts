// The whole CLI surface as a plain function: argv in, exit code out — so it is testable in-process (run(["--help"]) === 0) without spawning anything. All io goes through an injectable CliContext.
//
// run() is three named steps: parse (argv → values/positionals, strict per command), resolve (a COMMANDS table lookup and nothing else), then the command's handler. Commands are data: one COMMANDS row per command carries its help lines, its flags, and its handler, and USAGE is generated from the table — help text and the parser cannot drift apart. Command-like global flags (--help, --version) map to their command through GLOBAL_FLAGS' `command` field — adding one adds a table entry, never a branch. parseArgs is strict, scoped per command: an unknown flag (--dyr-run), or a command flag outside its command (--dry-run with no init), fails with usage instead of silently reaching the privileged bootstrap.
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { caExport } from "./commands/ca";
import { doctor } from "./commands/doctor";
import { init } from "./commands/init";
import { runNode } from "./commands/node";
import { type CliContext, processContext } from "./context";

type FlagDef = {
  type: "boolean" | "string";
  short?: string;
  default?: boolean | string;
  help: string;
  // A flag that IS a command: resolve dispatches to this COMMANDS row when the flag is set. Only meaningful on GLOBAL_FLAGS entries.
  command?: string;
};

type CliValues = { [flag: string]: string | boolean | (string | boolean)[] | undefined };

type Command = {
  summary: string[];
  flags: Record<string, FlagDef>;
  run: (values: CliValues, ctx: CliContext) => Promise<number>;
};

const GLOBAL_FLAGS: Record<string, FlagDef> = {
  help: {
    type: "boolean",
    short: "h",
    default: false,
    help: "Print this help.",
    command: "help",
  },
  version: {
    type: "boolean",
    short: "v",
    default: false,
    help: "Print the devsite version.",
    command: "version",
  },
};

const COMMANDS: Record<string, Command> = {
  init: {
    summary: [
      "Set up *.internal dev URLs over Tailscale; fixes only what doctor finds red.",
      "Run from the repo root, as yourself; every root step runs in one sudo call.",
    ],
    flags: {
      "dry-run": {
        type: "boolean",
        default: false,
        help: "Print the plan and the diff init would apply; touch nothing.",
      },
      ca: {
        type: "string",
        help: "- reads a CA root from stdin (`devsite ca export` on another Mac) into Caddy.",
      },
    },
    run: (values, ctx) =>
      init(
        {
          dryRun: values["dry-run"] === true,
          ca: typeof values.ca === "string" ? values.ca : undefined,
        },
        ctx,
      ),
  },
  doctor: {
    summary: [
      "Print how this Mac is set up, then check what devsite needs.",
      "Writes nothing and runs no sudo; exits 1 on any red check.",
    ],
    flags: {},
    run: (_values, ctx) => doctor(ctx),
  },
  "ca export": {
    summary: [
      "Print this Mac's CA root certificate and key, to pipe into your secret store.",
      "Writes no file; `devsite init --ca -` on another Mac reads the output.",
    ],
    flags: {},
    run: (_values, ctx) => caExport(ctx),
  },
  node: {
    summary: [
      "Run the node, the devsite server Caddy sends each request to.",
      "launchd starts it at login; init installs it.",
    ],
    flags: {
      port: { type: "string", help: "The loopback port to listen on; 0 takes a free one." },
    },
    run: (values, ctx) =>
      runNode({ port: typeof values.port === "string" ? values.port : undefined }, ctx),
  },
  help: {
    summary: ["Print this help."],
    flags: {},
    run: async (_values, ctx) => {
      ctx.stdout.write(`${usage()}\n`);
      return 0;
    },
  },
  version: {
    summary: ["Print the devsite version."],
    flags: {},
    run: async (_values, ctx) => {
      ctx.stdout.write(`${pkg.version}\n`);
      return 0;
    },
  },
};

// FlagDef minus the metadata parseArgs doesn't know = exactly what it accepts.
function toParseArgsOptions(flags: Record<string, FlagDef>) {
  return Object.fromEntries(
    Object.entries(flags).map(([name, { help: _help, command: _command, ...def }]) => [name, def]),
  );
}

function flagLine(name: string, f: FlagDef): string {
  const invocation = `${f.short ? `-${f.short}, ` : ""}--${name}`;
  return `  ${invocation.padEnd(14)}${f.help}`;
}

function usage(): string {
  const lines = ["Usage: devsite <command> [flags]", "", "Commands:"];
  for (const [name, cmd] of Object.entries(COMMANDS)) {
    lines.push(`  ${name.padEnd(14)}${cmd.summary[0] ?? ""}`);
    for (const s of cmd.summary.slice(1)) lines.push(`  ${" ".repeat(14)}${s}`);
    for (const [flagName, f] of Object.entries(cmd.flags)) {
      lines.push(`  ${flagLine(flagName, f)}`);
    }
  }
  lines.push("", "Flags:");
  for (const [flagName, f] of Object.entries(GLOBAL_FLAGS)) lines.push(flagLine(flagName, f));
  return lines.join("\n");
}

type Parsed =
  | { ok: true; commandName: string | undefined; values: CliValues; positionals: string[] }
  | { ok: false; message: string };

function parse(argv: string[]): Parsed {
  // First pass only learns which command's flags are in scope; strict: false tolerates the flags the second, strict pass will judge.
  const loose = parseArgs({
    args: argv,
    options: toParseArgsOptions(GLOBAL_FLAGS),
    strict: false,
    allowPositionals: true,
  });
  const [first, second] = loose.positionals;
  const commandName =
    first !== undefined && second !== undefined && COMMANDS[`${first} ${second}`] !== undefined
      ? `${first} ${second}`
      : first;
  const command = commandName !== undefined ? COMMANDS[commandName] : undefined;
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      options: {
        ...toParseArgsOptions(GLOBAL_FLAGS),
        ...(command ? toParseArgsOptions(command.flags) : {}),
      },
      allowPositionals: true,
    });
    return { ok: true, commandName, values, positionals };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

type Resolution = { ok: true; name: string; command: Command } | { ok: false; message?: string };

function resolve({ commandName, values, positionals }: Parsed & { ok: true }): Resolution {
  // The flag form of a command wins over a positional (`devsite init --help` is a help run) — matching git's behavior.
  for (const [flag, def] of Object.entries(GLOBAL_FLAGS)) {
    if (def.command === undefined || values[flag] !== true) continue;
    const command = COMMANDS[def.command];
    if (command) return { ok: true, name: def.command, command };
  }
  if (commandName === undefined) return { ok: false };
  const command = COMMANDS[commandName];
  if (command === undefined) return { ok: false, message: `Unknown command: ${commandName}` };
  const extra = positionals.slice(commandName.split(" ").length);
  if (extra.length > 0) return { ok: false, message: `Unexpected argument: ${extra.join(" ")}` };
  return { ok: true, name: commandName, command };
}

export async function run(argv: string[], ctx: CliContext = processContext()): Promise<number> {
  const parsed = parse(argv);
  if (!parsed.ok) {
    ctx.stderr.write(`${parsed.message}\n\n${usage()}\n`);
    return 1;
  }
  const resolved = resolve(parsed);
  if (!resolved.ok) {
    ctx.stderr.write(`${resolved.message ? `${resolved.message}\n\n` : ""}${usage()}\n`);
    return 1;
  }
  try {
    return await resolved.command.run(parsed.values, ctx);
  } catch (err) {
    ctx.stderr.write(
      `\ndevsite ${resolved.name} failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return 1;
  }
}
