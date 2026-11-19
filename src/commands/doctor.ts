/**
 * devsite doctor — prints how this Mac is set up, then checks the outcomes devsite needs, whoever set them up. It writes nothing and runs no sudo, so it is safe to run any time; it exits 1 on any red check, so a script can use it as a gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { caddyChecks, INIT, printSection, type Result, storageOf } from "../checks";
import { type CliContext, processContext } from "../context";
import { BOLD, GREEN, painter, RED } from "../io";
import { caddyfileOf, discoverRoutes, type Route, refuseRoot, renderHostFile } from "./init";

function projectChecks(routes: Route[], devsiteDir: string): Result[] {
  const results: Result[] = [];
  for (const r of routes) {
    const path = join(devsiteDir, `${r.host}.caddy`);
    const label = `${r.host}'s host file matches what init writes`;
    if (!existsSync(path)) {
      results.push({ state: "red", label, detail: `no ${path}`, fix: INIT });
      continue;
    }
    const current = readFileSync(path, "utf8");
    const owner = current
      .split("\n", 1)[0]
      ?.match(/^# (.+)$/)?.[1]
      ?.trim();
    const ownerLabel = `${r.host} is used by ${r.project} only`;
    if (owner !== undefined && owner !== r.project) {
      results.push({
        state: "red",
        label: ownerLabel,
        detail: `project ${owner} in another repo uses it too`,
        fix: `pick another devSite.name for ${r.project}`,
      });
      continue;
    }
    results.push({ state: "green", label: ownerLabel });
    results.push(
      current === renderHostFile(r)
        ? { state: "green", label }
        : { state: "red", label, detail: "it differs", fix: INIT },
    );
  }
  return results;
}

export async function doctor(ctx: CliContext = processContext()): Promise<number> {
  if (refuseRoot("doctor", ctx)) return 1;
  const caddyfile = caddyfileOf(ctx);
  const devsiteDir = join(dirname(caddyfile), "devsite.d");
  const storage = storageOf(caddyfile);
  const paint = painter(ctx.stdout, ctx);

  ctx.stdout.write(`${paint(BOLD, "devsite doctor")}\n`);
  ctx.stdout.write(`\n${paint(BOLD, "Setup")}\n`);
  ctx.stdout.write(`  Caddy: config ${caddyfile}\n`);
  ctx.stdout.write(
    `  Caddy storage: ${storage.root ?? "not read by devsite yet"} (${storage.source})\n`,
  );

  const caddyResults = await caddyChecks(caddyfile, storage, ctx);
  printSection("Caddy", caddyResults, paint, ctx);

  const results = [...caddyResults];
  let routes: Route[] = [];
  let invalid: string | null = null;
  try {
    routes = discoverRoutes(ctx.cwd);
  } catch (err) {
    invalid = err instanceof Error ? err.message : String(err);
  }
  const namesLabel = "every devSite name of this repo is valid and used by one project only";
  if (invalid !== null) {
    const bad: Result = {
      state: "red",
      label: namesLabel,
      detail: invalid,
      fix: "edit that devSite.name",
    };
    results.push(bad);
    printSection(`This repo (${ctx.cwd})`, [bad], paint, ctx);
  } else if (routes.length === 0) {
    ctx.stdout.write(`\nSkipped the checks of this repo: no package.json#devSite in ${ctx.cwd}.\n`);
  } else {
    const repoResults: Result[] = [
      { state: "green", label: namesLabel },
      ...projectChecks(routes, devsiteDir),
    ];
    results.push(...repoResults);
    printSection(`This repo (${ctx.cwd})`, repoResults, paint, ctx);
  }

  const red = results.filter((r) => r.state === "red").length;
  ctx.stdout.write(
    red === 0
      ? `\n${paint(GREEN, "Every check is green.")}\n`
      : `\n${paint(RED, `${red} check(s) red.`)}\n`,
  );
  return red === 0 ? 0 : 1;
}
