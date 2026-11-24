# Known gaps and risks

Open: waits for a fix, in its issue. Accepted: stays as it is, with the reason. A change that closes an entry deletes it.

## Open

- **Parts of the split DNS takeover with no test** (#125).

## Accepted

- **The stored secret and the CA root key.** A program that runs as the user can read the Tailscale OAuth client secret from the login Keychain with no prompt, and change every DNS setting of the tailnet with it. The same program can read the key of Caddy's CA root, which the phone trusts. With both, it can send the phone to a false copy of a site that the phone accepts as real. Accepted because the node reads the secret with no one present. Looked at again when the node is a signed app (#112), because macOS can then limit the secret to that app.
- **An HTTP/3 connection from before `Alt-Svc: clear`.** A browser that holds one stays on its machine until that connection ends. Accepted because it happens once per browser.
- **A hung node.** The route moves after about 6 s, but an open page stays on the hung machine. Accepted because Caddy cannot tell a hung node from a slow dev server without a time limit that also cuts slow builds.
- **A takeover under very high load.** At a load average of 267, the main Mac sent no signal for 6 s and another machine took over. Accepted because 6 s is the limit #110 sets, and requests still work through the new main Mac.
- **A route made by hand with two nameservers.** Each of the two machines counts itself as the main Mac. Accepted because two nameservers are out of scope (#66).
- **A main Mac that Tailscale lists as offline.** `doctor` is red on the other machines, though the main Mac's node may answer. Accepted because `doctor` would wait up to 1.5 s for each sleeping machine.
- **A machine that does not trust the CA root.** While its node is down, it shows the "node not running" page and passes no request. Accepted because `doctor` is red there, with the fix.
- **A Caddy that runs as root and listens only on the Tailscale IP.** While its node is down, it answers an empty 502. Accepted because `doctor` is red for that setup.
