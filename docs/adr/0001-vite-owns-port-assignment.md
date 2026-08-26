# ADR 0001 — Vite owns port assignment; the plugin never picks a port

## Status

Accepted (2026-08-23).

## Context

The dev server needs a fresh ephemeral port per run so any number of projects
can run at once. The plugin originally picked the port itself: a `freePort()`
helper bound a throwaway socket to port 0, read the OS-assigned number, closed
the socket, and passed the number to Vite with `strictPort: true`.

Between that close and Vite's own bind — a window spanning all of Vite's
config resolution and plugin setup — the port belonged to nobody. Any other
process could take it (including a second dev server doing the same dance),
and `strictPort: true` then killed the server with "Port N is already in use",
with no retry (issue #11).

## Decision

The plugin sets `server: { port: 0 }` and lets Vite bind the port. The OS
assigns the number at the moment of binding, so no pre-picked number exists to
race over. The plugin reads the real port in the `listening` callback
(`server.httpServer.address().port`) and registers it with Caddy there.
`strictPort` is gone — it has no meaning without a pre-picked port.

## Consequences

- The startup-window race is gone. A residual millisecond gap remains inside
  Vite (it probes with a throwaway socket, then binds); a collision there
  makes Vite exit with a hard error. Accepted: the window shrank by orders of
  magnitude and a restart recovers.
- The port number does not exist until the server is bound. Anything that
  needs it must read it at listen time, as this plugin does. Other Vite
  plugins or tools that read `server.port` from the resolved config see `0` —
  none exist in our projects today, but this is the constraint to check before
  adding one.
- Vite `^8.0.0` stays the peer range. Vite 8.2.1+ has an explicit `port: 0`
  code path; 8.0.0–8.2.0 reach the same behavior through the generic port
  loop, which passes the 0 to the OS. Both were verified against the shipped
  sources; printed URLs read the port from the bound server on both paths.
