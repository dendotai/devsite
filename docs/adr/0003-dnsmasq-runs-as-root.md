# ADR 0003 — devsite runs one root dnsmasq, on the Tailscale IP only

## Status

Accepted (2026-11-19).

## Context

The phone reaches `.internal` through Tailscale split DNS, which sends its queries to port 53 on the Mac's Tailscale IP. Something on the Mac must answer there.

ADR 0002 moved Caddy off root. dnsmasq cannot follow: dnsmasq 2.93, run as the user on a port below 1024, failed to bind `127.0.0.1` and the Tailscale IP with `Permission denied`, with and without `listen-address`. dnsmasq on macOS always forces `bind-interfaces` and binds each address on its own, and macOS lets only root do that below port 1024.

The same binding rule makes a dnsmasq that names an absent address exit at start. A dnsmasq that listens on `127.0.0.1` and the Tailscale IP therefore dies whenever Tailscale is off, and a Mac that sends its `.internal` lookups to it through `/etc/resolver/internal` waits for a timeout on each one.

With Tailscale on, the Mac's main DNS server is Tailscale's `100.100.100.100`, which follows the same split DNS route as the phone, so the Mac resolves `.internal` with no resolver file. With Tailscale off, `.internal` names get NXDOMAIN from the network's DNS server at once.

## Decision

- devsite runs one dnsmasq of its own, as root, under its own LaunchDaemon and config file. It listens on the Tailscale IP only and answers `address=/internal/<Tailscale IP>`.
- devsite writes no `/etc/resolver/internal` and runs no dnsmasq for the Mac itself. It never changes a dnsmasq the user runs.
- With no Tailscale on the Mac, devsite installs no dnsmasq.

## Consequences

- `sudo` runs on the first setup and when the Tailscale IP changes, because dnsmasq rereads `address=` and `listen-address=` only on a restart.
- On the Mac, `.internal` works while Tailscale is on; `.localhost` always works. With Tailscale off, a `.internal` URL shows "site not found" at once.
- A root dnsmasq carries none of the costs ADR 0002 lists for a root Caddy: no password on every `init`, no root-owned Homebrew paths, no files in the user's storage, and no admin API; after the bind it runs as `nobody`.
- A user's own dnsmasq that binds every address at its start, the Tailscale IP included, takes that address first; devsite's dnsmasq then fails alone, and `doctor` checks the answer on the Tailscale IP, not which dnsmasq gives it.

## Rejected

- **A Mac dnsmasq run as the user on `127.0.0.1:5354`, with `/etc/resolver/internal` pointing at it:** one more service and one more `sudo` file, only so that `.internal` also works on the Mac while Tailscale is off.
- **devsite's lines inside the user's dnsmasq config:** its listen lines apply to the whole dnsmasq and would cut the user's dnsmasq off their LAN or kill it when Tailscale is off.
