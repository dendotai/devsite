import type { Plugin } from "vite";

/**
 * Dev-only Vite plugin: has Vite bind an OS-assigned port (`port: 0`),
 * configures Vite's server/HMR for the `package.json#devSite` host, and
 * registers `https://<host>` → the bound port in the local Caddy via its
 * admin API.
 */
export function devsite(): Plugin;

/**
 * @internal Exported for tests: the warn-message fragments the suite's poll
 * predicates and assertions key on.
 */
export const COULD_NOT_REGISTER: string;
export const COULD_NOT_RECORD: string;

/**
 * @internal Exported for tests. Fetch against the Caddy admin API
 * (`DEVSITE_CADDY_ADMIN`, defaulting to the local admin address) with the
 * Origin header pinned to that base — the pin wins over caller headers in
 * any casing or headers shape.
 */
export function caddy(path: string, init?: RequestInit): Promise<Response>;
