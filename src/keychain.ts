// The Tailscale OAuth client secret (`dns` scope) that lets the node write the split DNS route (#110). The working copy is a generic password in the login Keychain, where the node reads it with no one present; the user keeps a copy in their secret store.
import { execFile } from "node:child_process";
import type { CliContext } from "./context";
import { exec } from "./io";

export const KEYCHAIN_SERVICE = "devsite";
export const KEYCHAIN_ACCOUNT = "tailscale-oauth-client-secret";
const KEYCHAIN_LABEL = "devsite: Tailscale OAuth client secret (dns scope) for the split DNS route";

// Tailscale prints an OAuth client secret as `tskey-client-<client ID>-<secret>`.
export const SECRET_RE = /^tskey-client-[A-Za-z0-9]+-[A-Za-z0-9]+$/;

const SECURITY = "security";

// `security` with no -w prints the item's attributes and never the password, so this check keeps the secret out of the output.
export function hasSecret(ctx: CliContext): boolean {
  const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT];
  return exec(SECURITY, args, ctx, true).status === 0;
}

// `security -i` reads its command from stdin, so the secret never shows in the process list as an argument would. The item gets `security` as its trusted app, so the node's read through `security` asks nothing.
export function storeSecret(secret: string, ctx: CliContext): boolean {
  const line = [
    "add-generic-password",
    "-U",
    "-s",
    KEYCHAIN_SERVICE,
    "-a",
    KEYCHAIN_ACCOUNT,
    "-l",
    `"${KEYCHAIN_LABEL}"`,
    "-w",
    secret,
  ].join(" ");
  const r = ctx.runCommand(SECURITY, ["-i"], { capture: true, input: `${line}\n` });
  return r.status === 0 && !r.error && hasSecret(ctx);
}

// DEVSITE_SECURITY names a stand-in for `security` in tests. null when the Keychain holds no secret or is locked.
export function readSecret(env: { DEVSITE_SECURITY?: string }): Promise<string | null> {
  const args = ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"];
  return new Promise((resolve) => {
    execFile(env.DEVSITE_SECURITY || SECURITY, args, { timeout: 3000 }, (err, stdout) => {
      const secret = stdout.trim();
      resolve(err || secret === "" ? null : secret);
    });
  });
}
