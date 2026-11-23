/**
 * devsite ca export — prints this Mac's CA root certificate and key, for the user to pipe into a secret store; writes no file.
 */
import { readCaRoot } from "../ca";
import { type CliContext, processContext } from "../context";
import { findCaddy, unknownFix } from "../install";
import { readSettings } from "../settings";
import { findStorage, rootKeyIn } from "../storage";
import { refuseRoot } from "./init";

export async function caExport(ctx: CliContext = processContext()): Promise<number> {
  if (refuseRoot("ca export", ctx)) return 1;
  const read = readSettings(ctx);
  if (!read.ok) {
    ctx.stderr.write(`${read.error}\n`);
    return 1;
  }
  const install = findCaddy(read.settings, ctx);
  if (install.kind === "unknown") {
    ctx.stderr.write(
      `This Mac's Caddy is an install devsite does not know: ${install.why}.\nTo use it anyway, ${unknownFix(ctx)}.\n`,
    );
    return 1;
  }
  const storage = await findStorage(install, ctx);
  if (storage.root === null) {
    ctx.stderr.write(`devsite cannot read Caddy's storage (${storage.source}).\n`);
    return 1;
  }
  const root = readCaRoot(storage.root);
  if (root === null) {
    ctx.stderr.write(
      `Caddy's storage holds no CA root: ${rootKeyIn(storage.root)} is missing. Caddy makes one at its first start, or \`devsite init --ca -\` imports one.\n`,
    );
    return 1;
  }
  ctx.stdout.write(`${root.certPem.trimEnd()}\n${root.keyPem.trimEnd()}\n`);
  return 0;
}
