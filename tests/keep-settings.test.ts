// init keeps the user's Caddy settings (#72): the storage Caddy already uses, a default_bind that guards the user's own sites, and a config that is not a Caddyfile. run(argv) over a scratch Homebrew prefix, a scripted runner, and a local mock of Caddy's admin API.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRunner } from "../src/context";
import { run } from "../src/run";
import {
  type CommandCall,
  fakeStdin,
  makeIo,
  makeRepo,
  makeStateDir,
  scriptedRunner,
} from "./helpers";
import { HOST, mockAdmin, pki, placeholder, setUpMachine, snapshot, useMachine } from "./machine";

useMachine();

// What `caddy adapt` makes of devsite's host files: one server, one TLS policy per host.
const ADAPTED = {
  apps: {
    http: { servers: { srv0: { listen: [":443"], routes: [{ match: [{ host: [HOST] }] }] } } },
    tls: { automation: { policies: [{ subjects: [HOST], issuers: [{ module: "internal" }] }] } },
  },
};

type Answers = {
  // The `caddy run` line ps prints.
  caddy?: { user: string; args: string; pid?: number };
  // The environment `ps -E` shows for the Caddy process; undefined shows none, as for another user's process.
  env?: string;
  trusted?: boolean;
};

function runner(a: Answers) {
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "ps" && c.args[0] === "-E") {
      return { stdout: `${a.caddy?.args ?? ""}${a.env === undefined ? "" : ` ${a.env}`}\n` };
    }
    if (c.cmd === "ps") {
      const p = a.caddy;
      return { stdout: p ? `  ${p.pid ?? 774}  1 ${p.user}  ${p.args}\n` : "" };
    }
    if (c.cmd === "brew" && c.args[1] === "info") {
      return { stdout: JSON.stringify([{ name: "caddy", pid: a.caddy?.pid ?? 774 }]) };
    }
    if (c.cmd === "caddy" && c.args[0] === "adapt") return { stdout: JSON.stringify(ADAPTED) };
    if (c.cmd === "openssl") return { stdout: pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    return {};
  });
}

async function devsite(
  argv: string[],
  caddyfile: string,
  answers: Answers = {},
  opts: { settings?: object; stateDir?: string; stdin?: ReturnType<typeof fakeStdin> } = {},
) {
  const { runCommand, calls } = runner(answers);
  const configHome = mkdtempSync(join(tmpdir(), "devsite-config-"));
  if (opts.settings !== undefined) {
    mkdirSync(join(configHome, "devsite"));
    writeFileSync(join(configHome, "devsite", "config.json"), JSON.stringify(opts.settings));
  }
  const io = makeIo({
    cwd: makeRepo(),
    caddyfile,
    configHome,
    runCommand,
    stdin: opts.stdin ?? fakeStdin("y", true),
  });
  io.ctx.env.DEVSITE_STATE_DIR = opts.stateDir ?? process.env.DEVSITE_STATE_DIR;
  const status = await run(argv, io.ctx);
  const ran = calls.filter((c) => c.cmd !== "diff").map((c) => [c.cmd, ...c.args].join(" "));
  return { status, stdout: io.stdout.text(), stderr: io.stderr.text(), ran };
}

const running = (m: { prefix: string; caddyfile: string }, user = "den") => ({
  user,
  args: `${m.prefix}/opt/caddy/bin/caddy run --config ${m.caddyfile}`,
});

// --- storage: the one Caddy already uses ---

test("a storage line of the user's own: init writes no pin and keeps it", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({
    caddyfile: '{\n\tstorage file_system {\n\t\troot "STORAGE"\n\t}\n\temail dev@example.com\n}\n',
  });
  const r = await devsite(["init"], m.caddyfile, { caddy: running(m) });
  const text = readFileSync(m.caddyfile, "utf8");
  expect(text.match(/storage file_system/g)).toHaveLength(1);
  expect(text).toContain(`root "${m.storage}"`);
  expect(text).toContain("import devsite.d/*.caddy # devsite");
  expect(r.ran.some((c) => c.startsWith("ps -E"))).toBe(false);
  expect(r.status).toBe(0);
});

