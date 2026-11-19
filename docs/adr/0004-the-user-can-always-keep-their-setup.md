# ADR 0004 — The user can always keep their setup and devsite

## Status

Accepted (2026-11-19).

## Context

devsite changes things the user or other programs also use: the Caddyfile's global options, a running Caddy and its runtime routes, dnsmasq's config, the trust store. A design that covers the known scenarios still misses some. In a missed scenario, a user whose own setup breaks must not have to choose between that setup and devsite.

## Decision

- devsite picks a default for each change to a shared thing, and prohibits nothing it can work with. A preference (fewer privileges, less code) sets the default; only a case devsite cannot work in is refused.
- Each change to a shared thing has a machine setting in `~/.config/devsite/config.json` that hands the change to the user. With the setting on, `init` skips the change and prints what must be true instead.
- `doctor` checks outcomes, never devsite's method: `.internal` resolves to the right address, the served certificate chains to the pinned CA, each devsite route has the LAN guard and answers. A setup the user built another way passes. The "Setup" section `doctor` prints above the checks (install kind, config files, service manager, user, storage) is information, not a check: it never changes the exit code.
- A message that stops `init` names the setting that gets the user past it.

## Consequences

- A root Caddy the user runs stays, with `sudo` on each reload (ADR 0002).
- Each shared change adds a setting and a path through `init` to test.
