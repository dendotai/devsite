# devsite

One project = one stable `https://<name>.internal` URL, plus `https://<name>.localhost` on the machine itself. No port numbers, no port coordination between projects, HTTPS everywhere — and the same URL works on your phone over Tailscale. Any number of projects run simultaneously.

With a stock dev server, a project's address is a port number. `localhost:3000` is taken, so this project runs on 3001 — on this machine, today; another machine or a restarted server can pick a different number. Testing on a phone requires the machine's LAN IP, and browser APIs that require a secure context (camera, clipboard, service workers) do not work over plain HTTP. devsite gives each project a fixed name instead of a port.

<!-- TODO: demo GIF — ~20 s screen recording: `devsite init` → `bun dev` → https://myapp.internal opens on the desktop → the same URL opens on a phone. -->

## How it works

A `devSite` field in `package.json` declares the project's name, and devsite serves it at `https://<name>.internal` (every device on the tailnet) and `https://<name>.localhost` (this Mac). There is no port field:

```jsonc
// package.json
{
  "name": "myapp",
  "devSite": { "name": "myapp" }
}
```

devsite has three parts:

- **`devsite init`** — the onboarding, run once per machine and once per repo. It checks each part of the setup, fixes only what is red, and on a set-up Mac asks nothing, runs no `sudo`, and changes nothing. See [The onboarding](#the-onboarding).
- **`devsite doctor`** — the same checks with the fixes turned off. It prints how this Mac is set up, marks each check green or red, and names the fix for each red one. See [`devsite doctor`](#devsite-doctor).
- **The Vite plugin** — runs on every `bun dev`. It picks a free ephemeral port, points Vite's server and HMR at it, writes a live `reverse_proxy` to the host's port file, and swaps the host's placeholder route for it through Caddy's admin API on localhost. When the dev server stops, the plugin writes the placeholder back. This step needs no sudo, and because every port is picked at start time, no two projects can want the same one.
  - It only updates a route that `devsite init` wrote. For a name `init` has not seen yet (a new project, a renamed one), `bun dev` warns that Caddy has no route for `<name>.internal`, names `bunx devsite doctor`, and serves on the raw local URL.
  - It also routes `<name>.localhost` to the same port. The Claude desktop app's browser pane asks for approval on every action on a private name such as `.internal`, and skips that only for `localhost` names.

```text
Browser ── https://myapp.internal ──▶ Caddy :443 (TLS from local CA)
                                        │  ▲
                          reverse_proxy │  ├── devsite init: writes devsite.d/ (once per repo)
                                        ▼  └── Vite plugin: swaps the route (admin API, localhost)
                                      Vite dev server (ephemeral port)
```

Each host file in `devsite.d/` takes its handler from the host's port file in devsite's state directory, so a Caddy reload or restart mid-session keeps a running dev server's route. While the dev server is down, the URL answers devsite's offline page. Every devsite route answers only this machine and your tailnet: a request from the LAN gets no response.

## Quick start

Setup has two tiers. The first is complete on its own: after it, `https://<name>.localhost` works on this Mac. The second adds `https://<name>.internal` on this Mac and on your other devices.

### Step 1 — this Mac (~5 minutes)

1. **Declare a name** in your project's `package.json`:

   ```jsonc
   "devSite": { "name": "myapp" }
   ```

2. **Add devsite to the project and run the onboarding** from the repo root:

   ```sh
   bun add -d @den-ai/devsite
   bunx devsite init       # or: bunx devsite init --dry-run to preview
   ```

   On a new Mac, `init` installs Caddy with Homebrew, writes its config, starts Caddy as you, and adds Caddy's local CA to your keychain. It shows the plan and the diff of your Caddyfile first, and asks once.

3. **Add the plugin** to your Vite config:

   ```ts
   // vite.config.ts
   import { devsite } from "@den-ai/devsite/vite";

   export default defineConfig({
     plugins: [devsite()],
   });
   ```

4. **Run dev and open the URL:**

   ```sh
   bun dev
   ```

   Open `https://myapp.localhost`. The certificate is trusted, and HMR runs over `wss`.

Each additional project needs only steps 1 to 3. Because no project declares a port, projects never coordinate with each other and any number can run at once.

### Step 2 — `.internal` and your other devices (optional)

1. **Install [Tailscale](https://tailscale.com)** on this Mac and on each device, and sign in to the same tailnet.

2. **Run `bunx devsite init` again.** With Tailscale on the Mac, it installs dnsmasq and runs devsite's own dnsmasq on this Mac's Tailscale IP (one `sudo` prompt). Then it guides you through the split DNS route, the one step only the Tailscale admin console can do:

   ```text
   Step 3 of 3: add the split DNS route for .internal in the Tailscale admin console, so the phone finds .internal names  [manual]
     nameserver: 100.90.1.2
     restrict to domain: internal
   Open https://login.tailscale.com/admin/dns in your browser? (y/n)
   Done? Press y to check, n to skip
   ```

   `y` at "Done?" checks the route with `tailscale dns status` and asks again until it is there.

3. **Trust the CA root on each device.** The `init` run that trusted the CA on this Mac printed the path of the root certificate at its end; `bunx devsite doctor` shows its path on the line "that CA is trusted in the keychain" when devsite can read Caddy's storage. Get it onto the phone (AirDrop works) and install it. On iOS, installing is not trusting: install the profile, then turn it on in Settings → General → About → Certificate Trust Settings.

`https://myapp.internal` now opens on this Mac and on the phone, including HMR.

## The onboarding

`bunx devsite init` runs in this order:

- **Checks.** It runs every check `doctor` runs and prints each one green (`✓`), red (`✗`), or skipped (`–`).
- **Plan.** For the red checks it can fix, it prints a numbered plan and the diff of each file it would change, except the files devsite writes whole (the offline page and the dnsmasq files), which show as one line; `--dry-run` prints their diff too. A step that needs root is tagged `[sudo]`; a step only you can do is tagged `[manual]`.
- **One prompt.** `Apply these changes? [Y/n]`. `--dry-run` stops before this prompt and writes nothing.
- **One `sudo` call.** Every root step runs back to back in one `sudo` call, right after your `y`, so you type your password at most once per run. Your password goes only to `sudo`, never through devsite.
- **Manual steps.** Each asks `Open <url> in your browser? (y/n)`, then `Done? Press y to check, n to skip`. Each prompt takes one key, with no Enter. A skipped step leaves `doctor` red; `init` still finishes.
- **Checks after this run.** The same checks again, with the fix for each one still red.

On a set-up Mac `init` prints the checks, then `Nothing to do: init changed nothing.` It leaves Caddy alone, so your running dev servers keep their routes.

`init` works with the Caddy you already have:

- A running Caddy keeps its service manager (`brew services`, your own launchd file, a terminal) and gets only devsite's config, loaded through the admin API.
- An installed Caddy that does not run is started with `brew services start`. A missing Caddy is installed with `brew install caddy`.
- A Caddy that runs as root stays root: `init` writes its files and reloads it with `sudo`, tagged `[sudo]` in the plan.
- Your own `storage` line stays, and devsite uses that storage, so your CA stays the one your devices trust.
- Your own site blocks keep their `default_bind`: `init` stops and names the ways past (`import devsite-guard` in each site, or the `caddy.user` setting).
- A Caddy with no Caddyfile (JSON config or admin API only): `init` writes `devsite.d/`, prints the adapted JSON with where it goes in your config, and stops.

A message that stops `init` names the setting that gets you past it.

## `devsite doctor`

`bunx devsite doctor` writes nothing and runs no `sudo`, so you can run it any time. It exits 1 on any red check, so a script can use it as a gate. Outside a repo it runs the machine checks and skips the repo checks.

It prints a Setup section first. The Setup section is information only and never changes the exit code:

```text
Setup
  Caddy: Homebrew at /opt/homebrew
  Caddy config: /opt/homebrew/etc/Caddyfile (Homebrew's default)
  devsite's Caddy config: /opt/homebrew/etc/devsite.d
  Caddy log: /opt/homebrew/var/log/caddy.log
  Service manager: brew services
  Runs as: you (devsite's default)
  Caddy storage: /opt/homebrew/var/lib/caddy (the Caddyfile's storage line)
  dnsmasq: devsite's config /Library/Application Support/devsite/dnsmasq.conf, listens on 100.90.1.2
  Hosts unused for 30+ days: none
```

Then the checks. They check outcomes, not how they came about, so a setup you built another way passes:

- **Caddy** — installed; the admin API answers; each devsite host's route starts with the LAN guard; no route before a devsite host also matches it; the served certificate chains to the CA in Caddy's storage; that CA is trusted in the keychain; each host has its port file; the offline page file matches what `init` writes.
- **Tailscale** (when it is on the Mac) — up; the split DNS route for `internal` points to this Mac.
- **dnsmasq** (when Tailscale is on the Mac) — something answers `.internal` with the Tailscale IP on the Tailscale IP; this Mac resolves `.internal` to the Tailscale IP.
- **This repo** — every `devSite` name is valid and used by one project only, and its host file matches what `init` would write.

Each red check names its fix: `bunx devsite init`, a setting, or a manual step.

## Settings

`~/.config/devsite/config.json` holds the machine settings. Each one hands a change devsite would make to a shared thing over to you; with the setting on, `init` skips the change and prints what must be true instead. The file is optional, and a setting devsite cannot read stops `init` and `doctor` with the reason.

```jsonc
{
  "caddy": {
    "config": "/etc/caddy/Caddyfile",           // the main Caddy config, for a Caddy not installed with Homebrew
    "user": "root",                             // "user" or "root": the user Caddy runs as, over what devsite found
    "reload": "manual"                          // init writes devsite's files; you reload Caddy
  },
  "dnsmasq": {
    "run": "manual" // init runs no dnsmasq; you make a DNS server answer .internal on the Tailscale IP
  }
}
```

## DNS and certificates

**How does `*.internal` resolve?** `.internal` is the TLD ICANN reserved for private use: no public DNS answers for it, and no public CA issues certificates for it. Tailscale split DNS sends every `.internal` lookup on the tailnet to devsite's dnsmasq on this Mac's Tailscale IP, which answers with that IP. The Mac itself resolves `.internal` the same way, through Tailscale's DNS server. With Tailscale off, `.internal` lookups on the Mac fail at once, with no wait for a timeout; `.localhost` always works.

**Why does the browser trust the certificate?** Caddy runs a local certificate authority and issues short-lived certificates for your hosts from it. `devsite init` adds that CA's root to your keychain and keeps the storage Caddy already uses, so a device that trusted the root once keeps trusting every certificate it issues. Other devices trust the same root file by hand (Step 2.3).

## FAQ

**Why does devsite need `sudo` for dnsmasq?** The phone sends its `.internal` lookups to port 53 on the Mac's Tailscale IP, and on macOS only root can bind an address below port 1024. devsite therefore runs one dnsmasq of its own as root, under its own LaunchDaemon, listening on the Tailscale IP only; after the bind it runs as `nobody`. `sudo` runs on the first setup and when the Tailscale IP changes, because dnsmasq rereads its addresses only on a restart. devsite never changes a dnsmasq you run yourself. See [ADR 0003](docs/adr/0003-dnsmasq-runs-as-root.md).

## Why not X

- **[portless](https://github.com/typicode/portless) / devurl** — solve the same problem with `*.localhost` URLs. They need no DNS setup, because browsers resolve `.localhost` to loopback on their own — but loopback also means no other device can reach the URL. devsite requires more one-time setup (Caddy, a local CA, DNS); in return the URL carries a trusted certificate and works from other devices.
- **Laravel Valet / Herd** — the same per-project local HTTPS domain experience, built for the PHP ecosystem on macOS. devsite is a framework-agnostic version of the same idea for Vite projects.
- **A hand-written Caddyfile** — provides the same URLs, but every project needs a fixed port and every repo edits the shared file by hand. devsite adds route self-registration (each repo's `init` writes its own `devsite.d/` files and never touches another's) and removes fixed ports (ephemeral port plus admin-API swap at dev time).

## What devsite changes on your machine, and how to undo it

devsite modifies machine-global state. This section lists every change and how to remove it. Paths are for Homebrew on Apple Silicon; on Intel Homebrew `/opt/homebrew` is `/usr/local`.

What `devsite init` changes (each changed file shows its diff first, except the files devsite writes whole, which show as one line, and every service and `sudo` command is printed as it runs):

- `/opt/homebrew/etc/Caddyfile` — set up once: one `import devsite.d/*.caddy # devsite` line, and a `storage` pin only when the file has no `storage` line. Before any Caddyfile write, the previous file is copied to `Caddyfile.bak`; the very first write also saves `Caddyfile.pre-devsite`, which no later run touches. A `default_bind` line is deleted only when the file has no site blocks of your own.
- `/opt/homebrew/etc/devsite.d/` — devsite's own directory: one `<host>.caddy` file per host (first line `# <project>`, recording which project owns it), `guard.caddy` (the LAN guard snippet), and `fragments/offline.caddy` (the offline page).
- `~/Library/Application Support/devsite/ports/` — one port file per host, written as you.
- The Caddy service — installed and started with Homebrew only when Caddy is missing or stopped.
- Your keychain — Caddy's local CA root is added with `sudo caddy trust`.
- With Tailscale on the Mac: dnsmasq from Homebrew, plus devsite's own `/Library/Application Support/devsite/` (`dnsmasq.conf` and `dnsmasq-watcher.zsh`) and `/Library/LaunchDaemons/ai.den.devsite.dnsmasq.plist`.

What the Vite plugin changes: it edits Caddy's in-memory running config over the localhost admin API, writes the live port to the host's port file, and records the host's last-used date in `~/Library/Application Support/devsite/last-used.json` (`DEVSITE_STATE_DIR` overrides the directory).

**Undoing it** — there is no `devsite uninstall` command yet, so removal is manual:

```sh
sudo launchctl bootout system/ai.den.devsite.dnsmasq   # stop devsite's dnsmasq
sudo rm /Library/LaunchDaemons/ai.den.devsite.dnsmasq.plist
sudo rm -rf "/Library/Application Support/devsite"
sudo caddy untrust                      # remove the CA root from the keychain
rm -rf /opt/homebrew/etc/devsite.d      # devsite's own Caddy directory
# then remove the import line from /opt/homebrew/etc/Caddyfile, or restore Caddyfile.pre-devsite
rm -rf ~/Library/Application\ Support/devsite   # port files and last-used dates
```

Also delete the `internal` split DNS nameserver in the [Tailscale admin console](https://login.tailscale.com/admin/dns).

Note: **renaming** a project (changing its `devSite.name`) cleans up after itself — the next `devsite init` in that project deletes the old host's file. **Deleting a whole project** does not: its host file lingers in `devsite.d/` (serving the offline page) until you remove it by hand. `devsite doctor` lists hosts unused for 30+ days.

## Requirements

- **Node.js ≥ 22** — the published CLI runs under plain Node (`npx @den-ai/devsite init` works without bun). Developing the repo itself still uses bun.
- **Caddy ≥ 2.** `init` installs it with Homebrew when it is missing. A Caddy installed another way works with the `caddy.config` setting.
- **Vite** — the plugin is developed against Vite 8.
- **macOS**, with Homebrew on Apple Silicon or Intel (found with `brew --prefix`). Linux and Windows are not supported yet.
- **Project layout**: `devsite init` reads `devSite` fields from the repo root `package.json` and, in a monorepo, from `apps/*/package.json` and `packages/*/package.json`. Other workspace folders (e.g. `services/*`) are not scanned yet.
- **Tailscale** — optional, only for `.internal` and the other-devices tier.
