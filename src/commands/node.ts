/**
 * devsite node — runs the node until launchd stops it (ADR 0005). Its first line on stdout names the port it listens on, so a test that asks for port 0 learns the port the OS gave.
 */
import { NODE_PORT } from "../client.mjs";
import type { CliContext } from "../context";
import { startNode } from "../node/server";

export async function runNode({ port }: { port?: string }, ctx: CliContext): Promise<number> {
  const wanted = port === undefined ? NODE_PORT : Number(port);
  if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535) {
    ctx.stderr.write(`--port must be a port number, not ${JSON.stringify(port)}\n`);
    return 1;
  }
  const node = await startNode({ port: wanted, env: ctx.env });
  ctx.stdout.write(`devsite node: listening on 127.0.0.1:${node.port}\n`);
  // launchd stops the node with SIGTERM.
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await node.close();
  return 0;
}
