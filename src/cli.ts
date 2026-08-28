// Entry owns nothing — logic in an entry file executes on import and can only
// be tested by spawning a process. Everything lives in run().
// No shebang here: `bin` points at the built dist/cli.js, whose node shebang
// the build step injects (--banner) — one here would end up duplicated there.
import { run } from "./run";

process.exit(await run(process.argv.slice(2)));
