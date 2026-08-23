import type { Plugin } from "vite";

/**
 * Dev-only Vite plugin: has Vite bind an OS-assigned port (`port: 0`),
 * configures Vite's server/HMR for the `package.json#devSite` host, and
 * registers `https://<host>` → the bound port in the local Caddy via its
 * admin API.
 */
export function devsite(): Plugin;
