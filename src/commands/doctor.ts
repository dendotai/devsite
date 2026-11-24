/**
 * devsite doctor — checks the node first, prints how this Mac is set up, then checks the outcomes devsite needs, whoever set them up. It writes nothing and runs no sudo, so it is safe to run any time; it exits 1 on any red check, so a script can use it as a gate.
 */
import { sep } from "node:path";
import {
  caddyChecks,
  certTarget,
  nodeChecks,
  peerChecks,
  portOf,
  printSection,
  type Result,
  tailnetListenerChecks,
} from "../checks";
import { NODE_PORT } from "../client.mjs";
import { type CliContext, processContext } from "../context";
import { type DnsmasqProbe, describeDnsmasq, probeDnsmasq } from "../dnsmasq";
import { type CaddyInstall, describeKind, findCaddy, unknownFix } from "../install";
import { BOLD, GREEN, type Paint, painter, plural, RED } from "../io";
import { type NodeAnswer, nodeAddress, readNode, readPeers } from "../node/install";
import { nodeLog, settingsFile, supportDir } from "../paths";
import { discoverProjects, type RepoProject } from "../repo";
import { readSettings } from "../settings";
import { findStorage, type Storage } from "../storage";
import { tailscaleChecks } from "../tailscale";
import { refuseRoot } from "./init";

const UNUSED_DAYS = 30;

// The node keeps each project's last-used date; a name unseen for 30+ days may be one to clean up.
function unusedNames(node: NodeAnswer): string[] {
  if (!node.ok) return [];
  const cutoff = new Date(Date.now() - UNUSED_DAYS * 86_400_000).toISOString().slice(0, 10);
  return Object.entries(node.status.projects)
    .filter(([, p]) => p.lastUsed <= cutoff)
    .map(([name, p]) => `${name} (last used ${p.lastUsed})`)
    .sort();
}

function printSetup(
  install: CaddyInstall,
  storage: Storage | null,
  dns: DnsmasqProbe,
  node: NodeAnswer,
  ctx: CliContext,
  paint: Paint,
) {
  const line = (s: string) => ctx.stdout.write(`  ${s}\n`);
  ctx.stdout.write(`\n${paint(BOLD, "Setup")}\n`);
  line(`devsite's files: ${supportDir(ctx.env)}`);
  line(`devsite's settings: ${settingsFile(ctx.env)}`);
  line(`Node log: ${nodeLog(ctx.env)}`);
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
  const unused = unusedNames(node);
  line(
    `Projects unused for ${UNUSED_DAYS}+ days: ${unused.length === 0 ? "none" : unused.join(", ")}`,
  );
}

// A name the node holds for a folder outside this repo belongs to another project: the two would take turns at one URL.
function repoChecks(projects: RepoProject[], node: NodeAnswer, repoRoot: string): Result[] {
  if (!node.ok) {
    return [
      {
        state: "skipped",
        label: "this repo's names on the node",
        detail: "the node does not answer",
      },
    ];
  }
  return projects.map((r): Result => {
    const label = `${r.name} is used by this repo only`;
    const held = node.status.projects[r.name];
    const inRepo =
      held === undefined || held.folder === repoRoot || held.folder.startsWith(repoRoot + sep);
    return inRepo
      ? { state: "green", label }
      : {
          state: "red",
          label,
          detail: `the project in ${held.folder} uses it too`,
          fix: `pick another devSite.name for ${r.project}`,
        };
  });
}

export async function doctor(ctx: CliContext = processContext()): Promise<number> {
  if (refuseRoot("doctor", ctx)) return 1;
  const read = readSettings(ctx);
  if (!read.ok) {
    ctx.stderr.write(`${read.error}\n`);
    return 1;
  }
  const paint = painter(ctx.stdout, ctx);
  ctx.stdout.write(`${paint(BOLD, "devsite doctor")}\n`);

  const node = await readNode();
  const results = nodeChecks(node, ctx);
  if (node.ok) results.push(...tailnetListenerChecks(node.status.tailnetListeners ?? [], ctx));
  printSection(`Node (${nodeAddress()})`, results, paint, ctx);

  const install = findCaddy(read.settings, ctx);
  const storage = install.kind === "unknown" ? null : await findStorage(install, ctx);
  const dns = probeDnsmasq(read.settings, ctx);
  printSetup(install, storage, dns, node, ctx, paint);

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
      : await caddyChecks(install, storage ?? (await findStorage(install, ctx)), ctx, {
          cert: certTarget(node),
        });
  printSection("Caddy", caddyResults, paint, ctx);
  results.push(...caddyResults);

  const peerStates = node.ok ? await readPeers() : [];
  const tailscale = tailscaleChecks(dns.tailscale, peerStates, ctx);
  if (tailscale.length > 0) {
    printSection("Tailscale", tailscale, paint, ctx);
    results.push(...tailscale);
  }
  if (dns.checks.length > 0) {
    printSection("dnsmasq", dns.checks, paint, ctx);
    results.push(...dns.checks);
  }
  const listener = node.ok ? node.status.tailnetListeners?.[0]?.address : undefined;
  const peerPort = listener === undefined ? NODE_PORT : portOf(listener);
  const peers = node.ok ? peerChecks(peerStates, peerPort) : [];
  if (peers.length > 0) {
    printSection("Other Macs", peers, paint, ctx);
    results.push(...peers);
  }
  let projects: RepoProject[] = [];
  let invalid: string | null = null;
  try {
    projects = discoverProjects(ctx.cwd);
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
  } else if (projects.length === 0) {
    ctx.stdout.write(`\nSkipped the checks of this repo: no package.json#devSite in ${ctx.cwd}.\n`);
  } else {
    const repoResults: Result[] = [
      { state: "green", label: namesLabel },
      ...repoChecks(projects, node, ctx.cwd),
    ];
    results.push(...repoResults);
    printSection(`This repo (${ctx.cwd})`, repoResults, paint, ctx);
  }

  const red = results.filter((r) => r.state === "red").length;
  ctx.stdout.write(
    red === 0
      ? `\n${paint(GREEN, "Every check is green.")}\n`
      : `\n${paint(RED, `${plural(red, "check", "checks")} red.`)}\n`,
  );
  return red === 0 ? 0 : 1;
}
