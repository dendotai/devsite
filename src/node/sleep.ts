// Hears macOS sleep and wake (#110), so the main Mac's node tells the other nodes before this Mac stops answering. `osascript` is on every Mac and the node's one installed file can start it; a native module could not be loaded from there.
import { type ChildProcess, spawn } from "node:child_process";

export type SleepEnv = { DEVSITE_SLEEP_LISTENER?: string };

// macOS holds the sleep while the observer runs, for up to 30 s, so it waits for the node's line; a node that is gone closes the pipe, which ends the wait too. A node killed with no chance to stop this process leaves it a new parent, pid 1.
const SCRIPT = `
ObjC.import("AppKit");
ObjC.import("unistd");
const out = $.NSFileHandle.fileHandleWithStandardOutput;
const say = (s) => out.writeData($(s + "\\n").dataUsingEncoding($.NSUTF8StringEncoding));
ObjC.registerSubclass({
  name: "DevsiteSleepListener",
  methods: {
    "willSleep:": { types: ["void", ["id"]], implementation: () => {
      say("sleep");
      $.NSFileHandle.fileHandleWithStandardInput.availableData;
    } },
    "didWake:": { types: ["void", ["id"]], implementation: () => say("wake") },
  },
});
function run() {
  const o = $.DevsiteSleepListener.alloc.init;
  const c = $.NSWorkspace.sharedWorkspace.notificationCenter;
  c.addObserverSelectorNameObject(o, "willSleep:", "NSWorkspaceWillSleepNotification", $());
  c.addObserverSelectorNameObject(o, "didWake:", "NSWorkspaceDidWakeNotification", $());
  while ($.getppid() !== 1) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(5));
  }
}
`;

const RESTART_MS = 10_000;

// sleep resolves once the other nodes are told; the Mac's sleep waits for it. DEVSITE_SLEEP_LISTENER names a stand-in for the listener in tests. Off macOS, nothing listens.
export function listenForSleep(
  env: SleepEnv,
  on: { sleep: () => Promise<void>; wake: () => void },
): { close: () => void } {
  let child: ChildProcess | null = null;
  let closed = false;
  let restart: ReturnType<typeof setTimeout> | undefined;

  const start = () => {
    const c = env.DEVSITE_SLEEP_LISTENER
      ? spawn(env.DEVSITE_SLEEP_LISTENER, [], { stdio: ["pipe", "pipe", "ignore"] })
      : spawn("osascript", ["-l", "JavaScript", "-e", SCRIPT], {
          stdio: ["pipe", "pipe", "ignore"],
        });
    child = c;
    let buf = "";
    c.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      const lines = (buf + chunk).split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (line === "sleep") on.sleep().finally(() => c.stdin?.write("ok\n"));
        if (line === "wake") on.wake();
      }
    });
    // A write to a listener that just ended.
    c.stdin?.on("error", () => {});
    const ended = () => {
      if (closed || child !== c) return;
      child = null;
      console.error("devsite node: the sleep listener ended; it starts again in 10 s");
      restart = setTimeout(start, RESTART_MS);
    };
    c.on("error", ended);
    c.on("exit", ended);
  };

  if (env.DEVSITE_SLEEP_LISTENER || process.platform === "darwin") start();
  return {
    close: () => {
      closed = true;
      clearTimeout(restart);
      child?.kill();
    },
  };
}
