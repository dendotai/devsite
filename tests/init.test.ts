// `devsite init` scenarios: run(["init"]) over a scratch Caddy dir, a scripted runner, a local mock of Caddy's admin API, and a real node. Each test reads what init printed, which commands it ran, and its exit code.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type CliContext, processRunner } from "../src/context";
import { installNode } from "../src/node/install";
import {
  type CommandCall,
  cli,
  fakeStdin,
  MISSING,
  makeIo,
  makeRepo,
  scriptedRunner,
} from "./helpers";
import {
  HOST,
  mockAdmin,
  nodeRoute,
  pki,
  setUpMachine,
  snapshot,
  staleRoute,
  USER_CADDYFILE,
  useMachine,
  useNodeWith,
} from "./machine";

useMachine();

const SET_UP_CADDYFILE = USER_CADDYFILE;

// adapted: what `caddy adapt` prints for the user's Caddyfile (an empty config when left out); null fails the adapt. onBootstrap: what `launchctl bootstrap` brings up.
type Answers = {
  trusted?: boolean;
  onBrew?: () => void;
  onBootstrap?: () => void;
  adapted?: object | null;
};

// diff runs for real, so the printed plan carries the real diff; every other command is scripted.
function runner(a: Answers = {}) {
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "openssl" && c.args[0] === "s_client") return { stdout: pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    if (/(?:^|\/)tailscale$/i.test(c.cmd)) return MISSING;
    if (c.cmd === "brew" && c.args[0] === "services") a.onBrew?.();
    if (c.cmd === "launchctl" && c.args[0] === "bootstrap") a.onBootstrap?.();
    if (c.cmd === "caddy" && c.args[0] === "adapt") {
      return a.adapted === null ? { status: 1 } : { stdout: JSON.stringify(a.adapted ?? {}) };
    }
    return {};
  });
}

// node: false starts no node; by default the node knows the project web.
async function init(
  caddyfile: string,
  opts: {
    argv?: string[];
    answers?: Answers;
    stdin?: CliContext["stdin"];
    node?: false;
    env?: CliContext["env"];
  } = {},
) {
  if (opts.node !== false) await useNodeWith({ web: {} });
  const { runCommand, calls } = runner(opts.answers);
  const r = await cli(opts.argv ?? ["init"], {
    cwd: makeRepo(),
    caddyfile,
    runCommand,
    stdin: opts.stdin ?? fakeStdin("y", true),
    env: opts.env,
  });
  const ran = calls.filter((c) => c.cmd !== "diff").map((c) => [c.cmd, ...c.args].join(" "));
  // The commands that act on Caddy, the keychain, or the node, in the order they ran.
  const acted = ran.filter(
    (c) => /^(brew|caddy|sudo|launchctl)/.test(c) && !c.startsWith("caddy adapt "),
  );
  return { ...r, ran, acted };
}

test("a set-up Mac: no prompt, no sudo, no reload, nothing written, exit 0", async () => {
  await mockAdmin([nodeRoute()]);
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

test("a changed route file with Caddy running: write it and load the config, no sudo", async () => {
  await mockAdmin([nodeRoute()]);
  const m = staleRoute(setUpMachine({ caddyfile: SET_UP_CADDYFILE }));
  const r = await init(m.caddyfile);
  expect(r.stdout).toContain(`Step 1 of 2: write 1 file in ${m.dir}, as the diff below shows`);
  expect(r.stdout).toContain("devsite.d/node.caddy — devsite's route to the node, rewritten");
  expect(r.stdout).toContain("Step 2 of 2: load the Caddy config through Caddy's admin API");
  expect(r.ran).toContain(`caddy reload --config ${m.caddyfile} --adapter caddyfile`);
  expect(r.ran.filter((c) => c.startsWith("sudo") || c.startsWith("brew"))).toEqual([]);
  expect(readFileSync(join(m.dir, "devsite.d", "node.caddy"), "utf8")).toContain(
    "reverse_proxy 127.0.0.1:47380",
  );
  expect(r.status).toBe(0);
});

test("an untrusted CA: one step, one sudo call, no write and no reload", async () => {
  await mockAdmin([nodeRoute()]);
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
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { trusted: false } });
  const after = r.stdout.slice(r.stdout.indexOf("Checks after this run"));
  expect(after).toContain(
    '      fix: read the output of the step "trust Caddy\'s local CA" above: it ran and this is still red',
  );
  expect(after).not.toContain("fix: run `bunx devsite init`");
});

