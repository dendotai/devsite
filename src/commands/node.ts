/**
 * devsite node — runs the node until launchd stops it (ADR 0005). Its first line on stdout names the port it listens on, so a test that asks for port 0 learns the port the OS gave. DEVSITE_PEER_PORT gives two test nodes on one Mac their shared port for each other.
 */
import { NODE_PORT } from "../client.mjs";
import type { CliContext } from "../context";
import { startNode } from "../node/server";

const isPort = (n: number) => Number.isInteger(n) && n >= 0 && n <= 65535;

export async function runNode({ port }: { port?: string }, ctx: CliContext): Promise<number> {
  const wanted = port === undefined ? NODE_PORT : Number(port);
  if (!isPort(wanted)) {
    ctx.stderr.write(`--port must be a port number, not ${JSON.stringify(port)}\n`);
    return 1;
  }
  const peerPort = ctx.env.DEVSITE_PEER_PORT;
  const peersAt = peerPort === undefined ? undefined : Number(peerPort);
  if (peersAt !== undefined && (!isPort(peersAt) || peersAt === 0)) {
    ctx.stderr.write(`DEVSITE_PEER_PORT must be a port number, not ${JSON.stringify(peerPort)}\n`);
    return 1;
  }
  let node: Awaited<ReturnType<typeof startNode>>;
  try {
    node = await startNode({ port: wanted, peerPort: peersAt, env: ctx.env });
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    ctx.stderr.write(
      e.code === "EADDRINUSE"
        ? `devsite node: another process listens on 127.0.0.1:${wanted}; \`lsof -i :${wanted}\` names it\n`
        : `devsite node: ${e.message}\n`,
    );
    return 1;
  }
  ctx.stdout.write(`devsite node: listening on 127.0.0.1:${node.port}\n`);
  await new Promise<void>((resolve) => {
    process.once("SIGTERM", resolve);
    process.once("SIGINT", resolve);
  });
  await node.close();
  return 0;
}
