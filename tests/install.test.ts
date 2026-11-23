// The install seam, the settings file, and a root Caddy, as init and doctor see them: run(argv) over a scratch Homebrew prefix, a scripted runner (ps, brew, openssl, security, sudo), and a local mock of Caddy's admin API.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processRunner } from "../src/context";
import {
  type CommandCall,
  fakeStdin,
  makeIo,
  makeRepo,
  makeStateDir,
  runAndRecordScenario,
  scriptedRunner,
} from "./helpers";
import { HOST, mockAdmin, pki, placeholder, setUpMachine, useMachine } from "./machine";

useMachine();

const SET_UP_CADDYFILE =
  '{\n\temail dev@example.com\n\tstorage file_system {\n\t\troot "STORAGE"\n\t}\n}\n\nimport devsite.d/*.caddy # devsite\n';

type Answers = {
  // The `caddy run` line ps prints, without pid and ppid.
  caddy?: { user: string; args: string; pid?: number; ppid?: number };
  brewPrefix?: string | null;
  brewServicePid?: number;
  trusted?: boolean;
};

function runner(a: Answers = {}) {
  return scriptedRunner((c: CommandCall) => {
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "ps") {
      const p = a.caddy;
      return {
        stdout: `  1     0 root  /sbin/launchd\n${p ? `  ${p.pid ?? 774}  ${p.ppid ?? 1} ${p.user}  ${p.args}\n` : ""}`,
      };
    }
    if (c.cmd === "brew" && c.args[0] === "--prefix") {
      return a.brewPrefix === null
        ? { status: 1 }
        : { stdout: `${a.brewPrefix ?? "/opt/homebrew"}\n` };
    }
    if (c.cmd === "brew" && c.args[1] === "info") {
      return {
        stdout: JSON.stringify([{ name: "caddy", pid: a.brewServicePid ?? null, log_path: null }]),
      };
    }
    if (c.cmd === "openssl") return { stdout: pki.served };
    if (c.cmd === "security") return { status: a.trusted === false ? 1 : 0 };
    if (c.cmd === "caddy" && c.args[0] === "adapt") return { stdout: "{}" };
    return {};
  });
}

async function devsite(
  argv: string[],
  opts: {
    caddyfile?: string;
    answers?: Answers;
    settings?: object;
    noPrefixOverride?: boolean;
    stateDir?: string;
  } = {},
) {
  const { runCommand, calls } = runner(opts.answers);
  const configHome = mkdtempSync(join(tmpdir(), "devsite-config-"));
  if (opts.settings !== undefined) {
    mkdirSync(join(configHome, "devsite"));
    writeFileSync(join(configHome, "devsite", "config.json"), JSON.stringify(opts.settings));
  }
  const io = makeIo({
    cwd: makeRepo(),
    caddyfile: opts.caddyfile,
    configHome,
    runCommand,
    stdin: fakeStdin("y", true),
  });
  if (opts.noPrefixOverride) delete io.ctx.env.DEVSITE_BREW_PREFIX;
  if (opts.stateDir !== undefined) io.ctx.env.DEVSITE_STATE_DIR = opts.stateDir;
  const status = await runAndRecordScenario(argv, io.ctx);
  const ran = calls.filter((c) => c.cmd !== "diff").map((c) => [c.cmd, ...c.args].join(" "));
  return {
    status,
    stdout: io.stdout.text(),
    stderr: io.stderr.text(),
    ran,
    sudo: ran.filter((c) => c.startsWith("sudo")),
    configHome,
  };
}

// --- the Homebrew prefix comes from `brew --prefix` ---

for (const prefix of ["/opt/homebrew", "/usr/local"]) {
  test(`brew --prefix ${prefix}: doctor reads Caddy's paths under it`, async () => {
    const r = await devsite(["doctor"], {
      noPrefixOverride: true,
      answers: { brewPrefix: prefix },
    });
    expect(r.ran).toContain("brew --prefix");
    expect(r.stdout).toContain(`Caddy: Homebrew at ${prefix}`);
    expect(r.stdout).toContain(`Caddy config: ${prefix}/etc/Caddyfile (Homebrew's default)`);
    expect(r.stdout).toContain(`devsite's Caddy config: ${prefix}/etc/devsite.d`);
    expect(r.stdout).toContain(`Caddy log: ${prefix}/var/log/caddy.log`);
  });
}

// --- a running Caddy keeps its config and its service manager ---

