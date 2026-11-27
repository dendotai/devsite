// `devsite ca export` and `devsite init --ca -`: one CA root for every Mac, moved through a pipe. run() over a scratch Caddy storage, the test CAs, a scripted runner, a mock of Caddy's admin API, and a real node.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { processRunner } from "../src/context";
import { type CommandCall, cli, fakeStdin, MISSING, makeRepo, scriptedRunner } from "./helpers";
import {
  type Machine,
  mockAdmin,
  nodeRoute,
  pki,
  setUpMachine,
  snapshot,
  USER_CADDYFILE,
  useMachine,
  useNodeWith,
} from "./machine";

useMachine();

const local = (m: Machine) => join(m.storage, "pki", "authorities", "local");

// The storage as Caddy leaves it after it served a name: the root with its key, an intermediate, and a certificate it signed.
function caddyHasServed(m: Machine) {
  writeFileSync(join(local(m), "root.key"), pki.rootKey);
  writeFileSync(join(local(m), "intermediate.crt"), "old intermediate");
  writeFileSync(join(local(m), "intermediate.key"), "old intermediate key");
  const leaf = join(m.storage, "certificates", "local", "web.internal");
  mkdirSync(leaf, { recursive: true });
  writeFileSync(join(leaf, "web.internal.crt"), "old leaf");
}

// Caddy serves a chain from the root in its storage, as it does after the restart an import runs.
function servedNow(m: Machine): string {
  const crt = join(local(m), "root.crt");
  return existsSync(crt) && readFileSync(crt, "utf8") === pki.otherRoot
    ? pki.otherServed
    : pki.served;
}

// caddy: a Caddy process ps shows that `brew services` did not start (user, and ppid 1 for launchd).
type Answers = {
  served?: string;
  trusted?: boolean;
  brewServices?: boolean;
  caddy?: { user: string };
};

// brewServices: Caddy runs from the scratch prefix under `brew services`; otherwise no Caddy process shows in ps.
function runner(m: Machine, a: Answers = {}) {
  // `caddy trust` makes an untrusted root trusted, as on a real Mac.
  let trustRan = false;
  return scriptedRunner((c: CommandCall) => {
    if ([c.cmd, ...c.args].join(" ").includes("caddy trust")) trustRan = true;
    if (c.cmd === "diff") return processRunner(c.cmd, c.args, { capture: c.capture });
    if (c.cmd === "ps" && c.args[0] === "-axo" && (a.brewServices || a.caddy)) {
      return {
        stdout: `  1     0 root  /sbin/launchd\n  774  1 ${a.caddy?.user ?? "me"}  ${m.prefix}/opt/caddy/bin/caddy run --config ${m.caddyfile} --adapter caddyfile\n`,
      };
    }
    if (c.cmd === "brew" && c.args[1] === "info") {
      return { stdout: JSON.stringify([{ name: "caddy", pid: a.brewServices ? 774 : null }]) };
    }
    if (c.cmd === "openssl" && c.args[0] === "s_client")
      return { stdout: a.served ?? servedNow(m) };
    if (c.cmd === "security") return { status: a.trusted === false && !trustRan ? 1 : 0 };
    if (/(?:^|\/)tailscale$/i.test(c.cmd)) return MISSING;
    if (c.cmd === "caddy" && c.args[0] === "adapt") {
      return processRunner(c.cmd, c.args, { capture: c.capture });
    }
    return {};
  });
}

async function devsite(
  argv: string[],
  m: Machine,
  opts: { stdin?: string; terminal?: string | null; answers?: Answers; node?: false } = {},
) {
  const cwd = makeRepo();
  if (opts.node !== false) await useNodeWith({ web: { folder: join(cwd, "apps", "web") } });
  const { runCommand, calls } = runner(m, opts.answers);
  const r = await cli(argv, {
    cwd,
    caddyfile: m.caddyfile,
    runCommand,
    stdin: fakeStdin(opts.stdin ?? "", false),
    // init asks on the terminal; the other commands ask nothing.
    terminal:
      opts.terminal === null || argv[0] !== "init" ? null : fakeStdin(opts.terminal ?? "y", true),
  });
  const acted = calls
    .map((c) => [c.cmd, ...c.args].join(" "))
    .filter((c) => /^(brew services|caddy (trust|reload)|sudo)/.test(c));
  return { ...r, acted };
}

