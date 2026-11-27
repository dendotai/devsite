// devsite's root dnsmasq watcher (#75): the script runs under zsh with a fake scutil that plays a scripted notification sequence, a fake ifconfig that shows the Mac's addresses at that moment, and a fake dnsmasq that logs each start and stop. Each test reads that log and the watcher's exit code.
import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderWatcher } from "../src/dnsmasq";

const SETTLE = 0.15;
const TAILNET = "\tinet 100.90.1.2 --> 100.90.1.2 netmask 0xffffffff";
const LAN = "\tinet 192.168.1.5 netmask 0xffffff00 broadcast 192.168.1.255";
// In 100.0.0.0/8 but outside Tailscale's 100.64.0.0/10.
const OTHER_100 = "\tinet 100.20.1.2 netmask 0xffffff00";

// up / down / other: the Mac's addresses from then on; event: scutil prints a notification; a number: a pause in seconds; settled: scutil waits until the watcher has looked at the addresses after the burst. The watcher looks once per settled burst, so a test waits on that look, not on a time a loaded machine can miss.
type Step = "up" | "down" | "other" | "event" | "settled" | number;

// Before the steps, scutil waits for the watcher's first look. After them it logs "end" and exits, as a lost scutil would; FAKE_HOLD keeps it up, as the real one stays, until the watcher stops it.
const FAKE_SCUTIL = `#!/bin/zsh -f
looked() { local n=$1; while (( $(wc -l < $FAKE_LOOKS) < n )); do sleep 0.01; done; sleep 0.1 }
looks=1
looked $looks
for step in "\${(@f)$(<$FAKE_STEPS)}"; do
  case $step in
    up) print -r -- $'${TAILNET}' > $FAKE_ADDRESSES ;;
    down) print -r -- $'${LAN}' > $FAKE_ADDRESSES ;;
    other) print -r -- $'${OTHER_100}' > $FAKE_ADDRESSES ;;
    event) print '  changed key [0] = State:/Network/Interface/utun4/IPv4' ;;
    settled) looked $(( ++looks )) ;;
    *) sleep $step ;;
  esac
done
print end >> $FAKE_LOG
[[ -n $FAKE_HOLD ]] && exec sleep 30
`;

const FAKE_IFCONFIG = `#!/bin/zsh -f
print >> $FAKE_LOOKS
print -r -- $'\\tinet 127.0.0.1 netmask 0xff000000'
cat $FAKE_ADDRESSES
`;

// FAKE_EXITS: dnsmasq stops at once, as it does when its config names an absent listen address.
const FAKE_DNSMASQ = `#!/bin/zsh -f
print "start $*" >> $FAKE_LOG
[[ -n $FAKE_EXITS ]] && { print exited >> $FAKE_LOG; exit 2 }
trap 'print stop >> $FAKE_LOG; kill $!; exit 0' TERM
# zsh runs the trap at once while it waits on a builtin wait, not on a foreground sleep.
sleep 30 & wait $!
`;

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

// One set of scripts for every test, each run once here: macOS checks a script on its first run, which can take longer than a settle time.
const SCRIPTS = mkdtempSync(join(tmpdir(), "devsite-watcher-"));
const BIN = join(SCRIPTS, "bin");
mkdirSync(BIN);
script(BIN, "scutil", FAKE_SCUTIL);
script(BIN, "ifconfig", FAKE_IFCONFIG);
const DNSMASQ = script(SCRIPTS, "dnsmasq", FAKE_DNSMASQ);
const WATCHER = script(SCRIPTS, "dnsmasq-watcher.zsh", renderWatcher());
const warmUp = {
  FAKE_LOG: "/dev/null",
  FAKE_LOOKS: "/dev/null",
  FAKE_ADDRESSES: "/dev/null",
  FAKE_EXITS: "1",
};
for (const fake of [join(BIN, "ifconfig"), DNSMASQ]) Bun.spawnSync([fake], { env: warmUp });

