#!/usr/bin/env bun
// Entry owns nothing — logic in an entry file executes on import and can only
// be tested by spawning a process. Everything lives in run().
import { run } from "./run";

process.exit(await run(process.argv.slice(2)));