const importText = () => `${pki.otherRoot}${pki.otherKey}`;

// --- ca export ---

test("ca export prints the CA root certificate and key, and writes no file", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  writeFileSync(join(local(m), "root.key"), pki.rootKey);
  const before = snapshot(m.dir);
  const home = snapshot(m.home);
  const r = await devsite(["ca", "export"], m, { node: false });
  expect(r.stdout).toBe(`${pki.root.trimEnd()}\n${pki.rootKey.trimEnd()}\n`);
  expect(snapshot(m.dir)).toEqual(before);
  expect(snapshot(m.home)).toEqual(home);
  expect(r.status).toBe(0);
});

test("ca export with no CA root in Caddy's storage: exit 1, nothing on stdout", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE, root: null });
  const r = await devsite(["ca", "export"], m);
  expect(r.stdout).toBe("");
  expect(r.stderr).toContain(`Caddy's storage holds no CA root: ${join(local(m), "root.key")}`);
  expect(r.status).toBe(1);
});

// --- init --ca - ---

test("init --ca - on a Mac with no CA root: puts the root into Caddy's storage", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE, root: null });
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: importText(),
    answers: { brewServices: true },
  });
  expect(r.stdout).toContain("put the imported CA root into Caddy's storage");
  expect(readFileSync(join(local(m), "root.crt"), "utf8")).toBe(pki.otherRoot);
  expect(readFileSync(join(local(m), "root.key"), "utf8")).toBe(pki.otherKey);
  expect(r.status).toBe(0);
});

test("init --ca - over a different root: names what it replaces, asks, and n changes nothing", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  caddyHasServed(m);
  const before = snapshot(m.dir);
  const r = await devsite(["init", "--ca", "-"], m, { stdin: importText(), terminal: "n" });
  expect(r.stdout).toContain("replace Caddy's CA root");
  expect(r.stdout).toContain("replaces Test Root (SHA-256 ");
  expect(r.stdout).toContain(") with Other Root (SHA-256 ");
  expect(r.stdout).toContain(
    "deletes the intermediate and the certificates the old root signed; Caddy signs new ones",
  );
  expect(r.stdout).toContain("Apply these changes? [Y/n]");
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(1);
});

test("init --ca - over a different root, y: replaces it, deletes what the old root signed, and restarts Caddy", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  caddyHasServed(m);
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: importText(),
    answers: { brewServices: true },
  });
  expect(readFileSync(join(local(m), "root.crt"), "utf8")).toBe(pki.otherRoot);
  expect(readFileSync(join(local(m), "root.key"), "utf8")).toBe(pki.otherKey);
  expect(existsSync(join(local(m), "intermediate.crt"))).toBe(false);
  expect(existsSync(join(local(m), "intermediate.key"))).toBe(false);
  expect(existsSync(join(m.storage, "certificates", "local"))).toBe(false);
  expect(r.acted).toContain("brew services restart caddy");
  expect(r.status).toBe(0);
});

test("init --ca - with an untrusted imported root: trusts it after Caddy restarts", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  caddyHasServed(m);
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: importText(),
    answers: { brewServices: true, trusted: false },
  });
  const restart = r.acted.indexOf("brew services restart caddy");
  const trust = r.acted.findIndex((c) => c.includes("caddy trust"));
  expect(restart).toBeGreaterThanOrEqual(0);
  expect(trust).toBeGreaterThan(restart);
  expect(r.status).toBe(0);
});

test("init --ca - with the root the storage already holds: no CA step", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  writeFileSync(join(local(m), "root.key"), pki.rootKey);
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: `${pki.root}${pki.rootKey}`,
    terminal: null,
  });
  expect(r.stdout).not.toContain("CA root into");
  expect(r.stdout).not.toContain("replace Caddy's CA root");
  expect(r.stdout).toContain("Nothing to do");
  expect(r.status).toBe(0);
});

