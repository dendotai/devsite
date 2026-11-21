// `devsite init` scenarios: run(["init"]) over a scratch Caddy dir, a scripted runner, and a local mock of Caddy's admin API. Each test reads what init printed, which commands it ran, and its exit code.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CliContext, processRunner } from "../src/context";
import { type CommandCall, cli, fakeStdin, makeRepo, scriptedRunner } from "./helpers";
import { HOST, mockAdmin, pki, placeholder, setUpMachine, snapshot, useMachine } from "./machine";

useMachine();

// The Caddyfile init leaves when the user has a global options block of their own: init keeps it as it is.
const SET_UP_CADDYFILE =
  '{\n\temail dev@example.com\n\tstorage file_system {\n\t\troot "STORAGE"\n\t}\n\tlocal_certs\n}\n\nimport devsite.d/*.caddy # devsite\n';

type Answers = { trusted?: boolean; onBrew?: () => void };

// diff runs for real, so the printed plan carries the real diff; every other command is scripted.
function runner(a: Answers = {}) {
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "openssl" && c.args[0] === "s_client") return { stdout: pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    if (c.cmd === "brew" && c.args[0] === "services") a.onBrew?.();
    return {};
  });
}

async function init(
  caddyfile: string,
  opts: { argv?: string[]; answers?: Answers; stdin?: CliContext["stdin"] } = {},
) {
  const { runCommand, calls } = runner(opts.answers);
  const r = await cli(opts.argv ?? ["init"], {
    cwd: makeRepo(),
    caddyfile,
    runCommand,
    stdin: opts.stdin ?? fakeStdin("y", true),
  });
  const ran = calls.filter((c) => c.cmd !== "diff").map((c) => [c.cmd, ...c.args].join(" "));
  // The commands that act on Caddy or the keychain, in the order they ran.
  const acted = ran.filter((c) => /^(brew|caddy|sudo)/.test(c));
  return { ...r, ran, acted };
}

test("a set-up Mac: no prompt, no sudo, no reload, nothing written, exit 0", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const before = snapshot(m.dir);
  // A non-TTY stdin: a prompt would stop the run with exit 1.
  const r = await init(m.caddyfile, { stdin: fakeStdin("", false) });
  expect(r.stdout).toContain("✓ that CA is trusted in the keychain");
  expect(r.stdout).toContain("Nothing to do: init changed nothing.");
  expect(r.stdout).not.toContain("Apply these changes?");
  expect(r.ran).toEqual([
    "ps -axo pid=,ppid=,user=,args=",
    `openssl s_client -connect 127.0.0.1:443 -servername ${HOST} -showcerts`,
    `security verify-cert -c ${join(m.storage, "pki", "authorities", "local", "root.crt")} -p ssl`,
  ]);
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(0);
});

test("a changed host file with Caddy running: write it and load the config, no sudo", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const r = await init(m.caddyfile);
  expect(r.stdout).toContain(`Step 1 of 2: write 1 file(s) in ${m.dir}, as the diff below shows`);
  expect(r.stdout).toContain("Step 2 of 2: load the Caddy config through Caddy's admin API");
  expect(r.ran).toContain(`caddy reload --config ${m.caddyfile} --adapter caddyfile`);
  expect(r.ran.filter((c) => c.startsWith("sudo") || c.startsWith("brew"))).toEqual([]);
  expect(readFileSync(join(m.dir, "devsite.d", `${HOST}.caddy`), "utf8")).toContain(
    "lifetime 120h",
  );
  expect(r.status).toBe(0);
});

test("an untrusted CA: one step, one sudo call, no write and no reload", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { trusted: false } });
  expect(r.stdout).toContain("Step 1 of 1: trust Caddy's local CA  [sudo]");
  expect(r.ran.filter((c) => c.startsWith("sudo"))).toEqual([
    "sudo -p \n  Password for sudo (%u):  sh -c caddy trust",
  ]);
  expect(r.ran.filter((c) => c.startsWith("caddy") || c.startsWith("brew"))).toEqual([]);
  expect(r.status).toBe(0);
});

test("a fresh Mac with no Caddy: install, write, start Caddy, then the one sudo call", async () => {
  const m = setUpMachine({ caddyfile: "", root: null, hostFile: null, installed: false });
  // `brew services start` brings up the admin API, as the real service does.
  const r = await init(m.caddyfile, { answers: { onBrew: () => void mockAdmin([placeholder()]) } });
  expect(r.stdout).toContain(`✗ Caddy is installed — Homebrew has no caddy formula at ${m.prefix}`);
  expect(r.stdout).toContain("Step 1 of 4: install Caddy with Homebrew");
  expect(r.stdout).toContain("Step 2 of 4: write 2 file(s)");
  expect(r.stdout).toContain("Step 3 of 4: start Caddy as you");
  expect(r.stdout).toContain("Step 4 of 4: trust Caddy's local CA  [sudo]");
  expect(r.acted).toEqual([
    "brew install caddy",
    "brew services start caddy",
    "sudo -p \n  Password for sudo (%u):  sh -c caddy trust",
  ]);
  expect(existsSync(join(m.dir, "devsite.d", `${HOST}.caddy`))).toBe(true);
  expect(r.status).toBe(0);
});

test("an installed Caddy that does not run: started with brew services start, not installed", async () => {
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { onBrew: () => void mockAdmin([placeholder()]) } });
  expect(r.stdout).toContain("Step 1 of 1: start Caddy as you");
  expect(r.acted).toEqual(["brew services start caddy"]);
  expect(r.status).toBe(0);
});

test("init --dry-run prints the numbered plan and the diff, and changes nothing", async () => {
  const m = setUpMachine({ caddyfile: "", root: null, hostFile: null });
  const before = snapshot(m.dir);
  const r = await init(m.caddyfile, { argv: ["init", "--dry-run"] });
  expect(r.stdout).toContain("Plan:");
  expect(r.stdout).toContain("Step 1 of 3: write 2 file(s)");
  expect(r.stdout).toContain("Step 3 of 3: trust Caddy's local CA  [sudo]");
  expect(r.stdout).toContain(`+++ devsite.d/${HOST}.caddy`);
  expect(r.stdout).toContain("+\t\t\tlifetime 120h");
  expect(r.acted).toEqual([]);
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(0);
});

test("a red check init cannot fix: reported with its fix, no prompt, exit 0", async () => {
  await mockAdmin([{ handle: [], terminal: true }, placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { stdin: fakeStdin("", false) });
  expect(r.stdout).toContain(`✗ no route before ${HOST}'s also matches it`);
  expect(r.stdout).toContain("fix: delete that route from Caddy's config");
  expect(r.stdout).toContain("Nothing to do: init changed nothing.");
  expect(r.status).toBe(0);
});

test("Enter answers the prompt with its default, Y: the plan runs", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { trusted: false }, stdin: fakeStdin("\r", true) });
  expect(r.stdout).toContain("Apply these changes? [Y/n] y");
  expect(r.ran.filter((c) => c.startsWith("sudo"))).toHaveLength(1);
  expect(r.status).toBe(0);
});

test("a certificate from another CA: init loads the Caddyfile, so Caddy uses its storage", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, root: pki.otherRoot });
  const r = await init(m.caddyfile);
  expect(r.stdout).toContain(`is served a certificate from another CA`);
  expect(r.stdout).toContain("Step 1 of 1: load the Caddy config through Caddy's admin API");
  expect(r.acted).toEqual([`caddy reload --config ${m.caddyfile} --adapter caddyfile`]);
  expect(r.status).toBe(0);
});
