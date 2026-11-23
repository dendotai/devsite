// `devsite init` scenarios: run(["init"]) over a scratch Caddy dir, a scripted runner, and a local mock of Caddy's admin API. Each test reads what init printed, which commands it ran, and its exit code.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliContext, processRunner } from "../src/context";
import { portFilePath } from "../src/state.mjs";
import { type CommandCall, cli, fakeStdin, MISSING, makeRepo, scriptedRunner } from "./helpers";
import { HOST, mockAdmin, pki, placeholder, setUpMachine, snapshot, useMachine } from "./machine";

useMachine();

// The Caddyfile init leaves when the user has a global options block of their own: init keeps it as it is.
const SET_UP_CADDYFILE =
  '{\n\temail dev@example.com\n\tstorage file_system {\n\t\troot "STORAGE"\n\t}\n}\n\nimport devsite.d/*.caddy # devsite\n';

// adapted: what `caddy adapt` prints for the user's Caddyfile (an empty config when left out); null fails the adapt.
type Answers = { trusted?: boolean; onBrew?: () => void; adapted?: object | null };

// diff runs for real, so the printed plan carries the real diff; every other command is scripted.
function runner(a: Answers = {}) {
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "openssl" && c.args[0] === "s_client") return { stdout: pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    if (/(?:^|\/)tailscale$/i.test(c.cmd)) return MISSING;
    if (c.cmd === "brew" && c.args[0] === "services") a.onBrew?.();
    if (c.cmd === "caddy" && c.args[0] === "adapt") {
      return a.adapted === null ? { status: 1 } : { stdout: JSON.stringify(a.adapted ?? {}) };
    }
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
  const acted = ran.filter((c) => /^(brew|caddy|sudo)/.test(c) && !c.startsWith("caddy adapt "));
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
    "tailscale status --json",
    "/Applications/Tailscale.app/Contents/MacOS/Tailscale status --json",
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
  expect(r.stdout).toContain(`Step 1 of 2: write 1 file in ${m.dir}, as the diff below shows`);
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

test("a check still red after the step that fixes it ran: its fix names that step, not init", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { trusted: false } });
  const after = r.stdout.slice(r.stdout.indexOf("Checks after this run"));
  expect(after).toContain(
    '      fix: read the output of the step "trust Caddy\'s local CA" above: it ran and this is still red',
  );
  expect(after).not.toContain("fix: run `bunx devsite init`");
});

test("a run that trusts the CA shows the phone steps; a red check left keeps the bun dev line out", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { trusted: false } });
  expect(r.stdout).toContain("install and trust the CA root");
  expect(r.stdout).toContain("(iOS: install the profile, then turn it on in Settings");
  expect(r.stdout).not.toContain("bun dev");
});

test("a run that does not touch the CA: no phone steps, and all green gives the bun dev line", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold\n" });
  const r = await init(m.caddyfile);
  expect(r.stdout).not.toContain("Manual, per-device");
  expect(r.stdout).toContain("From now on, run `bun dev`; it needs no sudo.");
  expect(r.status).toBe(0);
});

test("the write step points at the diff in the plan only, not while it runs", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold\n" });
  const r = await init(m.caddyfile);
  const plan = r.stdout.slice(
    r.stdout.indexOf("\nPlan\n"),
    r.stdout.indexOf("Apply these changes"),
  );
  const run = r.stdout.slice(r.stdout.indexOf("Apply these changes"));
  expect(plan).toContain(", as the diff below shows");
  expect(run).toContain("write 1 file in ");
  expect(run).not.toContain("as the diff below shows");
});

test("init checks the port files and the offline page file, as doctor does", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold\n" });
  const r = await init(m.caddyfile);
  const checks = r.stdout.slice(r.stdout.indexOf("Checks"), r.stdout.indexOf("\nPlan\n"));
  expect(checks).toContain("web.test.internal's port file exists");
  expect(checks).toContain("the offline page file");
  const after = r.stdout.slice(r.stdout.indexOf("Checks after this run"));
  expect(after).toContain("✓ web.test.internal's port file exists");
  expect(after).toContain("✓ the offline page file matches what init writes");
});

test("counts read as plain plurals", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold\n" });
  const r = await init(m.caddyfile, { argv: ["init", "--dry-run"] });
  expect(r.stdout).toContain("write 1 file in ");
  expect(r.stdout).toContain("--dry-run: would change 1 file.");
  expect(r.stdout).not.toContain("(s)");
});

test("a file devsite generates whole shows as one line in init, and in full with --dry-run", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, offlineFragment: false });
  const r = await init(m.caddyfile, { stdin: fakeStdin("n", true) });
  expect(r.stdout).toContain("devsite.d/fragments/offline.caddy — devsite's offline page, new");
  expect(r.stdout).not.toContain("+handle_errors 502 503 {");
  const dry = await init(m.caddyfile, { argv: ["init", "--dry-run"] });
  expect(dry.stdout).toContain("+handle_errors 502 503 {");
});

