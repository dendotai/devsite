// Where devsite keeps its files on this Mac (ADR 0005): settings, state, and the node's program in Application Support, logs in ~/Library/Logs, the node's LaunchAgent in ~/Library/LaunchAgents.
import { homedir } from "node:os";
import { join } from "node:path";

// DEVSITE_USER_HOME points every path at a scratch home in tests.
export type PathsEnv = { DEVSITE_USER_HOME?: string };

const home = (env: PathsEnv) => env.DEVSITE_USER_HOME || homedir();

export const supportDir = (env: PathsEnv) =>
  join(home(env), "Library", "Application Support", "devsite");
export const settingsFile = (env: PathsEnv) => join(supportDir(env), "config.json");
export const stateFile = (env: PathsEnv) => join(supportDir(env), "state.json");
export const nodeProgramDir = (env: PathsEnv) => join(supportDir(env), "node");
export const nodeLog = (env: PathsEnv) => join(home(env), "Library", "Logs", "devsite", "node.log");
export const launchAgentsDir = (env: PathsEnv) => join(home(env), "Library", "LaunchAgents");