test("a running Caddy with another --config: init writes beside that config and reloads it", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const other = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const caddy = {
    user: "den",
    args: `${m.prefix}/opt/caddy/bin/caddy run --config ${other.caddyfile} --adapter caddyfile`,
  };
  const r = await devsite(["init"], {
    caddyfile: m.caddyfile,
    answers: { caddy, brewServicePid: 774 },
  });
  expect(r.ran).toContain(`caddy reload --config ${other.caddyfile} --adapter caddyfile`);
  expect(r.ran.filter((c) => c.startsWith("brew services start"))).toEqual([]);
  expect(readFileSync(join(other.dir, "devsite.d", `${HOST}.caddy`), "utf8")).toContain(
    `${HOST}, web.test.localhost {`,
  );
  expect(readFileSync(join(m.dir, "devsite.d", `${HOST}.caddy`), "utf8")).toContain(
    `${HOST}, web.test.localhost {`,
  );
  expect(r.status).toBe(0);

  const d = await devsite(["doctor"], {
    caddyfile: m.caddyfile,
    answers: { caddy, brewServicePid: 774 },
  });
  expect(d.stdout).toContain(`Caddy config: ${other.caddyfile} (the running Caddy's --config)`);
  expect(d.stdout).toContain("Service manager: brew services");
  expect(d.stdout).toContain("Runs as: you (the running Caddy)");
});

test("a Caddy run by hand in a terminal: doctor names the foreground process", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  const caddy = { user: "den", args: `caddy run --config ${m.caddyfile}`, pid: 4242, ppid: 4000 };
  const r = await devsite(["doctor"], { caddyfile: m.caddyfile, answers: { caddy } });
  expect(r.stdout).toContain("Service manager: a foreground process (pid 4242)");
});

test("Caddy runs but its admin API does not answer: init does not start a second Caddy", async () => {
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const caddy = {
    user: "den",
    args: `${m.prefix}/opt/caddy/bin/caddy run --config ${m.caddyfile}`,
  };
  const r = await devsite(["init"], { caddyfile: m.caddyfile, answers: { caddy } });
  expect(r.stdout).toContain("but Caddy runs (pid 774)");
  expect(r.stdout).toContain("fix: make Caddy's admin API listen on");
  expect(r.ran.filter((c) => c.startsWith("brew services start"))).toEqual([]);
  expect(r.status).toBe(0);
});

// --- a root Caddy ---

test("a root Caddy: write, reload, and trust run in exactly one sudo call", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const caddy = {
    user: "root",
    args: `${m.prefix}/opt/caddy/bin/caddy run --config ${m.caddyfile}`,
  };
  const hostFile = join(m.dir, "devsite.d", `${HOST}.caddy`);
  const r = await devsite(["init"], { caddyfile: m.caddyfile, answers: { caddy, trusted: false } });
  expect(r.stdout).toContain(
    `Step 1 of 3: write 1 file in ${m.dir}, as the diff below shows  [sudo]`,
  );
  expect(r.stdout).toContain(
    "Step 2 of 3: load the Caddy config through Caddy's admin API  [sudo]",
  );
  expect(r.stdout).toContain("Step 3 of 3: trust Caddy's local CA  [sudo]");
  expect(r.sudo).toHaveLength(1);
  const script = r.sudo[0] as string;
  expect(script).toMatch(new RegExp(`cp \\S+devsite\\.next\\.\\S+ ${hostFile} && `));
  expect(script).toContain(
    `&& caddy reload --config ${m.caddyfile} --adapter caddyfile && caddy trust`,
  );
  // The files go into place only through sudo.
  expect(readFileSync(hostFile, "utf8")).toBe("# web\nold {\n}\n");
  expect(r.ran.filter((c) => c.startsWith("caddy ") && !c.startsWith("caddy adapt "))).toEqual([]);
  expect(r.status).toBe(0);
});

test("caddy.user root with Caddy stopped: start, wait for the admin API, and trust in one sudo call", async () => {
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, root: null });
  const r = await devsite(["init"], {
    caddyfile: m.caddyfile,
    settings: { caddy: { user: "root" } },
  });
  expect(r.stdout).toContain("start Caddy as root  [sudo]");
  expect(r.sudo).toHaveLength(1);
  expect(r.sudo[0]).toContain("sh -c brew services start caddy && sh -c 'i=0; until curl");
  expect(r.sudo[0]).toContain("&& caddy trust");
  // The shell loop runs inside the sudo call; the step list names what it waits for.
  expect(r.stdout).toContain("  wait up to 5 s for Caddy's admin API\n");
  expect(r.stdout).not.toContain("sudo sh -c 'i=0");
  expect(r.status).toBe(0);
});

