/**
 * devsite doctor — prints how this Mac is set up, then checks the outcomes devsite needs, whoever set them up. It writes nothing and runs no sudo, so it is safe to run any time; it exits 1 on any red check, so a script can use it as a gate.
 */
import { X509Certificate } from "node:crypto";
import { existsSync, globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type CliContext, processContext } from "../context";
import { startsWithGuard } from "../guard.mjs";
import { HOSTNAME_RE } from "../names.mjs";
import { caddy, findHostRoute } from "../vite.mjs";
import {
  BOLD,
  caddyfileOf,
  DIM,
  discoverRoutes,
  exec,
  GREEN,
  type Paint,
  painter,
  RED,
  type Route,
  refuseRoot,
  renderHostFile,
} from "./init";

const INIT = "bunx devsite init";

type Result =
  | { state: "green"; label: string; detail?: string }
  | { state: "red"; label: string; detail?: string; fix: string }
  | { state: "skipped"; label: string; detail: string };

type CaddyRoute = { match?: { host?: string[] }[]; handle?: unknown[] };
type Servers = Record<string, { routes?: CaddyRoute[] }>;

// root is null for a storage kind other than file_system, whose CA devsite cannot read yet (#72).
type Storage = { root: string | null; source: string };

// The storage Caddy uses: the Caddyfile's `storage` line, else Caddy's default data dir on macOS.
function storageOf(caddyfile: string): Storage {
  const text = existsSync(caddyfile) ? readFileSync(caddyfile, "utf8") : "";
  const source = "the Caddyfile's storage line";
  const block = text.match(/^\s*storage\s+file_system\s*\{[^}]*?^\s*root\s+"?([^"\n]+?)"?\s*$/m);
  const line = text.match(/^\s*storage\s+file_system\s+"?([^"{\s][^"\n]*?)"?\s*$/m);
  const root = block?.[1] ?? line?.[1];
  if (root !== undefined) return { root, source };
  const kind = text.match(/^\s*storage\s+(\S+)/m)?.[1];
  if (kind !== undefined) return { root: null, source: `${source}, storage ${kind}` };
  return {
    root: join(homedir(), "Library", "Application Support", "Caddy"),
    source: "Caddy's default",
  };
}

// devsite's hosts on this Mac: one `<host>.caddy` file each in devsite.d. A file whose name is not a `.internal` hostname is a snippet, not a host.
function machineHosts(devsiteDir: string): string[] {
  if (!existsSync(devsiteDir)) return [];
  return globSync("*.caddy", { cwd: devsiteDir })
    .map((f) => f.replace(/\.caddy$/, ""))
    .filter((h) => HOSTNAME_RE.test(h) && h.endsWith(".internal"))
    .sort();
}

async function readServers(): Promise<{ ok: true; servers: Servers } | { ok: false; why: string }> {
  try {
    const res = await caddy("/config/apps/http/servers", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status} for its HTTP servers` };
    return { ok: true, servers: ((await res.json()) ?? {}) as Servers };
  } catch {
    return { ok: false, why: "no answer" };
  }
}

// Caddy's host matcher (modules/caddyhttp/matchers.go): each `*` stands for one label in any position, and the label counts must be equal. A match set with no host matcher matches every host.
function matchesHost(route: CaddyRoute, host: string): boolean {
  if (route.match === undefined || route.match.length === 0) return true;
  const labels = host.split(".");
  return route.match.some((m) => {
    if (m.host === undefined) return true;
    return m.host.some((p) => {
      const pattern = p.toLowerCase().split(".");
      return (
        pattern.length === labels.length && pattern.every((l, i) => l === "*" || l === labels[i])
      );
    });
  });
}

function describeRoute(route: CaddyRoute): string {
  const hosts = (route.match ?? []).flatMap((m) => m.host ?? []);
  return hosts.length > 0 ? hosts.join(", ") : "every host";
}

function routeChecks(hosts: string[], servers: Servers): Result[] {
  const results: Result[] = [];
  for (const host of hosts) {
    const found = findHostRoute(servers, host);
    if (found === null) {
      results.push({
        state: "red",
        label: `${host} has a route in Caddy`,
        detail: "no route names it",
        fix: INIT,
      });
      continue;
    }
    const routes = servers[found.server]?.routes ?? [];
    const route = routes[found.index] as CaddyRoute;
    results.push(
      startsWithGuard(route)
        ? { state: "green", label: `${host}'s route starts with the LAN guard` }
        : {
            state: "red",
            label: `${host}'s route starts with the LAN guard`,
            detail: "the guard is missing, so the LAN reaches this host",
            fix: INIT,
          },
    );
    const before = routes.slice(0, found.index).findIndex((r) => matchesHost(r, host));
    const shadow = routes[before];
    results.push(
      shadow === undefined
        ? { state: "green", label: `no route before ${host}'s also matches it` }
        : {
            state: "red",
            label: `no route before ${host}'s also matches it`,
            detail: `route ${before} of server ${found.server} (${describeRoute(shadow)}) comes first`,
            fix: "delete that route from Caddy's config: a site block in your Caddyfile, or a route another tool added at runtime",
          },
    );
  }
  return results;
}

