import type { Plugin } from "vite";

/**
 * Dev-only Vite plugin: has Vite bind an OS-assigned port (`port: 0`), configures Vite's server/HMR for the `package.json#devSite` name, and tells the devsite node the project's name, port and folder, so the project opens at `https://<name>.internal` and `https://<name>.localhost`.
 */
export function devsite(): Plugin;
