// init keeps the user's Caddy settings (#72): the storage Caddy already uses, a default_bind that guards the user's own sites, and a config that is not a Caddyfile. run(argv) over a scratch Homebrew prefix, a scripted runner, and a local mock of Caddy's admin API.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processRunner } from "../src/context";
import {
  type CommandCall,
  fakeStdin,
  makeIo,
  makeRepo,
  runAndRecordScenario,
  scriptedRunner,
  writeSettings,
} from "./helpers";
import {
  adminWrites,
  loadAdminConfig,
  mockAdmin,
  nodeRoute,
  pki,
  setUpMachine,
  snapshot,
  staleRoute,
  useMachine,
  useNodeWith,
} from "./machine";

useMachine();

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
    if (c.cmd === "caddy" && c.args[0] === "adapt") {
      return processRunner(c.cmd, c.args, { capture: c.capture });
    }
    // A reload of a JSON file loads it as Caddy's live config.
    if (c.cmd === "caddy" && c.args[0] === "reload" && !c.args.includes("--adapter")) {
      loadAdminConfig(JSON.parse(readFileSync(c.args[2] as string, "utf8")));
    }
    if (c.cmd === "openssl") return { stdout: pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    return {};
  });
}

async function devsite(
  argv: string[],
  caddyfile: string,
  answers: Answers = {},
  opts: {
    settings?: object;
    stdin?: ReturnType<typeof fakeStdin>;
    node?: Parameters<typeof useNodeWith>[0];
  } = {},
) {
  const { runCommand, calls } = runner(answers);
  const home = process.env.DEVSITE_USER_HOME ?? "";
  if (opts.settings !== undefined) writeSettings(home, opts.settings);
  const cwd = makeRepo();
  await useNodeWith(opts.node ?? { web: { folder: join(cwd, "apps", "web") } });
  const io = makeIo({
    cwd,
    caddyfile,
    home,
    runCommand,
    stdin: opts.stdin ?? fakeStdin("y", true),
  });
  const status = await runAndRecordScenario(argv, io.ctx);
  const ran = calls.filter((c) => c.cmd !== "diff").map((c) => [c.cmd, ...c.args].join(" "));
  return { status, stdout: io.stdout.text(), stderr: io.stderr.text(), ran };
}

const running = (m: { prefix: string; caddyfile: string }, user = "den") => ({
  user,
  args: `${m.prefix}/opt/caddy/bin/caddy run --config ${m.caddyfile}`,
});

// --- storage: the one Caddy already uses ---

test("a storage line of the user's own: init writes no pin and keeps it", async () => {
  await mockAdmin([nodeRoute()]);
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
  await mockAdmin([nodeRoute()]);
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
  await mockAdmin([nodeRoute()], { caRoot: pki.root });
  const m = staleRoute(setUpMachine({ caddyfile: "" }));
  const support = join(m.home, "Library", "Application Support", "devsite");
  const r = await devsite(["init"], m.caddyfile, { caddy: running(m, "root"), trusted: false });
  // A root Caddy's files are copied into place with sudo, so the plan's diff shows what lands.
  expect(r.stdout).toContain("+import devsite.d/*.caddy # devsite");
  expect(r.stdout).not.toContain("storage file_system");
  expect(r.stdout).toContain("that CA is trusted in the keychain — the CA Caddy's admin API gives");
  expect(r.stdout).toContain(join(support, "caddy-root.crt"));
  expect(readFileSync(join(support, "caddy-root.crt"), "utf8")).toBe(pki.root);
  expect(r.status).toBe(0);

  const d = await devsite(["doctor"], m.caddyfile, { caddy: running(m, "root") });
  expect(d.stdout).toContain(
    "Caddy storage: not read by devsite (the running Caddy's data dir: Caddy runs as ",
  );
  expect(d.stdout).not.toContain("which devsite cannot read");
});

// --- default_bind: deleted only when no site of the user's own needs it ---

const BIND_WITH_SITE =
  '{\n\tdefault_bind 127.0.0.1 100.64.0.9\n}\n\nimport devsite.d/*.caddy # devsite\n\nnotes.localhost {\n\trespond "mine"\n}\n';