function pemCerts(text: string): X509Certificate[] {
  const pems = text.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return pems.map((p) => new X509Certificate(p));
}

// Each served certificate is signed by the next one, and the last by the root in Caddy's storage.
function chainsTo(served: X509Certificate[], root: X509Certificate): boolean {
  if (served.length === 0) return false;
  for (let i = 0; i < served.length - 1; i++) {
    const next = served[i + 1] as X509Certificate;
    if (!(served[i] as X509Certificate).verify(next.publicKey)) return false;
  }
  const last = served[served.length - 1] as X509Certificate;
  return last.fingerprint256 === root.fingerprint256 || last.verify(root.publicKey);
}

function certChecks(host: string | undefined, storage: Storage, ctx: CliContext): Result[] {
  const chainLabel = "the served certificate chains to the CA in Caddy's storage";
  const trustLabel = "that CA is trusted in the keychain";
  const skipBoth = (detail: string): Result[] => [
    { state: "skipped", label: chainLabel, detail },
    { state: "skipped", label: trustLabel, detail },
  ];
  if (host === undefined) return skipBoth("no devsite host on this Mac yet");
  if (storage.root === null) return skipBoth("devsite reads only file_system storage yet");
  const rootCrt = join(storage.root, "pki", "authorities", "local", "root.crt");
  if (!existsSync(rootCrt)) {
    return [
      { state: "red", label: chainLabel, detail: `no CA at ${rootCrt}`, fix: INIT },
      { state: "skipped", label: trustLabel, detail: "no CA to check" },
    ];
  }
  const root = new X509Certificate(readFileSync(rootCrt));
  // To 127.0.0.1 with the host as SNI, so the check needs no DNS. stdin is closed, so s_client ends after the handshake.
  const r = exec(
    "openssl",
    ["s_client", "-connect", "127.0.0.1:443", "-servername", host, "-showcerts"],
    ctx,
    true,
  );
  let served: X509Certificate[] = [];
  try {
    served = pemCerts(r.outRaw);
  } catch {}
  const results: Result[] = [];
  if (served.length === 0) {
    results.push({
      state: "red",
      label: chainLabel,
      detail: `no certificate served for ${host} on 127.0.0.1:443`,
      fix: INIT,
    });
  } else if (chainsTo(served, root)) {
    results.push({ state: "green", label: chainLabel, detail: host });
  } else {
    results.push({
      state: "red",
      label: chainLabel,
      detail: `${host} is served a certificate from another CA`,
      fix: INIT,
    });
  }
  // verify-cert reads the keychain's trust settings and needs no sudo: exit 0 means trusted.
  const trusted = exec("security", ["verify-cert", "-c", rootCrt, "-p", "ssl"], ctx, true);
  results.push(
    trusted.status === 0
      ? { state: "green", label: trustLabel, detail: rootCrt }
      : { state: "red", label: trustLabel, detail: rootCrt, fix: INIT },
  );
  return results;
}

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

function printSection(heading: string, results: Result[], paint: Paint, ctx: CliContext) {
  ctx.stdout.write(`\n${paint(BOLD, heading)}\n`);
  for (const r of results) {
    const mark =
      r.state === "green" ? paint(GREEN, "✓") : r.state === "red" ? paint(RED, "✗") : "–";
    const detail = r.detail === undefined ? "" : paint(DIM, ` — ${r.detail}`);
    ctx.stdout.write(`  ${mark} ${r.label}${detail}\n`);
    if (r.state === "red") ctx.stdout.write(`      fix: ${r.fix}\n`);
  }
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

  const hosts = machineHosts(devsiteDir);
  const caddyResults: Result[] = [];
  const admin = await readServers();
  if (admin.ok) {
    caddyResults.push({ state: "green", label: "Caddy's admin API answers" });
    caddyResults.push(...routeChecks(hosts, admin.servers));
  } else {
    caddyResults.push({
      state: "red",
      label: "Caddy's admin API answers",
      detail: admin.why,
      fix: INIT,
    });
    if (hosts.length > 0) {
      caddyResults.push({
        state: "skipped",
        label: "the routes of devsite's hosts",
        detail: "they need the admin API",
      });
    }
  }
  caddyResults.push(...certChecks(hosts[0], storage, ctx));
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
