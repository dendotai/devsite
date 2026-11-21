// `devsite doctor` scenarios, one per check, green and red: run(["doctor"]) over a scratch Caddy dir, a scripted runner (openssl s_client, security), and a local mock of Caddy's admin API.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/run";
import { portFilePath } from "../src/state.mjs";
import {
  type CommandCall,
  cli,
  MISSING,
  makeEmptyRepo,
  makeIo,
  makeRepo,
  scriptedRunner,
} from "./helpers";
import {
  HOST,
  hostFileOf,
  type Machine,
  mockAdmin,
  pki,
  placeholder,
  setUpMachine,
  snapshot,
  useMachine,
} from "./machine";

useMachine();

const TAILSCALE_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

type Answers = { served?: string; trusted?: boolean };

function runner(a: Answers = {}) {
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "openssl" && c.args[0] === "s_client") return { stdout: a.served ?? pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    if (/(?:^|\/)tailscale$/i.test(c.cmd)) return MISSING;
    return { status: 1 };
  });
}

async function doctor(
  m: Machine,
  opts: { cwd?: string; answers?: Answers } = {},
): Promise<{ status: number; stdout: string; stderr: string; calls: CommandCall[] }> {
  const { runCommand, calls } = runner(opts.answers);
  const r = await cli(["doctor"], {
    cwd: opts.cwd ?? makeRepo(),
    caddyfile: m.caddyfile,
    runCommand,
  });
  return { ...r, calls };
}

// --- every check green ---

test("a set-up Mac: every check is green, exit 0, nothing written, no sudo", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  const before = snapshot(m.dir);
  const r = await doctor(m);
  expect(r.stdout).toContain(`Caddy: Homebrew at ${m.prefix}`);
  expect(r.stdout).toContain(`Caddy config: ${m.caddyfile} (Homebrew's default)`);
  expect(r.stdout).toContain(`devsite's Caddy config: ${join(m.dir, "devsite.d")}`);
  expect(r.stdout).toContain(`Caddy log: ${join(m.prefix, "var", "log", "caddy.log")}`);
  expect(r.stdout).toContain("Service manager: none, Caddy does not run");
  expect(r.stdout).toContain("Runs as: you (devsite's default)");
  expect(r.stdout).toContain(
    `Caddy storage: ${join(m.dir, "storage")} (the Caddyfile's storage line)`,
  );
  expect(r.stdout).toContain("Hosts unused for 30+ days: none");
  expect(r.stdout).toContain(`✓ ${HOST}'s port file exists`);
  expect(r.stdout).toContain(`✓ Caddy is installed — Homebrew at ${m.prefix}`);
  expect(r.stdout).toContain("✓ Caddy's admin API answers");
  expect(r.stdout).toContain(`✓ ${HOST}'s route starts with the LAN guard`);
  expect(r.stdout).toContain(`✓ no route before ${HOST}'s also matches it`);
  expect(r.stdout).toContain("✓ the served certificate chains to the CA in Caddy's storage");
  expect(r.stdout).toContain("✓ that CA is trusted in the keychain");
  expect(r.stdout).toContain(
    "✓ every devSite name of this repo is valid and used by one project only",
  );
  expect(r.stdout).toContain(`✓ ${HOST} is used by web only`);
  expect(r.stdout).toContain(`✓ ${HOST}'s host file matches what init writes`);
  expect(r.stdout).toContain("Every check is green.");
  expect(r.stdout).not.toContain("✗");
  expect(r.status).toBe(0);
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.calls.map((c) => c.cmd)).toEqual([
    "ps",
    "tailscale",
    TAILSCALE_APP,
    "openssl",
    "security",
  ]);
  // The certificate check connects to this Mac with the host as SNI, so it needs no DNS.
  expect(r.calls[3]?.args).toEqual([
    "s_client",
    "-connect",
    "127.0.0.1:443",
    "-servername",
    HOST,
    "-showcerts",
  ]);
  expect(r.calls[4]?.args).toEqual([
    "verify-cert",
    "-c",
    join(m.dir, "storage", "pki", "authorities", "local", "root.crt"),
    "-p",
    "ssl",
  ]);
});

test("a Caddyfile with no storage line and Caddy stopped: the Setup section names the data dir brew services gives Caddy", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  writeFileSync(m.caddyfile, "import devsite.d/*.caddy # devsite\n");
  const r = await doctor(m);
  expect(r.stdout).toContain(
    `Caddy storage: ${join(m.prefix, "var", "lib", "caddy")} (the data dir \`brew services\` gives Caddy)`,
  );
});

// --- the Caddy checks, red ---

test("the admin API does not answer: red with its fix, and the route checks are skipped", async () => {
  // The suites' default admin address (tests/setup.ts) has no listener.
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("✗ Caddy's admin API answers — no answer");
  expect(r.stdout).toContain("fix: bunx devsite init");
  expect(r.stdout).toContain("– the routes of devsite's hosts — they need the admin API");
  expect(r.stdout).toContain("1 check(s) red.");
  expect(r.status).toBe(1);
});