test("a run that trusts the CA shows the phone steps; a red check left keeps the bun dev line out", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { trusted: false } });
  expect(r.stdout).toContain("install and trust the CA root");
  expect(r.stdout).toContain("(iOS: install the profile, then turn it on in Settings");
  expect(r.stdout).not.toContain("bun dev");
});

test("a run that does not touch the CA: no phone steps, and all green gives the bun dev line", async () => {
  await mockAdmin([nodeRoute()]);
  const m = staleRoute(setUpMachine({ caddyfile: SET_UP_CADDYFILE }));
  const r = await init(m.caddyfile);
  expect(r.stdout).not.toContain("Manual, per-device");
  expect(r.stdout).toContain("From now on, run `bun dev` in any project; it needs no sudo.");
  expect(r.status).toBe(0);
});

test("the write step points at the diff in the plan only, not while it runs", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  writeFileSync(m.caddyfile, "import devsite.d/*.caddy # devsite\n");
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

test("no node: init installs it as you, before the one sudo call, and the checks after go green", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, {
    node: false,
    answers: { trusted: false, onBootstrap: () => void useNodeWith() },
  });
  expect(r.stdout).toContain("✗ the node answers on 127.0.0.1:47380 — no answer");
  expect(r.stdout).toContain("Step 1 of 2: install the node and start it at login, as you");
  expect(r.stdout).toContain("Step 2 of 2: trust Caddy's local CA  [sudo]");
  const uid = process.getuid?.();
  expect(r.acted).toEqual([
    `launchctl bootout gui/${uid}/ai.den.devsite.node`,
    `launchctl bootstrap gui/${uid} ${join(m.home, "Library", "LaunchAgents", "ai.den.devsite.node.plist")}`,
    "sudo -p \n  Password for sudo (%u):  sh -c caddy trust",
  ]);
  const plist = readFileSync(
    join(m.home, "Library", "LaunchAgents", "ai.den.devsite.node.plist"),
    "utf8",
  );
  const program = join(m.home, "Library", "Application Support", "devsite", "node", "cli.js");
  expect(plist).toContain(`<string>${program}</string>\n\t\t<string>node</string>`);
  expect(plist).toContain(
    `<string>${join(m.home, "Library", "Logs", "devsite", "node.log")}</string>`,
  );
  expect(existsSync(program)).toBe(true);
  const after = r.stdout.slice(r.stdout.indexOf("Checks after this run"));
  expect(after).toContain("✓ the node answers on 127.0.0.1:47380");
});

test("a process that still holds the node's port after the bootout: the install stops and names it", async () => {
  await useNodeWith();
  const { runCommand, calls } = scriptedRunner(() => ({}));
  const { ctx } = makeIo({ runCommand, env: { DEVSITE_NODE_WAIT_MS: "300" } });
  await expect(installNode(ctx)).rejects.toThrow(
    new RegExp(
      `^process ${process.pid} \\(devsite 0\\.0\\.0\\) holds 127\\.0\\.0\\.1:47380, and it is not the node's LaunchAgent\\. Stop it, then run init again\\.$`,
    ),
  );
  expect(calls.map((c) => `${c.cmd} ${c.args[0]}`)).toEqual(["launchctl bootout"]);
});

test("init run from source stops before it touches the node, and says to build first", async () => {
  const { runCommand, calls } = scriptedRunner(() => ({}));
  const { ctx } = makeIo({ runCommand, env: { DEVSITE_NODE_PROGRAM: undefined } });
  await expect(installNode(ctx)).rejects.toThrow(
    "init installs the node from the built devsite: run `bun run build`, then `node dist/cli.js init`",
  );
  expect(calls).toEqual([]);
});

