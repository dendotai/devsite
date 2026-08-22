import type { Plugin } from "vite";

/**
 * Dev-only Vite plugin: picks a free port, configures Vite's server/HMR for
 * the `package.json#devSite` host, and registers `https://<host>` → that port
 * in the local Caddy via its admin API.
 */
export function devsite(): Plugin;
