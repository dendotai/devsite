# Known gaps and risks

Each entry is accepted, with its reason; a gap that waits for a fix is its issue instead. A change that closes an entry deletes it.

- **The stored secret and the CA root key.** A program that runs as the user can read the Tailscale OAuth client secret from the login Keychain with no prompt, and change every DNS setting of the tailnet with it. The same program can read the key of Caddy's CA root, which the phone trusts. With both, it can send the phone to a false copy of a site that the phone accepts as real. Accepted because the node reads the secret with no one present. Looked at again when the node is a signed app (#112), because macOS can then limit the secret to that app.
- **An HTTP/3 connection from before `Alt-Svc: clear`.** A browser that holds one stays on its machine until that connection ends. Accepted because it happens once per browser.
- **A hung node.** The route moves after about 6 s, but an open page stays on the hung machine, and a request passed to a hung main Mac waits. Accepted because Caddy cannot tell a hung node from a slow dev server without a time limit that also cuts slow builds.
- **A takeover under very high load.** At a load average of 267, the main Mac sent no heartbeat for 6 s and another machine took over. Accepted because 6 s is the limit #110 sets, and requests still work through the new main Mac.
- **A route made by hand with two nameservers.** Each of the two machines counts itself as the main Mac. Accepted because two nameservers are out of scope (#66).
- **A main Mac that Tailscale lists as offline.** `doctor` is red on the other machines, though the main Mac's node may answer. Accepted because `doctor` would wait up to 1.5 s when a machine sleeps.
- **A machine that does not trust the CA root.** While its node is down, it shows the "node not running" page and passes no request. Accepted because `doctor` is red there, with the fix.
- **A Caddy that runs as root and listens only on the Tailscale IP.** While its node is down, it answers an empty 502. Accepted because `doctor` is red for that setup.
- **A devsite node that starts before Tailscale.** A name live on another machine gets the offline page "devsite cannot look for … on your other machines yet", because the node has no list of the other machines yet. Accepted because it lasts at most about 10 s after Tailscale connects, and the page then opens the project.
- **A machine that loses its network or crashes while a request is relayed to it.** The request waits with no limit, because the relay has no limit on an answer. Accepted because a reload after 5 s gets the offline page; a machine that goes to sleep closes its heartbeat connection first, which ends the request with a page that names the machine.
