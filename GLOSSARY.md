# devsite

devsite serves each project's dev server at `https://<name>.internal` and `https://<name>.localhost`, on the Mac and on the phone.

## Language

**Node**:
The devsite server that stays on, one on each Mac; it holds all of devsite's logic and files.
_Avoid_: daemon, agent, service

**Client**:
A program that sends a request to the node and shows the answer: the command-line tool, the Vite plugin, the menu bar app.

**Peer**:
The node on another Mac of your Tailscale user.

**Protocol number**:
The number each call between nodes carries; a node on another number shows in `doctor` and does not count as gone.

**Live**:
A project is live on a Mac when its dev server there answers; a Mac that gives no answer, or serves only the offline page, does not count.
_Avoid_: running, up

**Main Mac**:
The Mac the `internal` split DNS route names; the phone's requests reach it first.
_Avoid_: route's Mac, primary

**Signal**:
What the main Mac's node sends every 2 seconds on the open connection from each other node; 3 missed signals start a takeover.

**Takeover**:
Another Mac becomes the main Mac when the main Mac is gone.

**Pass**:
The Caddy of a Mac whose node is stopped sends a request to the main Mac.

**Relay**:
A node sends a request for a name live on another Mac over HTTPS to the Caddy of that Mac, not to its dev server.