// --- an install devsite does not know ---

test("Caddy from outside Homebrew with --config: init writes beside that config and reloads it", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const caddy = { user: "den", args: `/usr/local/bin/caddy run --config ${m.caddyfile}` };
  const r = await devsite(["init"], { caddyfile: m.caddyfile, answers: { caddy } });
  expect(r.stdout).toContain("✓ Caddy is installed — an install devsite does not know");
  expect(r.ran).toContain(`caddy reload --config ${m.caddyfile} --adapter caddyfile`);
  expect(readFileSync(join(m.dir, "devsite.d", `${HOST}.caddy`), "utf8")).toContain(
    `${HOST}, web.test.localhost {`,
  );
  expect(r.status).toBe(0);
});

test("Caddy from outside Homebrew at /etc/caddy: doctor reads its config from the running Caddy's --config", async () => {
  const caddy = { user: "den", args: "/usr/local/bin/caddy run --config /etc/caddy/Caddyfile" };
  const d = await devsite(["doctor"], { answers: { caddy } });
  expect(d.stdout).toContain("Caddy: an install devsite does not know");
  expect(d.stdout).toContain("Caddy config: /etc/caddy/Caddyfile (the running Caddy's --config)");
  expect(d.stdout).toContain("devsite's Caddy config: /etc/caddy/devsite.d");
  expect(d.stdout).not.toContain("devsite knows this Mac's Caddy install");
});

test("Caddy from outside Homebrew with no --config: init stops and names caddy.config, doctor reports the same", async () => {
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
  const caddy = { user: "den", args: "/usr/local/bin/caddy run" };
  const r = await devsite(["init"], { caddyfile: m.caddyfile, answers: { caddy } });
  expect(r.stderr).toContain(
    "This Mac's Caddy is an install devsite does not know: Caddy runs from /usr/local/bin/caddy, which is not Homebrew's Caddy, with no --config.",
  );
  expect(r.stderr).toContain(
    `set caddy.config to the path of your main Caddy config in ${join(r.configHome, "devsite", "config.json")}`,
  );
  expect(r.status).toBe(1);

  const d = await devsite(["doctor"], { caddyfile: m.caddyfile, answers: { caddy } });
  expect(d.stdout).toContain(
    "✗ devsite knows this Mac's Caddy install — Caddy runs from /usr/local/bin/caddy",
  );
  expect(d.stdout).toContain("fix: set caddy.config to the path of your main Caddy config in");
  expect(d.stdout).toContain("– the host files of this repo — they need Caddy's paths");
  expect(d.status).toBe(1);
});

test("a caddy put under the Homebrew prefix by hand: not Homebrew's, so init stops", async () => {
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, installed: false });
  mkdirSync(join(m.prefix, "bin"));
  writeFileSync(join(m.prefix, "bin", "caddy"), "");
  const caddy = { user: "den", args: `${m.prefix}/bin/caddy run` };
  const r = await devsite(["init"], { caddyfile: m.caddyfile, answers: { caddy } });
  expect(r.stderr).toContain(
    `Caddy runs from ${m.prefix}/bin/caddy, which is not Homebrew's Caddy`,
  );
  expect(r.status).toBe(1);
});

test("no Homebrew: init stops and names caddy.config", async () => {
  const r = await devsite(["init"], { noPrefixOverride: true, answers: { brewPrefix: null } });
  expect(r.stderr).toContain(
    "This Mac's Caddy is an install devsite does not know: Homebrew is not on this Mac.",
  );
  expect(r.stderr).toContain("set caddy.config");
  expect(r.status).toBe(1);
});

// --- each setting on ---

test("caddy.config gets an unknown install past the stop: init writes beside that config", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const caddy = { user: "den", args: "/usr/local/bin/caddy run --config /somewhere/else" };
  const r = await devsite(["init"], {
    caddyfile: m.caddyfile,
    answers: { caddy },
    settings: { caddy: { config: m.caddyfile } },
  });
  expect(r.stdout).toContain(`✓ Caddy is installed — an install devsite does not know`);
  expect(r.ran).toContain(`caddy reload --config ${m.caddyfile} --adapter caddyfile`);
  expect(readFileSync(join(m.dir, "devsite.d", `${HOST}.caddy`), "utf8")).toContain(
    `${HOST}, web.test.localhost {`,
  );
  expect(r.status).toBe(0);
});

