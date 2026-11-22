// The checks of this Mac's Caddy that init and doctor share: doctor prints them, init plans a fix for each red one that carries a repair.
import { X509Certificate } from "node:crypto";
import { existsSync, globSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliContext } from "./context";
import { startsWithGuard } from "./guard.mjs";
import { describeKind, type KnownInstall } from "./install";
import { BOLD, DIM, exec, GREEN, type Paint, RED } from "./io";
import { HOSTNAME_RE } from "./names.mjs";
import { caRootFile, type Storage } from "./storage";
import { adminBase, caddy, findHostRoute } from "./vite.mjs";

export const INIT = "bunx devsite init";

// What init does about a check that is not green: install Caddy, start it, load its config through the admin API, trust its CA, or run devsite's dnsmasq. A check with no repair is one init only reports.
export type Repair = "install" | "start" | "load" | "trust" | "run-dnsmasq" | "split-dns";

export type Result =
  | { state: "green"; label: string; detail?: string }
  | { state: "red"; label: string; detail?: string; fix: string; repair?: Repair }
  | { state: "skipped"; label: string; detail: string; repair?: Repair };

export type CaddyRoute = { match?: { host?: string[] }[]; handle?: unknown[] };
export type Servers = Record<string, { routes?: CaddyRoute[] }>;

// devsite's hosts on this Mac: one `<host>.caddy` file each in devsite.d. A file whose name is not a `.internal` hostname is a snippet, not a host.
export function machineHosts(devsiteDir: string): string[] {
  if (!existsSync(devsiteDir)) return [];
  return globSync("*.caddy", { cwd: devsiteDir })
    .map((f) => f.replace(/\.caddy$/, ""))
    .filter((h) => HOSTNAME_RE.test(h) && h.endsWith(".internal"))
    .sort();
}

export async function readServers(): Promise<
  { ok: true; servers: Servers } | { ok: false; why: string }
> {
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
        repair: "load",
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
            repair: "load",
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

const chainLabel = "the served certificate chains to the CA in Caddy's storage";
const trustLabel = "that CA is trusted in the keychain";

async function certChecks(
  host: string | undefined,
  storage: Storage,
  ctx: CliContext,
): Promise<Result[]> {
  // Caddy makes its CA when it first serves a devsite host, so a Mac with no host or no CA yet still needs the trust step.
  if (host === undefined) {
    const detail = "no devsite host on this Mac yet";
    return [
      { state: "skipped", label: chainLabel, detail },
      { state: "skipped", label: trustLabel, detail, repair: "trust" },
    ];
  }
  // doctor writes nothing that outlives the run, so the admin API's root goes to a temp file the check deletes.
  const temp = join(tmpdir(), `devsite-caddy-root-${process.pid}.crt`);
  try {
    return await certChecksOf(host, await caRootFile(storage, temp), storage, ctx);
  } finally {
    rmSync(temp, { force: true });
  }
}

async function certChecksOf(
  host: string,
  rootCrt: string | null,
  storage: Storage,
  ctx: CliContext,
): Promise<Result[]> {
  if (rootCrt === null) {
    const detail = `devsite cannot read ${storage.source}, and Caddy's admin API gives no CA`;
    return [
      { state: "skipped", label: chainLabel, detail },
      { state: "skipped", label: trustLabel, detail },
    ];
  }
  if (!existsSync(rootCrt)) {
    return [
      { state: "red", label: chainLabel, detail: `no CA at ${rootCrt}`, fix: INIT, repair: "load" },
      { state: "skipped", label: trustLabel, detail: "no CA to check", repair: "trust" },
    ];
  }
  // The three red chain results below mean the running Caddy does not use this storage; a load of the Caddyfile switches it there.
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
      repair: "load",
    });
  } else if (chainsTo(served, root)) {
    results.push({ state: "green", label: chainLabel, detail: host });
  } else {
    results.push({
      state: "red",
      label: chainLabel,
      detail: `${host} is served a certificate from another CA`,
      fix: INIT,
      repair: "load",
    });
  }
  // verify-cert reads the keychain's trust settings and needs no sudo: exit 0 means trusted.
  const trusted = exec("security", ["verify-cert", "-c", rootCrt, "-p", "ssl"], ctx, true);
  const where = storage.root === null ? "the CA Caddy's admin API gives" : rootCrt;
  results.push(
    trusted.status === 0
      ? { state: "green", label: trustLabel, detail: where }
      : { state: "red", label: trustLabel, detail: where, fix: INIT, repair: "trust" },
  );
  return results;
}

// Who starts a Caddy whose admin API is down: init, for a Homebrew Caddy that does not run; the user, for a Caddy that runs (its admin API sits elsewhere or is off) or one of a kind devsite does not know.
function adminDown(install: KnownInstall, why: string): Result {
  const label = "Caddy's admin API answers";
  if (install.running !== null) {
    return {
      state: "red",
      label,
      detail: `${why} at ${adminBase()}, but Caddy runs (pid ${install.running.pid})`,
      fix: `make Caddy's admin API listen on ${adminBase()}: the admin option in ${install.config ?? "Caddy's config"}`,
    };
  }
  if (install.kind !== "homebrew") {
    return { state: "red", label, detail: why, fix: "start Caddy the way you run it" };
  }
  return { state: "red", label, detail: why, fix: INIT, repair: "start" };
}

function installCheck(install: KnownInstall): Result {
  const label = "Caddy is installed";
  if (install.installed) {
    const detail = describeKind(install);
    return { state: "green", label, detail };
  }
  return {
    state: "red",
    label,
    detail: `Homebrew has no caddy formula at ${install.prefix}`,
    fix: INIT,
    repair: "install",
  };
}

export async function caddyChecks(
  install: KnownInstall,
  storage: Storage,
  ctx: CliContext,
): Promise<Result[]> {
  const hosts = machineHosts(install.devsiteDir);
  const results: Result[] = [installCheck(install)];
  const admin = await readServers();
  if (admin.ok) {
    results.push({ state: "green", label: "Caddy's admin API answers" });
    results.push(...routeChecks(hosts, admin.servers));
  } else {
    results.push(adminDown(install, admin.why));
    if (hosts.length > 0) {
      results.push({
        state: "skipped",
        label: "the routes of devsite's hosts",
        detail: "they need the admin API",
      });
    }
  }
  results.push(...(await certChecks(hosts[0], storage, ctx)));
  return results;
}

export function printSection(heading: string, results: Result[], paint: Paint, ctx: CliContext) {
  ctx.stdout.write(`\n${paint(BOLD, heading)}\n`);
  for (const r of results) {
    const mark =
      r.state === "green" ? paint(GREEN, "✓") : r.state === "red" ? paint(RED, "✗") : "–";
    const detail = r.detail === undefined ? "" : paint(DIM, ` — ${r.detail}`);
    ctx.stdout.write(`  ${mark} ${r.label}${detail}\n`);
    if (r.state === "red") ctx.stdout.write(`      fix: ${r.fix}\n`);
  }
}
