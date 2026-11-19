# ADR 0002 — Caddy runs as the user, and every devsite route starts with a LAN guard

## Status

Accepted (2026-11-19).

## Context

Caddy listened on `:443` and `:80` on every network interface. On a shared network (a café's Wi-Fi), anyone who could reach the machine could get a running dev app with `curl -k --resolve myapp.internal:443:<LAN IP> https://myapp.internal/`: Caddy routes by the `Host` header, so no DNS is needed (issue #58).

Caddy's `default_bind` would keep it off the LAN, but macOS lets a non-root process listen on a port below 1024 only on all addresses. A user-run Caddy with `default_bind 127.0.0.1 <tailnet IP>` fails to start with `bind: permission denied`. So `default_bind` on `:443` needs a root service, and a root service costs:

- a password on every `init`, for the restart;
- Homebrew's Caddy paths owned by `root:admin`, so `brew upgrade` and `brew cleanup` need `sudo rm` by hand;
- root-owned files in the user's pinned storage; a renewed `intermediate.crt` broke `init`'s verify step ("could not compare");
- an admin API on `localhost:2019`, with no authentication, that runs as root.

Boot start, the one thing root adds, serves nothing: the dev servers Caddy proxies to run only after the user logs in.

## Decision

- By default, Caddy runs as the user who runs `devsite init`, through `brew services` without `sudo`, started at login. `init` refuses to run as root.
- A root Caddy the user chooses stays: `init` reloads it with `sudo`. Running as the user is a preference, and devsite works under root, so it sets the default and prohibits nothing (ADR 0004).
- Caddy listens on all addresses. Every route devsite renders starts with a guard: a request whose source is not `127.0.0.1`, `::1`, or the tailnet range `100.64.0.0/10` is aborted with no HTTP response (Caddy's `remote_ip` matcher, then `abort`). A LAN host cannot fake these sources: macOS drops an external packet with a loopback source, and replies to a `100.x` source leave through Tailscale.
- The guard has one definition (`src/guard.mjs`), used by both places a route comes from: the placeholder `init` writes into `devsite.d/`, and the route the Vite plugin swaps in through the admin API. The plugin's `PATCH` replaces the whole route, so a guard only in the placeholder would vanish while `bun dev` runs.
- The move from a root service runs only for a root service an earlier devsite set up. It stops the root daemon, stops any other root Caddy, and gives root-owned paths back to the user (the storage root, `devsite.d`, the Caddyfile and its copies, Homebrew's Caddy paths). A `default_bind` line in the Caddyfile's global options block is deleted, and `init` prints the line it deleted; this is the one exception to never rewriting a global block the user edited.

## Consequences

- A run on macOS, from a second Mac on the same Wi-Fi, got no HTTP response from the LAN IP (HTTP/2 and HTTP/1.1), and `200` from the tailnet IP and from loopback on the machine itself (issue #58).
- A LAN host can still connect to `:443` and finish a TLS handshake before the abort. It sees a site's certificate, so it can find which names exist, and it reaches Caddy's TLS and HTTP code.
- Port 80 has no guard: its redirect answers every host name with `308` and no app content.
- A site block the user writes by hand gets no guard.
- A placeholder that another repo's `init` wrote before this change has no guard until that repo runs `init` again; it answers only `503` and the name. Its live route from the Vite plugin always has the guard.

## Rejected

- **Root service with `default_bind` as the default:** the costs above. A user who needs `default_bind` for their own sites can still choose it.
- **A dedicated `_caddy` user:** still cannot bind chosen addresses, so it needs the same guard; it adds an account to manage and moves storage out of the user's home.
- **`pf` redirect from 443 to a high port bound to chosen addresses:** adds a firewall rule `init` must install and keep across reboots.
- **A "LAN on purpose" setting that drops the guard:** no device can use it. A device without Tailscale cannot resolve `.internal` (dnsmasq answers only on the Tailscale IP), and `.localhost` always points to the device itself.
