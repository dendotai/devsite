// init's wait for Caddy's admin API after the service restart (#59): `caddy trust` and verify both need it to answer.
import { afterEach, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { waitForCaddyAdmin } from "../src/commands/init";

const saved = process.env.DEVSITE_CADDY_ADMIN;
const servers: Server[] = [];

afterEach(async () => {
  if (saved === undefined) delete process.env.DEVSITE_CADDY_ADMIN;
  else process.env.DEVSITE_CADDY_ADMIN = saved;
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

function listen(port = 0): Promise<number> {
  const server = createServer((_req, res) => res.end("{}"));
  servers.push(server);
  return new Promise((r) =>
    server.listen(port, "127.0.0.1", () => r((server.address() as AddressInfo).port)),
  );
}

async function freePort(): Promise<number> {
  const port = await listen();
  await new Promise((r) => servers.pop()?.close(r));
  return port;
}

test("an admin API that already answers passes at once", async () => {
  process.env.DEVSITE_CADDY_ADMIN = `http://127.0.0.1:${await listen()}`;
  expect(await waitForCaddyAdmin(1000)).toBe(true);
});

test("no listener: the wait gives up after the timeout", async () => {
  process.env.DEVSITE_CADDY_ADMIN = `http://127.0.0.1:${await freePort()}`;
  const start = Date.now();
  expect(await waitForCaddyAdmin(600)).toBe(false);
  expect(Date.now() - start).toBeGreaterThanOrEqual(600);
});

test("an admin API that starts late, inside the timeout, passes", async () => {
  const port = await freePort();
  process.env.DEVSITE_CADDY_ADMIN = `http://127.0.0.1:${port}`;
  setTimeout(() => void listen(port), 300);
  expect(await waitForCaddyAdmin(2000)).toBe(true);
});