test("default_bind and a site block of the user's own: the plan guards the site, deletes default_bind, and names the root way", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: BIND_WITH_SITE });
  const r = await devsite(["init"], m.caddyfile);
  expect(r.stdout).toContain(
    "adds `import devsite-guard` to your site notes.localhost: the guard keeps the LAN out of it in place of default_bind",
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
  await mockAdmin([nodeRoute()]);
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
  expect(r.stderr).toContain("To go on, do this, then run `bunx devsite init` again:");
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
  await mockAdmin([nodeRoute()]);
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

// --- a Caddy with no Caddyfile (#86) ---

const RESTART_NOTE =
  "Caddy runs with no --config and no --resume: a restart drops devsite's route; start Caddy with --resume, or run bunx devsite init after each restart.";
const PAGE = "the devsite node is not running";

// A JSON config of the user's with a server on :443, as Caddy loaded it.
function jsonMachine() {
  const m = setUpMachine({ caddyfile: "" });
  const json = join(m.dir, "caddy.json");
  const user = {
    apps: {
      http: {
        servers: {
          mine: { listen: [":443"], routes: [{ match: [{ host: ["a.example"] }], handle: [] }] },
        },
      },
    },
  };
  writeFileSync(json, `${JSON.stringify(user, null, 2)}\n`);
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run --config ${json}` };
  return { m, json, user, caddy };
}

test("a JSON config: init adds devsite's objects to the file, shows its diff, keeps copies, and reloads it", async () => {
  const { m, json, user, caddy } = jsonMachine();
  await mockAdmin([], { config: user });
  const r = await devsite(["init"], m.caddyfile, { caddy });
  expect(r.stdout).toContain("+++ caddy.json");
  expect(r.stdout).toMatch(/^\+ +"@id": "devsite.node.mine",$/m);
  expect(r.stdout).toContain("load the Caddy config through Caddy's admin API");
  expect(r.ran).toContain(`caddy reload --config ${json}`);
  expect(readFileSync(`${json}.pre-devsite`, "utf8")).toBe(`${JSON.stringify(user, null, 2)}\n`);
  expect(existsSync(`${json}.bak`)).toBe(true);
  const file = JSON.parse(readFileSync(json, "utf8"));
  expect(file.apps.http.servers.mine.routes[0]["@id"]).toBe("devsite.node.mine");
  expect(file.apps.http.servers.mine.routes[1]).toEqual(user.apps.http.servers.mine.routes[0]);
  // The file's route carries the same "node not running" page as the Caddyfile route.
  expect(JSON.stringify(file.apps.http.servers.mine.errors)).toContain(PAGE);
  expect(file.apps.tls.automation.on_demand["@id"]).toBe("devsite.ask");
  expect(r.stdout).not.toContain("as JSON");
  expect(r.status).toBe(0);

  const again = await devsite(["init"], m.caddyfile, { caddy });
  expect(again.stdout).toContain("Nothing to do: init changed nothing.");
});

test("a JSON config and caddy.reload manual: init edits the file and hands the reload to you", async () => {
  const { m, json, user, caddy } = jsonMachine();
  await mockAdmin([], { config: user });
  const r = await devsite(
    ["init"],
    m.caddyfile,
    { caddy },
    { settings: { caddy: { reload: "manual" } } },
  );
  expect(r.stdout).toContain("+++ caddy.json");
  expect(r.ran.filter((c) => c.startsWith("caddy reload"))).toEqual([]);
  expect(r.stdout).toContain(
    `reload Caddy yourself, so it reads the files written above\n  caddy reload --config ${json}\n`,
  );
  expect(r.stdout).not.toContain("as JSON");
  expect(r.status).toBe(0);
});

test("a config file that is not JSON: init prints the JSON, with the one-line answer, and leaves the file", async () => {
  const m = setUpMachine({ caddyfile: "", devsiteFiles: false });
  const yaml = join(m.dir, "caddy.yaml");
  writeFileSync(yaml, "apps: {}\n");
  const caddy = {
    user: "den",
    args: `${m.prefix}/opt/caddy/bin/caddy run --config ${yaml} --adapter yaml`,
  };
  await mockAdmin([]);
  const r = await devsite(["init"], m.caddyfile, { caddy }, { node: {} });
  expect(readFileSync(yaml, "utf8")).toBe("apps: {}\n");
  expect(existsSync(join(m.dir, "devsite.d"))).toBe(false);
  expect(r.ran.filter((c) => c.startsWith("caddy reload"))).toEqual([]);
  expect(r.stdout).toContain("Add devsite's route to your Caddy config, as JSON");
  expect(r.stdout).toContain(
    "  apps.http.servers — the routes go into your server that listens on :443:",
  );
  expect(r.stdout).toContain("the node does not answer — run bunx devsite doctor");
  expect(r.stdout).not.toContain(PAGE);
  const after = r.stdout.slice(r.stdout.indexOf("Checks after this run"));
  expect(after).toContain(
    "fix: add the JSON below to your Caddy config, then run `bunx devsite doctor`",
  );
  expect(r.status).toBe(0);
});

test("a Caddy run with no --config: init writes devsite's objects through the admin API and says a restart drops them", async () => {
  const m = setUpMachine({ caddyfile: "", devsiteFiles: false });
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run`, pid: 4242 };
  await mockAdmin([], { config: { apps: { http: { servers: { mine: { listen: [":443"] } } } } } });
  const r = await devsite(["init"], m.caddyfile, { caddy });
  expect(r.stdout).toContain("add devsite's route to Caddy through its admin API");
  expect(r.stdout).toContain("adds devsite's route first in server mine");
  // Only a Caddyfile imports devsite.d, so a Caddy with no Caddyfile gets none.
  expect(r.stdout).not.toContain("write ");
  expect(existsSync(join(m.dir, "devsite.d"))).toBe(false);
  expect(r.stdout).toContain(RESTART_NOTE);
  expect(adminWrites.map((w) => `${w.method} ${w.path}`)).toEqual([
    "PUT /config/apps/http/servers/mine/routes",
    "PUT /config/apps/http/servers/mine/errors",
    "PUT /config/apps/tls",
    "PUT /config/apps/tls/automation/on_demand",
  ]);
  expect(JSON.stringify(adminWrites[1]?.body)).toContain(PAGE);
  expect(r.stdout).not.toContain("as JSON");
  const after = r.stdout.slice(r.stdout.indexOf("Checks after this run"));
  expect(after).toContain("✓ Caddy has devsite's route for *.internal and *.localhost");
  expect(r.status).toBe(0);

  // The live config now holds devsite's objects, so a rerun writes nothing.
  const again = await devsite(["init"], m.caddyfile, { caddy });
  expect(again.stdout).toContain("Nothing to do: init changed nothing.");

  const d = await devsite(["doctor"], m.caddyfile, { caddy });
  expect(d.stdout).toContain(
    "Caddy config: none (Caddy runs (pid 4242) with no --config, so its config came through the admin API)",
  );
});

