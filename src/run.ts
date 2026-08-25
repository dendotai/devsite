// The whole CLI surface as a plain function: argv in, exit code out — so it is
// testable in-process (run(["--help"]) === 0) without spawning anything.
//
// Commands are data: one COMMANDS row per command carries its help lines, its
// flags, and its handler, and USAGE is generated from the table — help text
// and the parser cannot drift apart. parseArgs is strict, scoped per command:
// an unknown flag (--dyr-run), or a command flag outside its command
// (--dry-run with no init), fails with usage instead of silently reaching the
// privileged bootstrap.
import { parseArgs } from "node:util";
import pkg from "../package.json";
import { init } from "./commands/init";

type FlagDef = {
  type: "boolean";
  short?: string;
  default?: boolean;
  help: string;
};

type CliValues = { [flag: string]: string | boolean | (string | boolean)[] | undefined };

type Command = {
  summary: string[];
  flags: Record<string, FlagDef>;
  run: (values: CliValues) => Promise<number>;
};

const GLOBAL_FLAGS: Record<string, FlagDef> = {
  help: { type: "boolean", short: "h", default: false, help: "Print this help." },
  version: { type: "boolean", short: "v", default: false, help: "Print the devsite version." },
};

const COMMANDS: Record<string, Command> = {
  init: {
    summary: [
      "One-time machine bootstrap for *.internal dev URLs over Tailscale.",
      "Run from the repo root; sudo is called only for the privileged steps.",
    ],
    flags: {
      "dry-run": {
        type: "boolean",
        default: false,
        help: "Print the diff init would apply; touch nothing.",
      },
    },
    run: (values) => init({ dryRun: values["dry-run"] === true }),
  },
};

// FlagDef minus the help text = exactly what parseArgs accepts.
function toParseArgsOptions(flags: Record<string, FlagDef>) {
  return Object.fromEntries(
    Object.entries(flags).map(([name, { help: _help, ...def }]) => [name, def]),
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

function parseStrict(argv: string[], command: Command | undefined) {
  return parseArgs({
    args: argv,
    options: {
      ...toParseArgsOptions(GLOBAL_FLAGS),
      ...(command ? toParseArgsOptions(command.flags) : {}),
    },
    allowPositionals: true,
  });
}

export async function run(argv: string[]): Promise<number> {
  // First pass only learns which command's flags are in scope; strict: false
  // tolerates the flags the second, strict pass will judge.
  const loose = parseArgs({
    args: argv,
    options: toParseArgsOptions(GLOBAL_FLAGS),
    strict: false,
    allowPositionals: true,
  });
  const commandName = loose.positionals[0];
  const command = commandName !== undefined ? COMMANDS[commandName] : undefined;

  let parsed: ReturnType<typeof parseStrict>;
  try {
    parsed = parseStrict(argv, command);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${usage()}`);
    return 1;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(usage());
    return 0;
  }
  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const [name, ...extra] = positionals;
  if (name === undefined) {
    console.error(usage());
    return 1;
  }
  if (command === undefined) {
    console.error(`Unknown command: ${name}\n\n${usage()}`);
    return 1;
  }
  if (extra.length > 0) {
    console.error(`Unexpected argument: ${extra.join(" ")}\n\n${usage()}`);
    return 1;
  }

  try {
    return await command.run(values);
  } catch (err) {
    console.error(`\ndevsite ${name} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
