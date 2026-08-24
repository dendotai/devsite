// The whole CLI surface as a plain function: argv in, exit code out — so it is
// testable in-process (run(["--help"]) === 0) without spawning anything.
// parseArgs is strict: an unknown flag (--dyr-run) fails here instead of
// silently reaching the privileged bootstrap.
import { parseArgs } from "node:util";
import { init } from "./commands/init";

const USAGE = `Usage: devsite <command> [flags]

Commands:
  init          One-time machine bootstrap for *.internal dev URLs over
                Tailscale. Run from the repo root; sudo is called only for
                the privileged steps.
    --dry-run   Print the diff init would apply; touch nothing.

Flags:
  --help        Print this help.
  --version     Print the devsite version.`;

async function version(): Promise<string> {
  const pkg = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
    version?: string;
  };
  return pkg.version ?? "unknown";
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
}

export async function run(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCliArgs>;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;

  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (values.version) {
    console.log(await version());
    return 0;
  }

  const [command, ...extra] = positionals;
  switch (command) {
    case "init": {
      if (extra.length > 0) {
        console.error(`Unexpected argument: ${extra.join(" ")}\n\n${USAGE}`);
        return 1;
      }
      try {
        return await init({ dryRun: values["dry-run"] === true });
      } catch (err) {
        console.error(`\ndevsite init failed: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
    }
    case undefined:
      console.error(USAGE);
      return 1;
    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}