// Runs the watcher until it exits and returns the log: the fake dnsmasq's starts and stops, and "end" where the fake scutil played its last step. term: SIGTERM goes to the watcher after "end", as launchd sends on bootout.
async function watch(
  start: "up" | "down",
  steps: Step[],
  opts: { exits?: boolean; term?: boolean } = {},
): Promise<string[]> {
  const dir = mkdtempSync(join(tmpdir(), "devsite-watcher-"));
  const log = join(dir, "log");
  const looks = join(dir, "looks");
  const addresses = join(dir, "addresses");
  const stepsFile = join(dir, "steps");
  writeFileSync(log, "");
  writeFileSync(looks, "");
  writeFileSync(addresses, `${start === "up" ? TAILNET : LAN}\n`);
  writeFileSync(stepsFile, steps.map((s) => `${s}\n`).join(""));
  const child = spawn("/bin/zsh", ["-f", WATCHER, DNSMASQ, "/conf"], {
    // Its own process group, so a run that hangs is killed with the fake dnsmasq under it.
    detached: true,
    env: {
      PATH: `${BIN}:/usr/bin:/bin`,
      DEVSITE_WATCHER_SETTLE: String(SETTLE),
      FAKE_LOG: log,
      FAKE_LOOKS: looks,
      FAKE_ADDRESSES: addresses,
      FAKE_STEPS: stepsFile,
      ...(opts.term ? { FAKE_HOLD: "1" } : {}),
      ...(opts.exits ? { FAKE_EXITS: "1" } : {}),
    },
    stdio: "ignore",
  });
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  if (opts.term) {
    while (!readFileSync(log, "utf8").includes("end")) await Bun.sleep(20);
    child.kill("SIGTERM");
  }
  const code = await Promise.race([exited, Bun.sleep(10_000).then(() => "timeout" as const)]);
  if (code === "timeout" && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  // SIGTERM exits 0; scutil ending exits 1, so launchd starts the watcher again.
  expect(code).toBe(opts.term ? 0 : 1);
  return readFileSync(log, "utf8").trim().split("\n");
}

const START = "start --keep-in-foreground --conf-file=/conf";

test.concurrent("Tailscale up when the watcher starts: it starts dnsmasq with no notification; scutil ending stops dnsmasq", async () => {
  expect(await watch("up", [])).toEqual([START, "end", "stop"]);
});

test.concurrent("Tailscale down when the watcher starts: dnsmasq does not start", async () => {
  expect(await watch("down", [])).toEqual(["end"]);
});

test.concurrent("Tailscale comes up with a burst of notifications: one start after the burst settles", async () => {
  const log = await watch("down", [
    "up",
    "event",
    0.02,
    "event",
    0.02,
    "event",
    "event",
    "settled",
  ]);
  expect(log).toEqual([START, "end", "stop"]);
});

test.concurrent("Tailscale goes down with a burst: one stop", async () => {
  const log = await watch("up", ["down", "event", 0.02, "event", "event", "settled"]);
  expect(log).toEqual([START, "stop", "end"]);
});

test.concurrent("down, then up, each a settled change: one stop, then one start", async () => {
  const log = await watch("up", [
    "down",
    "event",
    "event",
    "settled",
    "up",
    "event",
    0.02,
    "event",
    "settled",
  ]);
  expect(log).toEqual([START, "stop", START, "end", "stop"]);
});

test.concurrent("Tailscale drops and returns inside one burst: the settled state is unchanged, so nothing runs", async () => {
  const log = await watch("up", ["down", "event", 0.02, "up", "event", "event", "settled"]);
  expect(log).toEqual([START, "end", "stop"]);
});

test.concurrent("notifications with no change to the Tailscale IP: nothing runs", async () => {
  const log = await watch("up", ["event", "settled", "event", "event", "settled"]);
  expect(log).toEqual([START, "end", "stop"]);
});

test.concurrent("an address in 100.0.0.0/8 outside Tailscale's 100.64.0.0/10: dnsmasq does not start", async () => {
  expect(await watch("down", ["other", "event", "event", "settled"])).toEqual(["end"]);
});

test.concurrent("dnsmasq exits on its own: the watcher waits for the next settled change, then starts it again", async () => {
  const log = await watch("up", ["event", "event", "settled"], { exits: true });
  expect(log).toEqual([START, "exited", START, "exited", "end"]);
});

test.concurrent("SIGTERM, as launchd sends on bootout: the watcher stops dnsmasq and exits 0", async () => {
  expect(await watch("up", [], { term: true })).toEqual([START, "end", "stop"]);
});
