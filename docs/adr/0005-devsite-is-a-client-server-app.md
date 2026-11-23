# ADR 0005 — devsite is a client-server app

## Status

Accepted (2026-11-23).

## Context

devsite's work was spread over three programs that each ran only for a moment: `init` wrote one Caddy site file per project and had to run in each repo; the Vite plugin swapped a live route into Caddy through its admin API when `bun dev` started; and Caddy served an offline page that could not know the project's real state. With no program that stays on, devsite could not keep state for a stopped project, could not talk to devsite on another Mac, and could not serve a project that never ran `init` on this Mac (issue #105).

## Decision

- devsite is a client-server app. The node is the server: one devsite process on each Mac that stays on and holds all of devsite's logic and files. The command-line tool and the Vite plugin are clients: each sends a request to the node and shows the answer.
- The node listens on `127.0.0.1:47380`, a fixed port, because Caddy's route names it; macOS never assigns a port below 49152 to a dev server. Its API answers only a request sent to that address, so a web page that rebinds its DNS name to `127.0.0.1` reaches none of it.
- Caddy has one route, which `init` writes once into `devsite.d/node.caddy`: `*.internal` and `*.localhost`, behind the LAN guard (ADR 0002), proxied to the node. Caddy does only TLS and the guard. When the node does not answer, Caddy answers a short static "node not running" page itself.
- Caddy signs a certificate for each name at its first TLS handshake (`on_demand`, from its own CA), and first asks the node (`on_demand_tls { ask }` in the global options block), which allows only a name of a project it knows. A LAN host can finish a TLS handshake before the guard aborts it, so without the ask it could make Caddy sign one certificate per name it sends.
- The node routes each request by its `Host`: to the project's dev server on this Mac, or to the offline page, a normal HTML file filled with the project's real state (where it last ran, whether it is live). HMR's WebSocket goes through as raw bytes.
- `bun dev` tells the node the project's name, port, folder, package name and devsite version (`PUT /projects/<name>`), and nothing more; a stop of the dev server tells it once more. A dev server that ends with no stop (Ctrl-C, a crash) is found at the next request that cannot reach it, and `GET /status` asks each live project's port. With no node, the plugin warns `devsite: the node does not answer — run bunx devsite doctor` with the raw local URL, and registers nothing.
- A devSite name is one DNS label, because the `*.internal` route matches one label.
- Files: settings (`config.json`), state (`state.json`) and the node's program (`node/cli.js`) in `~/Library/Application Support/devsite/`; the log in `~/Library/Logs/devsite/node.log`.
- Install: `init` copies the devsite program it runs from into Application Support and starts it through a per-user LaunchAgent (`ai.den.devsite.node`), at login and again after a crash, with the runtime that ran `init` (a Homebrew Cellar path becomes its `opt` path, which survives `brew upgrade`). `init` is the only thing that installs or updates the node: it does so when the node does not answer or runs an older devsite, and never installs an older one. `bun dev` never changes the node.
- `doctor` checks the node first: that it answers, that it runs this devsite or newer, and that no project runs a devsite newer than the node.

## Consequences

- A new project opens at both names on its first `bun dev`, with no `init` in its repo.
- Gone: the site file per project, the port files, the admin API route swap, the offline HTML inlined into the Caddyfile, and the 502/503 split. The code reads none of the old paths; a Mac set up by an older devsite moves by hand once.
- A new name visited while the node is down gets no certificate, so the browser shows a TLS error, not the "node not running" page; a name visited before keeps its certificate.
- Each later client (a menu bar app, a non-Vite dev server) needs only the node's API.

## Rejected

- **A wildcard certificate per suffix:** the build could not show that browsers accept a wildcard directly under `.internal` or `.localhost`; a certificate per name at the first handshake works the way the per-project certificates did.
- **A second way for the Vite plugin to register a project when the node is down:** it would work for some projects only, and could start a name live on another Mac (#66).