test("a bootstrap that launchd refuses while the old node exits is tried again", async () => {
  let tries = 0;
  const { runCommand } = scriptedRunner((c) => {
    if (c.cmd !== "launchctl" || c.args[0] !== "bootstrap") return {};
    tries++;
    if (tries < 3) return { status: 5 };
    void useNodeWith();
    return {};
  });
  const { ctx } = makeIo({ runCommand, env: { DEVSITE_NODE_WAIT_MS: "2000" } });
  await installNode(ctx);
  expect(tries).toBe(3);
});

test("a node that does not come up after the install: init stops and names the node's log", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { node: false, env: { DEVSITE_NODE_WAIT_MS: "300" } });
  expect(r.stderr).toContain(
    `the node did not answer within 0.3 s. See its log: ${join(m.home, "Library", "Logs", "devsite", "node.log")}`,
  );
  expect(r.status).toBe(1);
});

test("counts read as plain plurals", async () => {
  await mockAdmin([nodeRoute()]);
  const m = staleRoute(setUpMachine({ caddyfile: SET_UP_CADDYFILE }));
  const r = await init(m.caddyfile, { argv: ["init", "--dry-run"] });
  expect(r.stdout).toContain("write 1 file in ");
  expect(r.stdout).toContain("--dry-run: would change 1 file.");
  expect(r.stdout).not.toContain("(s)");
});

test("a file devsite generates whole shows as one line in init, and in full with --dry-run", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, devsiteFiles: false });
  const r = await init(m.caddyfile, { stdin: fakeStdin("n", true) });
  expect(r.stdout).toContain("devsite.d/node.caddy — devsite's route to the node, new");
  expect(r.stdout).not.toContain("+\thandle_errors 502 {");
  const dry = await init(m.caddyfile, { argv: ["init", "--dry-run"] });
  expect(dry.stdout).toContain("+\thandle_errors 502 {");
});

test("a fresh Mac with no Caddy and no node: node, install, write, start Caddy, then the one sudo call", async () => {
  const m = setUpMachine({ caddyfile: "", root: null, devsiteFiles: false, installed: false });
  // `brew services start` brings up the admin API, and `launchctl bootstrap` the node, as the real services do.
  const r = await init(m.caddyfile, {
    node: false,
    answers: {
      onBrew: () => void mockAdmin([nodeRoute()]),
      onBootstrap: () => void useNodeWith(),
    },
  });
  expect(r.stdout).toContain(`✗ Caddy is installed — Homebrew has no caddy formula at ${m.prefix}`);
  expect(r.stdout).toContain("Step 1 of 5: install the node and start it at login, as you");
  expect(r.stdout).toContain("Step 2 of 5: install Caddy with Homebrew");
  expect(r.stdout).toContain("Step 3 of 5: write 3 files");
  expect(r.stdout).toContain("Step 4 of 5: start Caddy as you");
  expect(r.stdout).toContain("Step 5 of 5: trust Caddy's local CA  [sudo]");
  expect(r.stdout).toContain(
    "– that CA is trusted in the keychain — no project has run on this Mac yet",
  );
  expect(r.acted.filter((c) => !c.startsWith("launchctl"))).toEqual([
    "brew install caddy",
    "brew services start caddy",
    "sudo -p \n  Password for sudo (%u):  sh -c caddy trust",
  ]);
  expect(existsSync(join(m.dir, "devsite.d", "node.caddy"))).toBe(true);
  expect(r.status).toBe(0);
});

test("an installed Caddy that does not run: started with brew services start, not installed", async () => {
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { onBrew: () => void mockAdmin([nodeRoute()]) } });
  expect(r.stdout).toContain("Step 1 of 1: start Caddy as you");
  expect(r.acted).toEqual(["brew services start caddy"]);
  expect(r.status).toBe(0);
});

test("init --dry-run prints the numbered plan and the diff, and changes nothing", async () => {
  const m = setUpMachine({ caddyfile: "", root: null, devsiteFiles: false });
  const before = snapshot(m.dir);
  const r = await init(m.caddyfile, { argv: ["init", "--dry-run"] });
  expect(r.stdout).toContain("\nPlan\n");
  expect(r.stdout).toContain("Step 1 of 3: write 3 files");
  expect(r.stdout).toContain("Step 3 of 3: trust Caddy's local CA  [sudo]");
  expect(r.stdout).toContain("+++ devsite.d/node.caddy");
  expect(r.stdout).toContain("+\t\t\tlifetime 120h");
  expect(r.acted).toEqual([]);
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(0);
});

