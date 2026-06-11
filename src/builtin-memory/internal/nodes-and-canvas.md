---
kind: knowledge
when-and-why-to-read: When you are operating the canvas — spawning or steering nodes, deciding how work reports up, recovering a dormant or crashed node, or reasoning about the daemon — this reference should be read because it is the operational model of nodes, the spine, lifecycle, and revive, so you drive the runtime correctly instead of inferring it from scattered command help.
short-form: Operational model of the agent runtime — nodes on the canvas graph, spawn/delegate, the push/feed spine, lifecycle states, and revive (manual + daemon auto-revive).
system-prompt-visibility: name
file-read-visibility: none
---

# How nodes and the canvas work (operational)

Every agent is a **node** in one directed graph (the **canvas**). Each node is an independent `pi` process in its own tmux window with its own context dir. The graph's edges are `subscribes_to` — the **spine** — and they decide who-wakes-whom.

## Spawn & delegate

`crtr node new "<task>" --kind <kind>` spawns a managed child in a background window and returns its id immediately; you **auto-subscribe** to it, so its finish wakes you. Delegating is the default move, not an optimization: a child's reading and tokens land in a fresh window and only the conclusion comes back, keeping your own context (the scarce resource) free for steering.

- Match `--kind` to the work (`explore spec design plan developer review general`, plus any custom persona). See `node new -h`.
- Fan **independent** units out as concurrent children — a wake with idle workers is wasted. Serialize only true dependencies; never let two live children edit the same files.
- `--root` spawns an independent node you neither manage nor are woken by (e.g. one a human will drive).
- Once you delegate a unit, don't also run it yourself — you'll be woken when it finishes.

Navigate/steer: `node focus` (jump a node into your pane), `node cycle` (DFS-walk neighbors), `node msg` (direct-message any node at a wake tier, reviving a dormant target), `node subscribe`/`unsubscribe` (wire edges spawn didn't create). Survey with `canvas dashboard` (ASCII tree), `canvas browse` (interactive navigator), `node inspect list/show`, `canvas attention` (who's blocked on a human).

## The push/feed spine

Nothing is reported automatically — the feed contains only what a node **pushes**.

- `push update` — routine progress; fans a lightweight pointer to subscribers, no forced wake.
- `push urgent` — force-wakes every subscriber (you're blocked, scope changed, an error derails the plan).
- `push final` — the ONLY way any node finishes: writes the canonical result, marks the node done, closes its window. Stopping without it is not finishing. (Guarded on a node working directly with a user — needs `--force` after they confirm.)

A push fans a ~30-token **pointer** (a ref path), not the content; subscribers dereference lazily. When a subscriber push wakes you, **the wake message already IS the coalesced digest** — don't re-run `feed read` to "open" it (the cursor already advanced); dereference the refs that matter. `feed read` is for proactively polling *before* a wake; `feed peek` shows live state of the nodes below you without draining (use it to confirm workers are alive before you yield). An empty feed while workers run is normal.

## Lifecycle

Two orthogonal axes:

- **mode**: base (a terminal worker — does one job in one window and ends) ↔ orchestrator (`node promote` — a long-lived, roadmap-holding coordinator that delegates phases and survives context refresh via `node yield`). Don't promote for work that fits one window.
- **lifecycle**: terminal (owes a final up the spine, reaps when done) ↔ resident (`node lifecycle` / interactable — stays dormant, wakes on inbox/human, never forced to finish). `node demote` is the friendly flip-to-terminal-in-place.

A dormant node has two wake triggers: an **inbox** message (push/msg) and the **clock** (`node wake` arms timed/recurring wakeups). To monitor your own children you arm nothing — you auto-subscribe on spawn, so their finish/crash/close wakes you; a deadline to chase a delegate is a belt-and-suspenders the runtime makes redundant.

Tear-down: `node close` cascade-cancels a node + its exclusive subtree WITHOUT finishing (revivable, nothing deleted); `node recycle` finishes the agent in your pane and reboots a fresh root in place; `canvas prune` deletes terminal nodes past a TTL.

## Revive & the daemon

A dormant node (done/idle/dead/canceled) is reopened with `canvas revive` (resumes the saved conversation, or `--fresh` to restart clean). `reviveNode()` is the **only** sanctioned launcher of `pi --session` — it sets `CRTR_NODE_ID` + canvas extensions and runs `transition('revive')`, keeping the db row and pi session in lockstep. Never spawn `pi --session` raw, and never open a node by spawning pi directly — UIs go through `node focus` / `canvas revive`.

The **daemon** (`crtrd`, managed via `canvas daemon start/stop/status`) is a thin supervisor: it polls pane + pi liveness ~every 2s and auto-revives nodes whose window exited. It does NOT host agents and does NOT auto-revive *canceled* nodes (reach for `canvas revive` for those). After rebuilding crouter's `dist/`, restart the daemon — it loads compiled code at start and never reloads it. Restarting is safe: it never signals running nodes.