test("init --ca - with a key that is not the certificate's: exit 1, nothing changed", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  const before = snapshot(m.dir);
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: `${pki.otherRoot}${pki.rootKey}`,
    terminal: null,
  });
  expect(r.stderr).toContain("the private key on standard input is not the certificate's key");
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(1);
});

test("init --ca - with no key on standard input: exit 1, nothing changed", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  const before = snapshot(m.dir);
  const r = await devsite(["init", "--ca", "-"], m, { stdin: pki.otherRoot, terminal: null });
  expect(r.stderr).toContain(
    "standard input needs one CERTIFICATE and one PRIVATE KEY block, as `devsite ca export` prints them",
  );
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(1);
});

test("init --ca with a value other than -: exit 1", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  const r = await devsite(["init", "--ca", "root.pem"], m, { terminal: null });
  expect(r.stderr).toContain("--ca takes only -, which reads the CA root from standard input");
  expect(r.status).toBe(1);
});

test("after an import, doctor's certificate checks pass against the imported root", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  caddyHasServed(m);
  await devsite(["init", "--ca", "-"], m, {
    stdin: importText(),
    answers: { brewServices: true },
  });
  const r = await devsite(["doctor"], m);
  expect(r.stdout).toContain("✓ the served certificate chains to the CA in Caddy's storage");
  expect(r.stdout).toContain("✓ that CA is trusted in the keychain");
});

test("init --ca - with no terminal to ask on: refuses the replace, nothing changed", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  caddyHasServed(m);
  const before = snapshot(m.dir);
  const r = await devsite(["init", "--ca", "-"], m, { stdin: importText(), terminal: null });
  expect(r.stderr).toContain(
    "no terminal to ask on — cannot ask for confirmation; nothing changed.",
  );
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(1);
});

test("init --ca - --dry-run: prints the replace and changes nothing", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  caddyHasServed(m);
  const before = snapshot(m.dir);
  const r = await devsite(["init", "--ca", "-", "--dry-run"], m, {
    stdin: importText(),
    terminal: null,
  });
  expect(r.stdout).toContain("replace Caddy's CA root");
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(0);
});

test("init --ca - with a keyboard on stdin: says to pipe the root in, and waits for nothing", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  const { runCommand } = runner(m);
  const r = await cli(["init", "--ca", "-"], {
    cwd: makeRepo(),
    caddyfile: m.caddyfile,
    runCommand,
    stdin: fakeStdin("", true),
  });
  expect(r.stderr).toContain("--ca - reads the CA root from standard input: pipe it in");
  expect(r.status).toBe(1);
});

test("init --ca - again after a restart that failed: the root is in place, so it only restarts Caddy", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE, root: pki.otherRoot });
  writeFileSync(join(local(m), "root.key"), pki.otherKey);
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: importText(),
    answers: { brewServices: true, served: pki.served },
  });
  expect(r.stdout).not.toContain("replace Caddy's CA root");
  expect(r.stdout).toContain("restart Caddy, so it serves certificates from the imported root");
  expect(r.acted).toContain("brew services restart caddy");
});

test("init --ca - into a Caddy that runs as root: refused, nothing changed", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  const before = snapshot(m.dir);
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: importText(),
    answers: { caddy: { user: "root" } },
  });
  expect(r.stderr).toContain(
    "init --ca imports only into a Caddy that runs as you; this one runs as root; nothing changed.",
  );
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(1);
});

test("init --ca - into a running Caddy that brew services did not start: refused, nothing changed", async () => {
  await mockAdmin([nodeRoute()]);
  const m = setUpMachine({ caddyfile: USER_CADDYFILE });
  const before = snapshot(m.dir);
  const r = await devsite(["init", "--ca", "-"], m, {
    stdin: importText(),
    answers: { caddy: { user: "me" } },
  });
  expect(r.stderr).toContain(
    "Caddy runs under launchd, which init cannot restart: stop Caddy, run init --ca - again, then start Caddy; nothing changed.",
  );
  expect(snapshot(m.dir)).toEqual(before);
  expect(r.status).toBe(1);
});