test("no storage line and a running Caddy: init pins the running Caddy's data dir", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: "" });
  const r = await devsite(["init", "--dry-run"], m.caddyfile, {
    caddy: running(m),
    env: `HOME=${m.prefix}/var/lib XDG_DATA_HOME=${m.prefix}/var/lib`,
  });
  expect(r.ran).toContain("ps -E -ww -o command= -p 774");
  expect(r.stdout).toContain(`+\t\troot "${m.prefix}/var/lib/caddy"`);
  expect(r.status).toBe(0);
});

test("no storage line and a Caddy whose environment ps hides: no pin, and the phone's CA comes from GET /pki/ca/local", async () => {
  await mockAdmin([placeholder()], { caRoot: pki.root });
  const m = setUpMachine({ caddyfile: "", hostFile: "# web\nold {\n}\n" });
  const stateDir = makeStateDir();
  const r = await devsite(["init"], m.caddyfile, { caddy: running(m, "root") }, { stateDir });
  // A root Caddy's files are copied into place with sudo, so the plan's diff shows what lands.
  expect(r.stdout).toContain("+import devsite.d/*.caddy # devsite");
  expect(r.stdout).not.toContain("storage file_system");
  expect(r.stdout).toContain("✓ that CA is trusted in the keychain");
  expect(r.stdout).toContain(join(stateDir, "caddy-root.crt"));
  expect(readFileSync(join(stateDir, "caddy-root.crt"), "utf8")).toBe(pki.root);
  expect(r.status).toBe(0);
});

// --- default_bind: deleted only when no site of the user's own needs it ---

const BIND_WITH_SITE =
  '{\n\tdefault_bind 127.0.0.1 100.64.0.9\n}\n\nimport devsite.d/*.caddy # devsite\n\nnotes.localhost {\n\trespond "mine"\n}\n';

test("default_bind and a site block of the user's own: the plan guards the site, deletes default_bind, and names the root way", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: BIND_WITH_SITE });
  const r = await devsite(["init"], m.caddyfile);
  expect(r.stdout).toContain(
    'adds "import devsite-guard" to your site notes.localhost: the guard keeps the LAN out of it in place of default_bind',
  );
  expect(r.stdout).toContain('deletes "default_bind 127.0.0.1 100.64.0.9" from the Caddyfile');
  expect(r.stdout).toContain(
    'to keep default_bind instead, answer n and set caddy.user to "root" in',
  );
  const text = readFileSync(m.caddyfile, "utf8");
  expect(text).toContain('notes.localhost {\n\timport devsite-guard\n\trespond "mine"\n}');
  expect(text).not.toContain("default_bind");
  expect(r.status).toBe(0);
});

test("answering n to the guard plan: nothing changes", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: BIND_WITH_SITE });
  const before = snapshot(m.dir);
  const r = await devsite(["init"], m.caddyfile, {}, { stdin: fakeStdin("n", true) });
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(1);
});

test("a default_bind on a LAN address: the stop offers only caddy.user root, since the guard would cut that LAN off", async () => {
  const m = setUpMachine({ caddyfile: BIND_WITH_SITE.replace("100.64.0.9", "192.168.1.5") });
  const before = snapshot(m.dir);
  const r = await devsite(["init"], m.caddyfile);
  expect(r.stderr).toContain("Your Caddyfile has a default_bind line and site blocks of your own:");
  expect(r.stderr).toContain("  default_bind 127.0.0.1 192.168.1.5\n  notes.localhost\n");
  expect(r.stderr).not.toContain("import devsite-guard");
  expect(r.stderr).toContain('set caddy.user to "root" in');
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.ran.filter((c) => /^(caddy|sudo|brew services start)/.test(c))).toEqual([]);
  expect(r.status).toBe(1);
});

test("every site of the user's own imports devsite-guard: init deletes default_bind and names it in the plan", async () => {
  const guarded = BIND_WITH_SITE.replace(
    '\trespond "mine"',
    '\timport devsite-guard\n\trespond "mine"',
  );
  const m = setUpMachine({ caddyfile: guarded });
  const r = await devsite(["init", "--dry-run"], m.caddyfile);
  expect(r.stdout).toContain('deletes "default_bind 127.0.0.1 100.64.0.9" from the Caddyfile');
  expect(r.stdout).toContain("-\tdefault_bind 127.0.0.1 100.64.0.9");
  expect(r.status).toBe(0);
});