test("a red check init cannot fix: reported with its fix, no prompt, exit 0", async () => {
  await mockAdmin([{ handle: [], terminal: true }, nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { stdin: fakeStdin("", false) });
  expect(r.stdout).toContain("✗ no route before devsite's takes its names");
  expect(r.stdout).toContain("fix: delete that route from Caddy's config");
  expect(r.stdout).toContain("Nothing to do: init changed nothing.");
  expect(r.status).toBe(0);
});

test("Enter answers the prompt with its default, Y: the plan runs", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const r = await init(m.caddyfile, { answers: { trusted: false }, stdin: fakeStdin("\r", true) });
  expect(r.stdout).toContain("Apply these changes? [Y/n] y");
  expect(r.ran.filter((c) => c.startsWith("sudo"))).toHaveLength(1);
  expect(r.status).toBe(0);
});

test("a certificate from another CA: init loads the Caddyfile, so Caddy uses its storage", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, root: pki.otherRoot });
  const r = await init(m.caddyfile);
  expect(r.stdout).toContain(`is served a certificate from another CA`);
  expect(r.stdout).toContain("Step 1 of 1: load the Caddy config through Caddy's admin API");
  expect(r.acted).toEqual([`caddy reload --config ${m.caddyfile} --adapter caddyfile`]);
  expect(r.status).toBe(0);
});

// A route of the user's Caddyfile, as `caddy adapt` and the live config both hold it. The Caddyfile imports devsite.d, so its adapted config holds devsite's route too.
const userSite = { match: [{ host: ["site.example.com"] }], handle: [], terminal: true };
const adaptedWithUserSite = {
  apps: { http: { servers: { srv0: { routes: [nodeRoute(), userSite] } } } },
};
const DROP_LINE = "drops the route for api.example.internal, added at runtime by another tool";

test("a runtime route of another tool: the load step names its hosts, in the plan and in --dry-run", async () => {
  const runtime = { match: [{ host: ["api.example.internal"] }], handle: [], terminal: true };
  await mockAdmin([nodeRoute(), userSite, runtime]);
  const m = staleRoute(setUpMachine({ caddyfile: SET_UP_CADDYFILE }));
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
  await mockAdmin([nodeRoute(), userSite]);
  const m = staleRoute(setUpMachine({ caddyfile: SET_UP_CADDYFILE }));
  const r = await init(m.caddyfile, {
    argv: ["init", "--dry-run"],
    answers: { adapted: adaptedWithUserSite },
  });
  expect(r.stdout).toContain("Step 2 of 2: load the Caddy config through Caddy's admin API");
  expect(r.stdout).not.toContain("drops the route");
  expect(r.status).toBe(0);
});

test("a Caddyfile that does not adapt: the load step says it cannot list the dropped routes", async () => {
  await mockAdmin([nodeRoute()]);
  const m = staleRoute(setUpMachine({ caddyfile: SET_UP_CADDYFILE }));
  const r = await init(m.caddyfile, { argv: ["init", "--dry-run"], answers: { adapted: null } });
  expect(r.stdout).toContain(
    `cannot list the routes this load drops: \`caddy adapt --config ${m.caddyfile} --adapter caddyfile\` failed; run it to see why`,
  );
  expect(r.status).toBe(0);
});

test("a runtime route with a match set that has no host matcher: named as a route for every host", async () => {
  const pathOnly = { match: [{ host: ["site.example.com"] }, { path: ["/x"] }], handle: [] };
  await mockAdmin([nodeRoute(), userSite, pathOnly]);
  const m = staleRoute(setUpMachine({ caddyfile: SET_UP_CADDYFILE }));
  const r = await init(m.caddyfile, {
    argv: ["init", "--dry-run"],
    answers: { adapted: adaptedWithUserSite },
  });
  expect(r.stdout).toContain(
    "drops a route that matches every host, added at runtime by another tool",
  );
  expect(r.status).toBe(0);
});
