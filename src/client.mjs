// How a client (the command-line tool, the Vite plugin) reaches the node on this Mac.
//
// Plain .mjs for the same reason as vite.mjs, which imports it: Vite's config loader hands bare imports to the Node runtime, which won't execute TypeScript from node_modules.

// Caddy's one route proxies to this port, so it is fixed: the OS never assigns a port below 49152 on macOS.
export const NODE_PORT = 47380;

// DEVSITE_NODE points the clients at a test node; read per call, so the override needs no import-order care.
export function nodeUrl() {
  return process.env.DEVSITE_NODE ?? `http://127.0.0.1:${NODE_PORT}`;
}

/**
 * @param {string} path
 * @param {RequestInit} [init]
 */
export function callNode(path, init = {}) {
  return fetch(`${nodeUrl()}${path}`, init);
}