test("an import of the user's own: init stops, because the sites it pulls in may need default_bind", async () => {
  const m = setUpMachine({
    caddyfile:
      "{\n\tdefault_bind 127.0.0.1\n}\n\nimport sites/*\nimport devsite.d/*.caddy # devsite\n",
  });
  const r = await devsite(["init"], m.caddyfile);
  expect(r.stderr).toContain("  import sites/*\n");
  expect(r.stderr).toContain("for an import, to the site blocks of the files it pulls in");
  expect(r.status).toBe(1);
});

test("a root Caddy: default_bind stays and init goes on", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: BIND_WITH_SITE });
  const r = await devsite(
    ["init", "--dry-run"],
    m.caddyfile,
    {},
    { settings: { caddy: { user: "root" } } },
  );
  expect(r.stderr).toBe("");
  expect(r.stdout).not.toContain("-\tdefault_bind");
  expect(r.status).toBe(0);
});

// --- a Caddy with no Caddyfile ---

test("a JSON config: init writes devsite.d, prints the adapted JSON with where it goes, and never loads or starts Caddy", async () => {
  await mockAdmin([]);
  const m = setUpMachine({ caddyfile: "", hostFile: null });
  const json = join(m.dir, "caddy.json");
  writeFileSync(json, '{"apps":{}}\n');
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run --config ${json}` };
  const r = await devsite(["init"], m.caddyfile, { caddy });
  expect(existsSync(join(m.dir, "devsite.d", `${HOST}.caddy`))).toBe(true);
  expect(readFileSync(json, "utf8")).toBe('{"apps":{}}\n');
  expect(readFileSync(m.caddyfile, "utf8")).toBe("");
  expect(r.ran.filter((c) => /^(caddy reload|brew services start)/.test(c))).toEqual([]);
  expect(r.ran.some((c) => c.startsWith("caddy adapt --config "))).toBe(true);
  expect(r.stdout).toContain("Add devsite's hosts to your Caddy config, as JSON");
  expect(r.stdout).toContain(
    "  apps.http.servers — the routes go into your server that listens on :443:",
  );
  expect(r.stdout).toContain("  apps.tls.automation.policies — append these policies:");
  expect(r.stdout).toContain('"module": "internal"');
  expect(r.status).toBe(0);
});

test("a Caddy run with no --config: devsite.d goes under Homebrew's etc, and doctor names the admin API as the config", async () => {
  await mockAdmin([]);
  const m = setUpMachine({ caddyfile: "", hostFile: null });
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run`, pid: 4242 };
  const r = await devsite(["init"], m.caddyfile, { caddy });
  expect(r.stdout).toContain(`+++ devsite.d/${HOST}.caddy`);
  expect(r.stdout).not.toContain("+++ Caddyfile");
  expect(r.stdout).toContain("Add devsite's hosts to your Caddy config, as JSON");
  expect(r.status).toBe(0);

  // Until the user adds the JSON, the live config has no route for the host.
  const d = await devsite(["doctor"], m.caddyfile, { caddy });
  expect(d.stdout).toContain(
    "Caddy config: none (Caddy runs (pid 4242) with no --config, so its config came through the admin API)",
  );
  expect(d.stdout).toContain(`devsite's Caddy config: ${join(m.dir, "devsite.d")}`);
  expect(d.stdout).toContain(`✗ ${HOST} has a route in Caddy`);
  expect(d.status).toBe(1);
});

test("a JSON config whose routes Caddy has: init prints no JSON", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: "" });
  const json = join(m.dir, "caddy.json");
  writeFileSync(json, JSON.stringify({ storage: { module: "file_system", root: m.storage } }));
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run --config ${json}` };
  const r = await devsite(["init"], m.caddyfile, { caddy });
  expect(r.stdout).toContain("Nothing to do: init changed nothing.");
  expect(r.stdout).not.toContain("as JSON");
  expect(r.status).toBe(0);
});