test("no route names a devsite host: red", async () => {
  await mockAdmin([]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(`✗ ${HOST} has a route in Caddy — no route names it`);
  expect(r.status).toBe(1);
});

test("a route without the LAN guard: red", async () => {
  await mockAdmin([
    {
      match: [{ host: [HOST] }],
      handle: [{ handler: "reverse_proxy", upstreams: [{ dial: "127.0.0.1:5173" }] }],
      terminal: true,
    },
  ]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(
    `✗ ${HOST}'s route starts with the LAN guard — the guard is missing, so the LAN reaches this host`,
  );
  expect(r.status).toBe(1);
});

test("a route before the devsite host that also matches it: red, naming that route", async () => {
  await mockAdmin([
    { match: [{ host: ["*.test.internal"] }], handle: [], terminal: true },
    placeholder(),
  ]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(
    `✗ no route before ${HOST}'s also matches it — route 0 of server srv0 (*.test.internal) comes first`,
  );
  expect(r.stdout).toContain("fix: delete that route from Caddy's config");
  expect(r.status).toBe(1);
});

test("routes before the devsite host that match other hosts only: green", async () => {
  await mockAdmin([
    { match: [{ host: ["api.test.internal", "*.internal"] }], handle: [], terminal: true },
    placeholder(),
  ]);
  const r = await doctor(setUpMachine());
  // `*.internal` stands for one label, so it does not match web.test.internal.
  expect(r.stdout).toContain(`✓ no route before ${HOST}'s also matches it`);
  expect(r.status).toBe(0);
});

test("a route with no host matcher before the devsite host matches every host: red", async () => {
  await mockAdmin([{ handle: [], terminal: true }, placeholder()]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("route 0 of server srv0 (every host) comes first");
  expect(r.status).toBe(1);
});

test("the served certificate comes from another CA: red", async () => {
  await mockAdmin([placeholder()]);
  const r = await doctor(setUpMachine({ root: pki.otherRoot }));
  expect(r.stdout).toContain(
    `✗ the served certificate chains to the CA in Caddy's storage — ${HOST} is served a certificate from another CA`,
  );
  expect(r.status).toBe(1);
});

test("no certificate is served: red", async () => {
  await mockAdmin([placeholder()]);
  const r = await doctor(setUpMachine(), { answers: { served: "" } });
  expect(r.stdout).toContain(`no certificate served for ${HOST} on 127.0.0.1:443`);
  expect(r.status).toBe(1);
});

test("no CA in Caddy's storage: red, and the trust check is skipped", async () => {
  await mockAdmin([placeholder()]);
  const r = await doctor(setUpMachine({ root: null }));
  expect(r.stdout).toContain(
    "✗ the served certificate chains to the CA in Caddy's storage — no CA at",
  );
  expect(r.stdout).toContain("– that CA is trusted in the keychain — no CA to check");
  expect(r.calls.map((c) => c.cmd)).toEqual(["ps", "tailscale", TAILSCALE_APP]);
  expect(r.status).toBe(1);
});

test("the CA is not trusted in the keychain: red", async () => {
  await mockAdmin([placeholder()]);
  const r = await doctor(setUpMachine(), { answers: { trusted: false } });
  expect(r.stdout).toContain("✗ that CA is trusted in the keychain");
  expect(r.status).toBe(1);
});

// --- the checks of this repo ---

test("the repo's host file differs from what init writes: red", async () => {
  await mockAdmin([placeholder()]);
  const r = await doctor(setUpMachine({ hostFile: "# web\nweb.test.internal {\n}\n" }));
  expect(r.stdout).toContain(`✗ ${HOST}'s host file matches what init writes — it differs`);
  expect(r.status).toBe(1);
});

test("the repo's host has no host file: red", async () => {
  await mockAdmin([]);
  const r = await doctor(setUpMachine({ hostFile: null }));
  expect(r.stdout).toContain(`✗ ${HOST}'s host file matches what init writes — no `);
  expect(r.status).toBe(1);
});

test("a project in another repo uses the same name: red, naming it", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  writeFileSync(join(m.dir, "devsite.d", `${HOST}.caddy`), hostFileOf("shop"));
  const r = await doctor(m);
  expect(r.stdout).toContain(
    `✗ ${HOST} is used by web only — project shop in another repo uses it too`,
  );
  expect(r.stdout).toContain("fix: pick another devSite.name for web");
  expect(r.status).toBe(1);
});

test("a devSite name that is not a plain hostname: red", async () => {
  await mockAdmin([placeholder()]);
  const r = await doctor(setUpMachine(), { cwd: makeRepo("bad_name") });
  expect(r.stdout).toContain(
    "✗ every devSite name of this repo is valid and used by one project only",
  );
  expect(r.stdout).toContain("is not a plain hostname");
  expect(r.status).toBe(1);
});

test("two projects of this repo declare one name: red", async () => {
  await mockAdmin([placeholder()]);
  const repo = makeRepo();
  mkdirSync(join(repo, "apps", "api"), { recursive: true });
  writeFileSync(
    join(repo, "apps", "api", "package.json"),
    JSON.stringify({ name: "api", devSite: { name: "web.test" } }),
  );
  const r = await doctor(setUpMachine(), { cwd: repo });
  expect(r.stdout).toContain('devSite.name "web.test" is declared by both web and api');
  expect(r.status).toBe(1);
});

test("outside a repo: the machine checks run and the repo checks are skipped", async () => {
  await mockAdmin([placeholder()]);
  const cwd = makeEmptyRepo();
  const r = await doctor(setUpMachine(), { cwd });
  expect(r.stdout).toContain("✓ Caddy's admin API answers");
  expect(r.stdout).toContain(`Skipped the checks of this repo: no package.json#devSite in ${cwd}.`);
  expect(r.status).toBe(0);
});

test("doctor as root refuses, with init's reason", async () => {
  const { runCommand, calls } = runner();
  const io = makeIo({ runCommand });
  io.ctx.env.DEVSITE_UID = "0";
  expect(await run(["doctor"], io.ctx)).toBe(1);
  expect(io.stderr.text()).toContain("devsite doctor is running as root.");
  expect(io.stderr.text()).toContain("bunx devsite doctor");
  expect(calls).toEqual([]);
});

// --- review follow-ups: Caddy's own matching rules, guards built another way, storage forms ---

test("a wildcard in a middle label matches, as Caddy's host matcher does: red", async () => {
  await mockAdmin([
    { match: [{ host: ["web.*.internal"] }], handle: [], terminal: true },
    placeholder(),
  ]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain("route 0 of server srv0 (web.*.internal) comes first");
  expect(r.status).toBe(1);
});

// The placeholder route with its guard letting in only `ranges`.
function placeholderAllowing(ranges: string[]) {
  return {
    match: [{ host: [HOST] }],
    handle: [
      {
        handler: "subroute",
        routes: [
          {
            match: [{ not: [{ remote_ip: { ranges } }] }],
            handle: [{ handler: "static_response", abort: true }],
          },
          { handle: [{ handler: "static_response", status_code: 503 }] },
        ],
      },
    ],
    terminal: true,
  };
}

test("a guard that allows fewer sources still keeps the LAN out: green", async () => {
  await mockAdmin([placeholderAllowing(["127.0.0.1"])]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(`✓ ${HOST}'s route starts with the LAN guard`);
});

test("a guard that lets the LAN in: red", async () => {
  await mockAdmin([placeholderAllowing(["127.0.0.1", "192.168.0.0/16"])]);
  const r = await doctor(setUpMachine());
  expect(r.stdout).toContain(`✗ ${HOST}'s route starts with the LAN guard`);
  expect(r.status).toBe(1);
});

test("a snippet file in devsite.d is not read as a host", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  writeFileSync(join(m.dir, "devsite.d", "guard.caddy"), "(devsite-guard) {\n}\n");
  const r = await doctor(m);
  expect(r.stdout).not.toContain("guard has a route");
  expect(r.status).toBe(0);
});

test("a one-line `storage file_system <path>`: the CA checks read that storage", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  const storage = join(m.dir, "storage");
  writeFileSync(m.caddyfile, `{\n\tstorage file_system ${storage}\n}\n`);
  const r = await doctor(m);
  expect(r.stdout).toContain(`Caddy storage: ${storage} (the Caddyfile's storage line)`);
  expect(r.stdout).toContain("✓ the served certificate chains to the CA in Caddy's storage");
  expect(r.status).toBe(0);
});

test("a storage kind other than file_system: the CA checks read the CA from GET /pki/ca/local", async () => {
  await mockAdmin([placeholder()], { caRoot: pki.root });
  const m = setUpMachine();
  writeFileSync(m.caddyfile, "{\n\tstorage redis {\n\t\thost 127.0.0.1\n\t}\n}\n");
  const r = await doctor(m);
  expect(r.stdout).toContain(
    "Caddy storage: not read by devsite (the Caddyfile's storage line, storage redis)",
  );
  expect(r.stdout).toContain("✓ the served certificate chains to the CA in Caddy's storage");
  expect(r.stdout).toContain("✓ that CA is trusted in the keychain");
  expect(r.status).toBe(0);
});

test("a storage devsite cannot read and no CA from the admin API: the CA checks are skipped, not red", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  writeFileSync(m.caddyfile, "{\n\tstorage redis {\n\t\thost 127.0.0.1\n\t}\n}\n");
  const r = await doctor(m);
  expect(r.stdout).toContain(
    "– the served certificate chains to the CA in Caddy's storage — devsite cannot read the Caddyfile's storage line, storage redis, and Caddy's admin API gives no CA",
  );
  expect(r.calls.map((c) => c.cmd)).toEqual(["ps", "tailscale", TAILSCALE_APP]);
  expect(r.status).toBe(0);
});

test("a host with no port file: red, because every Caddy reload fails, with init in its repo as the fix", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ portFile: false });
  const r = await doctor(m);
  expect(r.stdout).toContain(
    `✗ ${HOST}'s port file exists — no ${portFilePath(HOST, m.stateDir)}, so \`caddy reload\` fails`,
  );
  expect(r.stdout).toContain("fix: bunx devsite init, in the repo of web");
  expect(r.status).toBe(1);
});