test("caddy.user root over a Caddy that runs as the user: init writes and reloads with sudo", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const caddy = {
    user: "den",
    args: `${m.prefix}/opt/caddy/bin/caddy run --config ${m.caddyfile}`,
  };
  const r = await devsite(["init"], {
    caddyfile: m.caddyfile,
    answers: { caddy },
    settings: { caddy: { user: "root" } },
  });
  expect(r.sudo).toHaveLength(1);
  expect(r.sudo[0]).toContain(`caddy reload --config ${m.caddyfile}`);
  expect(r.status).toBe(0);
  const d = await devsite(["doctor"], {
    caddyfile: m.caddyfile,
    answers: { caddy },
    settings: { caddy: { user: "root" } },
  });
  expect(d.stdout).toContain("Runs as: root (the caddy.user setting)");
});

test("caddy.reload manual: init writes the files, does not reload, and prints the reload command", async () => {
  const runtime = { match: [{ host: ["api.example.internal"] }], handle: [], terminal: true };
  await mockAdmin([placeholder(), runtime]);
  const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE, hostFile: "# web\nold {\n}\n" });
  const r = await devsite(["init"], {
    caddyfile: m.caddyfile,
    settings: { caddy: { reload: "manual" } },
  });
  expect(r.stdout).toContain(
    "Step 2 of 2: reload Caddy yourself, so it reads the files written above",
  );
  expect(r.stdout).toContain(
    "caddy.reload is manual in your devsite settings, so init does not reload it",
  );
  expect(r.stdout).toContain(
    "drops the route for api.example.internal, added at runtime by another tool",
  );
  expect(r.stdout).toContain(`\n  caddy reload --config ${m.caddyfile} --adapter caddyfile\n`);
  expect(r.ran.filter((c) => c.startsWith("caddy ") && !c.startsWith("caddy adapt "))).toEqual([]);
  expect(readFileSync(join(m.dir, "devsite.d", `${HOST}.caddy`), "utf8")).toContain(
    `${HOST}, web.test.localhost {`,
  );
  expect(r.status).toBe(0);
});

test("a settings file devsite cannot use stops init and doctor, naming the setting", async () => {
  for (const argv of [["init"], ["doctor"]]) {
    const r = await devsite(argv, { settings: { caddy: { user: "admin" } } });
    expect(r.stderr).toContain('caddy.user must be "user" or "root", not "admin"');
    expect(r.status).toBe(1);
  }
  const r = await devsite(["doctor"], { settings: { caddy: { reloads: "manual" } } });
  expect(r.stderr).toContain("unknown setting caddy.reloads");
  expect(r.status).toBe(1);
});

// --- hosts unused for 30+ days ---

test("doctor lists the hosts unused for 30+ days, from their last-used dates", async () => {
  await mockAdmin([placeholder()]);
  const m = setUpMachine();
  writeFileSync(join(m.dir, "devsite.d", "old.test.internal.caddy"), "# old\n");
  writeFileSync(join(m.dir, "devsite.d", "fresh.test.internal.caddy"), "# fresh\n");
  const stateDir = makeStateDir();
  const day = (ago: number) => new Date(Date.now() - ago * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(
    join(stateDir, "last-used.json"),
    JSON.stringify({ "old.test.internal": day(45), "fresh.test.internal": day(2) }),
  );
  const r = await devsite(["doctor"], { caddyfile: m.caddyfile, stateDir });
  expect(r.stdout).toContain(`Hosts unused for 30+ days: old.test.internal (last used ${day(45)})`);
  expect(r.stdout).not.toContain("fresh.test.internal (last used");
});

test(
  "brew services start leaves Caddy down: init stops and names brew services restart",
  async () => {
    const m = setUpMachine({ caddyfile: SET_UP_CADDYFILE });
    const r = await devsite(["init"], { caddyfile: m.caddyfile });
    expect(r.ran).toContain("brew services start caddy");
    expect(r.stderr).toContain("the Caddy service did not start within 5 s. See ");
    expect(r.stderr).toContain(
      "run `brew services restart caddy`, then `bunx devsite init` again.\n",
    );
    expect(r.status).toBe(1);
  },
  { timeout: 10_000 },
);
