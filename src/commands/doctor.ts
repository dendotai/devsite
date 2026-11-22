/**
 * devsite doctor — prints how this Mac is set up, then checks the outcomes devsite needs, whoever set them up. It writes nothing and runs no sudo, so it is safe to run any time; it exits 1 on any red check, so a script can use it as a gate.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { caddyChecks, INIT, machineHosts, printSection, type Result } from "../checks";
import { type CliContext, processContext } from "../context";
import { type DnsmasqProbe, describeDnsmasq, probeDnsmasq } from "../dnsmasq";
import { type CaddyInstall, describeKind, findCaddy, unknownFix } from "../install";
import { BOLD, GREEN, type Paint, painter, RED } from "../io";
import { readSettings } from "../settings";
import { portFilePath, resolveStateDir } from "../state.mjs";
import { findStorage, type Storage } from "../storage";
import { probeTailscale } from "../tailscale";
import {
  discoverRoutes,
  OFFLINE_FRAGMENT,
  type Route,
  refuseRoot,
  renderHostFile,
  renderOfflineFragment,
} from "./init";

const UNUSED_DAYS = 30;

// A host file's first line, `# <project>`, names the project that owns it.
function hostFileOwner(text: string): string | undefined {
  return text
    .split("\n", 1)[0]
    ?.match(/^# (.+)$/)?.[1]
    ?.trim();
}

function projectChecks(routes: Route[], devsiteDir: string, stateDir: string): Result[] {
  const results: Result[] = [];
  for (const r of routes) {
    const path = join(devsiteDir, `${r.host}.caddy`);
    const label = `${r.host}'s host file matches what init writes`;
    if (!existsSync(path)) {
      results.push({ state: "red", label, detail: `no ${path}`, fix: INIT });
      continue;
    }
    const current = readFileSync(path, "utf8");
    const owner = hostFileOwner(current);
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
      current === renderHostFile(r, portFilePath(r.host, stateDir))
        ? { state: "green", label }
        : { state: "red", label, detail: "it differs", fix: INIT },
    );
  }
  return results;
}

// Every host file in devsite.d imports its host's port file, so one missing port file makes every `caddy reload` fail, for each repo's hosts.
function portFileChecks(devsiteDir: string, stateDir: string): Result[] {
  return machineHosts(devsiteDir).map((host) => {
    const label = `${host}'s port file exists`;
    const path = portFilePath(host, stateDir);
    if (existsSync(path)) return { state: "green", label };
    const project = hostFileOwner(readFileSync(join(devsiteDir, `${host}.caddy`), "utf8"));
    return {
      state: "red",
      label,
      detail: `no ${path}, so \`caddy reload\` fails`,
      fix: project === undefined ? INIT : `${INIT}, in the repo of ${project}`,
    };
  });
}

// Every host file imports the offline page file, so a missing one makes every `caddy reload` fail. With no host file, nothing imports it.
function offlinePageChecks(devsiteDir: string): Result[] {
  if (machineHosts(devsiteDir).length === 0) return [];
  const label = "the offline page file matches what init writes";
  const path = join(devsiteDir, OFFLINE_FRAGMENT);
  if (!existsSync(path)) {
    return [{ state: "red", label, detail: `no ${path}, so \`caddy reload\` fails`, fix: INIT }];
  }
  return [
    readFileSync(path, "utf8") === renderOfflineFragment()
      ? { state: "green", label }
      : { state: "red", label, detail: "it differs", fix: INIT },
  ];
}

// The Vite plugin stamps each host's last-used date on every dev-server start (#48). A host with no stamp is left out: its file may predate the stamps.
function unusedHosts(hosts: string[], ctx: CliContext): string[] {
  let stamps: Record<string, unknown> = {};
  try {
    stamps = JSON.parse(readFileSync(join(resolveStateDir(ctx.env), "last-used.json"), "utf8"));
  } catch {
    return [];
  }
  const cutoff = new Date(Date.now() - UNUSED_DAYS * 86_400_000).toISOString().slice(0, 10);
  return hosts.flatMap((h) => {
    const day = stamps[h];
    return typeof day === "string" && day <= cutoff ? [`${h} (last used ${day})`] : [];
  });
}

function printSetup(
  install: CaddyInstall,
  storage: Storage | null,
  dns: DnsmasqProbe,
  ctx: CliContext,
  paint: Paint,
) {
  const line = (s: string) => ctx.stdout.write(`  ${s}\n`);
  ctx.stdout.write(`\n${paint(BOLD, "Setup")}\n`);
  if (install.kind === "unknown") {
    line(`Caddy: an install devsite does not know (${install.why})`);
    line(`dnsmasq: ${describeDnsmasq(dns)}`);
    return;
  }
  line(`Caddy: ${describeKind(install)}`);
  line(
    install.config === null
      ? `Caddy config: none (${install.configSource})`
      : `Caddy config: ${install.config} (${install.configSource})`,
  );
  line(`devsite's Caddy config: ${install.devsiteDir}`);
  line(`Caddy log: ${install.log ?? "unknown"}`);
  line(
    `Service manager: ${install.manager ?? (install.installed ? "none, Caddy does not run" : "none, Caddy is not installed")}`,
  );
  line(`Runs as: ${install.user === "root" ? "root" : "you"} (${install.userSource})`);
  if (storage !== null)
    line(`Caddy storage: ${storage.root ?? "not read by devsite"} (${storage.source})`);
  line(`dnsmasq: ${describeDnsmasq(dns)}`);
  const unused = unusedHosts(machineHosts(install.devsiteDir), ctx);
  line(
    `Hosts unused for ${UNUSED_DAYS}+ days: ${unused.length === 0 ? "none" : unused.join(", ")}`,
  );
}

export async function doctor(ctx: CliContext = processContext()): Promise<number> {
  if (refuseRoot("doctor", ctx)) return 1;
  const read = readSettings(ctx);
  if (!read.ok) {
    ctx.stderr.write(`${read.error}\n`);
    return 1;
  }
  const install = findCaddy(read.settings, ctx);
  const paint = painter(ctx.stdout, ctx);
  const stateDir = resolveStateDir(ctx.env);

  ctx.stdout.write(`${paint(BOLD, "devsite doctor")}\n`);
  const storage = install.kind === "unknown" ? null : await findStorage(install, ctx);
  const dns = probeDnsmasq(read.settings, ctx);
  printSetup(install, storage, dns, ctx, paint);

  const caddyResults: Result[] =
    install.kind === "unknown"
      ? [
          {
            state: "red",
            label: "devsite knows this Mac's Caddy install",
            detail: install.why,
            fix: unknownFix(ctx),
          },
        ]
      : [
          ...(await caddyChecks(install, storage ?? (await findStorage(install, ctx)), ctx)),
          ...portFileChecks(install.devsiteDir, stateDir),
          ...offlinePageChecks(install.devsiteDir),
        ];
  printSection("Caddy", caddyResults, paint, ctx);

  const results = [...caddyResults];
  const tailscale = probeTailscale(dns.tailscale, ctx);
  if (tailscale.checks.length > 0) {
    printSection("Tailscale", tailscale.checks, paint, ctx);
    results.push(...tailscale.checks);
  }
  if (dns.checks.length > 0) {
    printSection("dnsmasq", dns.checks, paint, ctx);
    results.push(...dns.checks);
  }
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
      ...(install.kind === "unknown"
        ? [
            {
              state: "skipped",
              label: "the host files of this repo",
              detail: "they need Caddy's paths",
            } as const,
          ]
        : projectChecks(routes, install.devsiteDir, stateDir)),
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