test("a Caddy run with --resume: no line about a restart", async () => {
  const m = setUpMachine({ caddyfile: "", devsiteFiles: false });
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run --resume` };
  await mockAdmin([], { config: null });
  const r = await devsite(["init", "--dry-run"], m.caddyfile, { caddy });
  expect(r.stdout).toContain("adds a server devsite that listens on :443, with devsite's route");
  expect(r.stdout).not.toContain("a restart drops");
  expect(adminWrites).toEqual([]);
  expect(r.status).toBe(0);
});

test("a Caddy config that turns persist off: the plan says a restart drops devsite's route", async () => {
  const m = setUpMachine({ caddyfile: "", devsiteFiles: false });
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run --resume` };
  await mockAdmin([], { config: { admin: { config: { persist: false } } } });
  const r = await devsite(["init", "--dry-run"], m.caddyfile, { caddy });
  expect(r.stdout).toContain(
    "Caddy's config turns admin.config.persist off: a restart drops devsite's route; run bunx devsite init after each restart.",
  );
});

test("a Caddy run with no --config and caddy.reload manual: init prints the JSON and writes nothing to Caddy", async () => {
  const m = setUpMachine({ caddyfile: "", devsiteFiles: false });
  const caddy = { user: "den", args: `${m.prefix}/opt/caddy/bin/caddy run`, pid: 4242 };
  await mockAdmin([]);
  const settings = { caddy: { reload: "manual" } };
  const r = await devsite(["init"], m.caddyfile, { caddy }, { settings });
  expect(r.stdout).toContain("Add devsite's route to your Caddy config, as JSON");
  expect(adminWrites).toEqual([]);
  expect(r.status).toBe(0);

  const d = await devsite(["doctor"], m.caddyfile, { caddy }, { settings });
  expect(d.stdout).toContain("✗ Caddy has devsite's route for *.internal and *.localhost");
  expect(d.stdout).toContain(
    "fix: run `bunx devsite init`, then add the JSON it prints to your Caddy config",
  );
  expect(d.status).toBe(1);
});
