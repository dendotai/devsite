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

devsite is a client-server app ([ADR 0005](docs/adr/0005-devsite-is-a-client-server-app.md)):

- **The node** — one devsite process on each Mac that stays on. Caddy sends every `*.internal` and `*.localhost` request to it, and it passes each one to the project's dev server, or answers devsite's offline page with the project's real state (where it last ran, whether it is live). A per-user LaunchAgent starts it at login and again after a crash.
- **`devsite init`** — the onboarding, run once per Mac, from any folder. It installs the node, writes Caddy's one route to it, and checks each part of the setup, fixing only what is red; on a set-up Mac it asks nothing, runs no `sudo`, and changes nothing. See [The onboarding](#the-onboarding).
- **`devsite doctor`** — the same checks with the fixes turned off, the node first. It prints how this Mac is set up, marks each check green or red, and names the fix for each red one. See [`devsite doctor`](#devsite-doctor).
- **The Vite plugin** — runs on every `bun dev`. Vite binds a free port the OS assigns, and the plugin tells the node the project's name, port and folder. That is all: no sudo, no Caddy change, and no `init` in the project's repo. With no node, `bun dev` prints `devsite: the node does not answer — run bunx devsite doctor` and serves on the raw local URL.
  - A name live on another Mac of your tailnet stops `bun dev` with an error such as `devsite: web.internal runs on Mac mini from ~/Projects/acme-web`, because one name has one URL. A Mac that gives no answer, or serves only the offline page, does not block the start; a Mac online in Tailscale that does not reply delays it by up to 1.5 s.
  - It also routes `<name>.localhost` to the same port. The Claude desktop app's browser pane asks for approval on every action on a private name such as `.internal`, and skips that only for `localhost` names.

```text
Browser ── https://myapp.internal ──▶ Caddy :443 (TLS from local CA, LAN guard)
                                        │
                          reverse_proxy │  one route: *.internal, *.localhost
                                        ▼
                                      devsite node (127.0.0.1:47380) ◀── Vite plugin: "myapp runs on port 51234"
                                        │
                                        ▼
                                      Vite dev server (OS-assigned port)
```

The nodes on the Macs of one tailnet find each other through `tailscale status`, and each listens for the others on port **47380** of its Tailscale IPs, the port it uses on `127.0.0.1`. A node answers another node only when `tailscale whois` names your own Tailscale user; a device shared into your tailnet still reaches your dev servers through Caddy.

A request for a name that is not live on the Mac it reaches goes on to the Mac where the name is live: the node relays it over HTTPS to that Mac's Caddy, HMR included, and checks that Caddy's certificate against this Mac's CA root, read from Caddy's admin API. So the phone opens `https://<name>.internal` for a project on any of your Macs, and a dev server started on any Mac opens at once. The relay needs one CA root on every Mac (below); with another root, the page names that Mac and the `devsite ca export` / `devsite init --ca -` fix. A name live on no Mac shows the offline page with where the project last ran, on any of your Macs.

A project's name is one DNS label (`myapp`, not `my.app`). Caddy signs each name's certificate from its local CA at the first visit, after the node confirms the name is a project it or another Mac's node knows. Every devsite request answers only this machine and your tailnet: a request from the LAN gets no response. When the node does not answer, Caddy shows a short "node not running" page.

## Quick start

Setup has two tiers. The first is complete on its own: after it, `https://<name>.localhost` works on this Mac. The second adds `https://<name>.internal` on this Mac and on your other devices.

### Step 1 — this Mac (~5 minutes)

1. **Declare a name** in your project's `package.json`:

   ```jsonc
   "devSite": { "name": "myapp" }
   ```

2. **Add devsite to the project and run the onboarding** (once per Mac):

   ```sh
   bun add -d @den-ai/devsite
   bunx devsite init       # or: bunx devsite init --dry-run to preview
   ```

   On a new Mac, `init` installs the node, installs Caddy with Homebrew, writes its config, starts Caddy as you, and adds Caddy's local CA to your keychain. It shows the plan and the diff of your Caddyfile first, and asks once. A second project needs no `init`.

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

2. **Create a Tailscale OAuth client** on the [Trust credentials page](https://console.tailscale.com/admin/settings/trust-credentials): choose Credential, then OAuth, then tick Write next to DNS. Don't forget to back up the secret. Tailscale won't show it again. The node writes the `internal` split DNS route with it, so you never edit the route in the admin console.

3. **Run `bunx devsite init` again.** With Tailscale on the Mac, it installs dnsmasq and runs devsite's own dnsmasq on this Mac's Tailscale IP (one `sudo` prompt). Then it asks for the OAuth client secret, shows nothing you type, and stores it in the login Keychain, where the node reads it:

   ```text
   Step 3 of 3: store the Tailscale OAuth client secret in the login Keychain, so the node writes the split DNS route  [manual]
   Tailscale OAuth client secret:
     Stored in the login Keychain.
     The split DNS route for .internal names this Mac (100.90.1.2).
   ```

   To pipe the secret in instead, for example with the 1Password CLI: `op read "op://<vault>/<item>/credential" | bunx devsite init --tailscale-secret -`. Run it on each Mac, so any Mac can take over the route.

4. **Trust the CA root on each device.** The `init` run that trusted the CA on this Mac printed the path of the root certificate at its end; `bunx devsite doctor` shows its path on the line "that CA is trusted in the keychain" when devsite can read Caddy's storage. Get it onto the phone (AirDrop works) and install it. On iOS, installing is not trusting: install the profile, then turn it on in Settings → General → About → Certificate Trust Settings.

`https://myapp.internal` now opens on this Mac and on the phone, including HMR.

## The onboarding

`bunx devsite init` runs in this order:

- **Checks.** It runs every check `doctor` runs and prints each one green (`✓`), red (`✗`), or skipped (`–`).
- **Plan.** For the red checks it can fix, it prints a numbered plan and the diff of each file it would change, except the files devsite writes whole (Caddy's route to the node and the dnsmasq files), which show as one line; `--dry-run` prints their diff too. A step that needs root is tagged `[sudo]`; a step only you can do is tagged `[manual]`.
- **One prompt.** `Apply these changes? [Y/n]`. `--dry-run` stops before this prompt and writes nothing.
- **One `sudo` call.** Every root step runs back to back in one `sudo` call, right after your `y`, so you type your password at most once per run. Your password goes only to `sudo`, never through devsite.
- **Manual steps.** Each asks `Open <url> in your browser? (y/n)`, then `Done? Press y to check, n to skip`. Each prompt takes one key, with no Enter. A skipped step leaves `doctor` red; `init` still finishes.
- **Checks after this run.** The same checks again, with the fix for each one still red.

On a set-up Mac `init` prints the checks, then `Nothing to do: init changed nothing.` It leaves Caddy and the node alone, so your running dev servers keep their routes. `init` is the only thing that installs or updates the node: it installs the devsite version it runs from when the node does not answer or runs an older devsite.

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

- **Node** — it answers on `127.0.0.1:47380`; it runs this devsite or newer; no project runs a devsite newer than it. When it does not answer, the fix names `bunx devsite init` and the node's log.
- **Caddy** — installed; the admin API answers; devsite's route for `*.internal` and `*.localhost` exists and starts with the LAN guard; no route before it takes its names; the served certificate chains to the CA in Caddy's storage; that CA is trusted in the keychain.
- **Tailscale** (when it is on the Mac) — up; the login Keychain holds the OAuth client secret; the split DNS route for `internal` points to this Mac or to another Mac whose node answers.
- **dnsmasq** (when Tailscale is on the Mac) — something answers `.internal` with the Tailscale IP on the Tailscale IP; this Mac resolves `.internal` to the IP of the Mac the split DNS route names.
- **Node on the tailnet** (with Tailscale up) — the node listens on port 47380 of each Tailscale IP. When another program holds the port, the red check names it, and the node takes the port within 10 s once it is free.
- **Other Macs** (when another Mac of your Tailscale user answers on port 47380) — its node speaks this node's protocol number (a red check names the Mac to update: `update devsite on Mac mini`), it accepts this Mac's calls, and no other program holds the port there. A Mac with no devsite, a stopped node, or a Mac that sleeps gets no check.
- **This repo** — every `devSite` name is valid and used by one project only, and the node holds no name of this repo for a folder outside it.

Each red check names its fix: `bunx devsite init`, a setting, or a manual step.

## Settings

`~/Library/Application Support/devsite/config.json` holds the machine settings. Each one hands a change devsite would make to a shared thing over to you; with the setting on, `init` skips the change and prints what must be true instead. The file is optional, and a setting devsite cannot read stops `init` and `doctor` with the reason.

```jsonc
{
  "caddy": {
    "config": "/etc/caddy/Caddyfile",           // the main Caddy config, for a Caddy not installed with Homebrew that runs with no --config
    "user": "root",                             // "user" or "root": the user Caddy runs as, over what devsite found
    "reload": "manual"                          // init writes devsite's files; you reload Caddy
  },
  "dnsmasq": {
    "run": "manual" // init runs no dnsmasq; you make a DNS server answer .internal on the Tailscale IP
  }
}
```

## DNS and certificates

**How does `*.internal` resolve?** `.internal` is the TLD ICANN reserved for private use: no public DNS answers for it, and no public CA issues certificates for it. Tailscale split DNS sends every `.internal` lookup on the tailnet to devsite's dnsmasq on the main Mac's Tailscale IP, which answers with that IP. The Mac itself resolves `.internal` the same way, through Tailscale's DNS server. With Tailscale off, `.internal` lookups on the Mac fail at once, with no wait for a timeout; `.localhost` always works.

**Why does the browser trust the certificate?** Caddy runs a local certificate authority and issues short-lived certificates for your hosts from it. `devsite init` adds that CA's root to your keychain and keeps the storage Caddy already uses, so a device that trusted the root once keeps trusting every certificate it issues. Other devices trust the same root file by hand (Step 2.4).

**One CA root on several Macs.** Each Mac's Caddy makes its own root, so a phone would need one root per Mac. Give every Mac the same root instead: save it once in your secret store, then import it on each other Mac before you trust anything there. For example, with the 1Password CLI:

```bash
bunx devsite ca export | op document create - --title "devsite CA root" --file-name devsite-ca.pem
```

```bash
op document get "devsite CA root" | bunx devsite init --ca -
```

`ca export` prints the root certificate and its key and writes no file. `init --ca -` reads them from standard input, asks its questions on the terminal, puts the root into Caddy's storage, deletes the intermediate and the certificates the old root signed, and restarts Caddy so it serves certificates from the new root. When the storage already holds a different root, the plan names both and waits for your y. It imports into a Caddy that runs as you, stopped or under `brew services`.

## FAQ

**Why does devsite need `sudo` for dnsmasq?** The phone sends its `.internal` lookups to port 53 on the Mac's Tailscale IP, and on macOS only root can bind an address below port 1024. devsite therefore runs one dnsmasq of its own as root, under its own LaunchDaemon, listening on the Tailscale IP only; after the bind it runs as `nobody`. `sudo` runs on the first setup and when the Tailscale IP changes, because dnsmasq rereads its addresses only on a restart. devsite never changes a dnsmasq you run yourself. See [ADR 0003](docs/adr/0003-dnsmasq-runs-as-root.md).

## Why not X

- **[portless](https://github.com/typicode/portless) / devurl** — solve the same problem with `*.localhost` URLs. They need no DNS setup, because browsers resolve `.localhost` to loopback on their own — but loopback also means no other device can reach the URL. devsite requires more one-time setup (Caddy, a local CA, DNS); in return the URL carries a trusted certificate and works from other devices.
- **Laravel Valet / Herd** — the same per-project local HTTPS domain experience, built for the PHP ecosystem on macOS. devsite is a framework-agnostic version of the same idea for Vite projects.
- **A hand-written Caddyfile** — provides the same URLs, but every project needs a fixed port and every repo edits the shared file by hand. devsite adds self-registration (`bun dev` tells the node its port) and removes fixed ports.

## What devsite changes on your machine, and how to undo it

devsite modifies machine-global state. This section lists every change and how to remove it. Paths are for Homebrew on Apple Silicon; on Intel Homebrew `/opt/homebrew` is `/usr/local`.

What `devsite init` changes (each changed file shows its diff first, except the files devsite writes whole, which show as one line, and every service and `sudo` command is printed as it runs):

- `/opt/homebrew/etc/Caddyfile` — set up once: one `import devsite.d/*.caddy # devsite` line, the `on_demand_tls` ask that lets Caddy sign a certificate only for a name the node knows, and a `storage` pin only when the file has no `storage` line. Before any Caddyfile write, the previous file is copied to `Caddyfile.bak`; the very first write also saves `Caddyfile.pre-devsite`, which no later run touches. A `default_bind` line is deleted only when the file has no site blocks of your own.
- `/opt/homebrew/etc/devsite.d/` — devsite's own directory: `node.caddy` (the one route to the node, with the "node not running" page) and `guard.caddy` (the LAN guard snippet).
- `~/Library/Application Support/devsite/` — the node's program (`node/cli.js`), its state (`state.json`: each project's port, folder, last-used date, and whether it is live), and the settings (`config.json`).
- `~/Library/LaunchAgents/ai.den.devsite.node.plist` — starts the node as you; its log is `~/Library/Logs/devsite/node.log`. The node runs one `osascript` process, which tells it when this Mac goes to sleep.
- The Caddy service — installed and started with Homebrew only when Caddy is missing or stopped.
- Your keychain — Caddy's local CA root is added with `sudo caddy trust`; the Tailscale OAuth client secret is a generic password in the login Keychain (service `devsite`, account `tailscale-oauth-client-secret`).
- With Tailscale on the Mac: dnsmasq from Homebrew, plus devsite's own `/Library/Application Support/devsite/` (`dnsmasq.conf` and `dnsmasq-watcher.zsh`) and `/Library/LaunchDaemons/ai.den.devsite.dnsmasq.plist`.

What the Vite plugin changes: nothing on disk. It tells the node the project's name, port and folder.

**Undoing it** — there is no `devsite uninstall` command yet, so removal is manual:

```sh
sudo launchctl bootout system/ai.den.devsite.dnsmasq   # stop devsite's dnsmasq
sudo rm /Library/LaunchDaemons/ai.den.devsite.dnsmasq.plist
sudo rm -rf "/Library/Application Support/devsite"
sudo caddy untrust                      # remove the CA root from the keychain
launchctl bootout gui/$(id -u)/ai.den.devsite.node      # stop the node
rm ~/Library/LaunchAgents/ai.den.devsite.node.plist
rm -rf /opt/homebrew/etc/devsite.d      # devsite's own Caddy directory
# then remove the import line and the on_demand_tls block from /opt/homebrew/etc/Caddyfile, or restore Caddyfile.pre-devsite
rm -rf ~/Library/Application\ Support/devsite ~/Library/Logs/devsite   # the node, its state, settings, logs
security delete-generic-password -s devsite -a tailscale-oauth-client-secret   # the OAuth client secret
```

Also delete the `internal` split DNS nameserver in the [Tailscale admin console](https://login.tailscale.com/admin/dns), and the OAuth client on the [Trust credentials page](https://console.tailscale.com/admin/settings/trust-credentials).

Note: a renamed or deleted project stays in the node's state, and its old name keeps answering the offline page. `devsite doctor` lists projects unused for 30+ days.

## Requirements

- **Node.js ≥ 22** — the published CLI runs under plain Node (`npx @den-ai/devsite init` works without bun). Developing the repo itself still uses bun.
- **Caddy ≥ 2.** `init` installs it with Homebrew when it is missing. A Caddy installed another way works when it runs with `--config`, or with the `caddy.config` setting.
- **Vite** — the plugin is developed against Vite 8.
- **macOS**, with Homebrew on Apple Silicon or Intel (found with `brew --prefix`). Linux and Windows are not supported yet.
- **Project layout**: `devsite doctor` checks the `devSite` fields of the repo root `package.json` and, in a monorepo, of `apps/*/package.json` and `packages/*/package.json`. The Vite plugin reads the one at its Vite root, in any folder.
- **Tailscale** — optional, only for `.internal` and the other-devices tier.
