// Caddy's admin API on this Mac, which init and doctor read.

// DEVSITE_CADDY_ADMIN overrides the admin endpoint so tests can point at a local mock; read per call, so the override needs no import-order care.
export function adminBase(): string {
  return process.env.DEVSITE_CADDY_ADMIN ?? "http://localhost:2019";
}

// Node's fetch (undici) sends no Origin header, and Caddy's admin API then sees an empty origin and answers 403; the pinned header passes its origin check.
export function caddy(path: string, init: RequestInit = {}): Promise<Response> {
  const admin = adminBase();
  const headers = new Headers(init.headers);
  headers.set("origin", admin);
  return fetch(`${admin}${path}`, { ...init, headers });
}