test("a fresh Mac with no Caddy: install, write, start Caddy, then the one sudo call", async () => {
  const m = setUpMachine({ caddyfile: "", root: null, hostFile: null, installed: false });
  // `brew services start` brings up the admin API, as the real service does.
  const r = await init(m.caddyfile, { answers: { onBrew: () => void mockAdmin([placeholder()]) } });
  expect(r.stdout).toContain(`✗ Caddy is installed — Homebrew has no caddy formula at ${m.prefix}`);
  expect(r.stdout).toContain("Step 1 of 4: install Caddy with Homebrew");
  expect(r.stdout).toContain("Step 2 of 4: write 4 files");
  expect(r.stdout).toContain("Step 3 of 4: start Caddy as you");
  expect(r.stdout).toContain("Step 4 of 4: trust Caddy's local CA  [sudo]");
  expect(r.stdout).toContain(`– that CA is trusted in the keychain — ${HOST} has no host file yet`);
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
  expect(r.stdout).toContain("\nPlan\n");
  expect(r.stdout).toContain("Step 1 of 3: write 4 files");
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

test("a host with no port file: init writes the placeholder as you, before the host files", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, portFile: false });
  const portFile = portFilePath(HOST, m.stateDir);
  const r = await init(m.caddyfile);
  expect(r.stdout).toContain(
    `Step 1 of 1: write the port file of ${HOST} in ${join(m.stateDir, "ports")}`,
  );
  expect(readFileSync(portFile, "utf8")).toBe("error 503\n");
  expect(r.acted).toEqual([]);
  expect(r.status).toBe(0);
});

test("no offline page file: init writes it under devsite.d/fragments and loads the config", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, offlineFragment: false });
  const r = await init(m.caddyfile);
  expect(r.stdout).toContain("devsite.d/fragments/offline.caddy — devsite's offline page, new");
  expect(r.ran).toContain(`caddy reload --config ${m.caddyfile} --adapter caddyfile`);
  expect(readFileSync(join(m.dir, "devsite.d", "fragments", "offline.caddy"), "utf8")).toContain(
    "handle_errors 502 503 {",
  );
  expect(r.status).toBe(0);
});

test("a port file that holds a live port: init leaves it as it is", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const portFile = portFilePath(HOST, m.stateDir);
  writeFileSync(portFile, "reverse_proxy 127.0.0.1:50300\n");
  const r = await init(m.caddyfile, { stdin: fakeStdin("", false) });
  expect(r.stdout).toContain("Nothing to do: init changed nothing.");
  expect(readFileSync(portFile, "utf8")).toBe("reverse_proxy 127.0.0.1:50300\n");
  expect(r.status).toBe(0);
});

// A route of the user's Caddyfile, as `caddy adapt` and the live config both hold it.
const userSite = { match: [{ host: ["site.example.com"] }], handle: [], terminal: true };
const adaptedWithUserSite = { apps: { http: { servers: { srv0: { routes: [userSite] } } } } };
const DROP_LINE = "drops the route for api.example.internal, added at runtime by another tool";

test("a runtime route of another tool: the load step names its hosts, in the plan and in --dry-run", async () => {
  const runtime = { match: [{ host: ["api.example.internal"] }], handle: [], terminal: true };
  await mockAdmin([placeholder(), userSite, runtime]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const answers = { adapted: adaptedWithUserSite };
  const dry = await init(m.caddyfile, { argv: ["init", "--dry-run"], answers });
  expect(dry.stdout).toContain("Step 2 of 2: load the Caddy config through Caddy's admin API");
  expect(dry.stdout).toContain(DROP_LINE);
  expect(dry.ran).toContain(`caddy adapt --config ${m.caddyfile} --adapter caddyfile`);
  const r = await init(m.caddyfile, { answers });
  expect(r.stdout).toContain(DROP_LINE);
  expect(r.status).toBe(0);
});

test("only devsite's own routes and the Caddyfile's: the load step lists nothing", async () => {
  await mockAdmin([placeholder(), userSite]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const r = await init(m.caddyfile, {
    argv: ["init", "--dry-run"],
    answers: { adapted: adaptedWithUserSite },
  });
  expect(r.stdout).toContain("Step 2 of 2: load the Caddy config through Caddy's admin API");
  expect(r.stdout).not.toContain("drops the route");
  expect(r.status).toBe(0);
});

test("a Caddyfile that does not adapt: the load step says it cannot list the dropped routes", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const r = await init(m.caddyfile, { argv: ["init", "--dry-run"], answers: { adapted: null } });
  expect(r.stdout).toContain(
    `cannot list the routes this load drops: \`caddy adapt --config ${m.caddyfile} --adapter caddyfile\` failed; run it to see why`,
  );
  expect(r.status).toBe(0);
});

test("a runtime route with a match set that has no host matcher: named as a route for every host", async () => {
  const pathOnly = { match: [{ host: ["site.example.com"] }, { path: ["/x"] }], handle: [] };
  await mockAdmin([placeholder(), userSite, pathOnly]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const r = await init(m.caddyfile, {
    argv: ["init", "--dry-run"],
    answers: { adapted: adaptedWithUserSite },
  });
  expect(r.stdout).toContain(
    "drops a route that matches every host, added at runtime by another tool",
  );
  expect(r.status).toBe(0);
});
