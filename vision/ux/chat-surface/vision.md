# Chat surface — the focus model

How a user watches and steers a graph of live agents, seeing only the nodes they
choose, while everything else keeps running off-screen.

## The problem

Every node on the canvas is a live pi process. To generate *interactively* —
steerable, streaming, accepting mid-turn input — a node's tmux pane has to be
genuinely open and attached to a real terminal. You cannot pause interactive
generation into a headless state and keep it responsive.

But the user does not want to watch all of them. The user wants to look at the few
nodes they are steering and trust the rest keep running off-screen.

## The core concept: focus

A **focus** is a viewport — one tmux pane, in a session the user works from — bound
to a single node. A node is **focused** when its pane is visible in such a pane.

Focus is neither global nor singular:
- There can be **many focuses at once.** A user can watch node A in one pane and
  node B in another, side by side. Each is its own focus.
- Focuses can span **multiple sessions.** The session a user runs crtr from is
  simply *a* session tied to focus; a user (or two) may hold focus panes in several
  sessions at once.
- Each focus shows **one node**; each node occupies **at most one focus** at a time.

"Focused" is therefore a property of the live arrangement — does this node currently
occupy some focus pane — not a single global pointer.

## The pane lifecycle rule

A node's tmux pane is **open only when it must be.**

> Invariant P — **A node's pane exists iff the node is focused OR actively
> generating.** Otherwise the pane is closed and the node is dormant.

Four cases fall out:
- **focused + generating** → open, in a focus pane (a user session).
- **focused + not generating** (parked at its prompt between turns, or revived only to be read) → kept present in its focus pane. A node that *finishes* while focused does not linger here — it hands its pane to its manager or reaps (see the hard case).
- **not focused + generating** → open, but off-screen in the backstage.
- **not focused + not generating** → closed; fully dormant.

## The backstage: the `crtr` session

There is a single dedicated tmux session — the **`crtr` session** — that is the
holding place for panes that *must be open* (their node is actively generating) but
are *not focused*. These windows are real and running; they are simply off-screen.
The user never has to look at the backstage but can switch to it to browse the whole
live graph.

The backstage holds only the *generating-but-unfocused*. A node that is neither
focused nor generating does not live here — it is closed.

## Retargeting a focus (the hot-swap)

When the user points an existing focus at a different node, that focus's pane keeps
its place on screen and only its **occupant** changes:
- the outgoing node is **evicted** — if it is still generating it moves to the
  backstage (stays open, off-screen); if it is not generating its pane closes and it
  goes dormant;
- the incoming node is brought in — if it is live in the backstage its pane is
  **swapped** into the focus; if it is dormant its session is **resumed in place**
  into the focus pane.

> Invariant F1 — **Stable focus viewport.** Retargeting a focus changes only what
> that one pane shows. It never opens, moves, or spawns an *unrelated* window.
> (Opening another focus is always an explicit user action — never a side effect.)
>
> Invariant F2 — **Hot-swap, no unbidden windows.** Retargeting swaps occupants; the
> outgoing node goes backstage (if generating) or dormant (if not). No window appears
> in a user's session except when the user explicitly asks for one.

## Opening another focus ("focus in new pane")

The user can open a **new focus pane** — a second (third, …) viewport — and point it
at a node. Now two nodes are focused at once, each in its own pane, both live in the
user's session(s). This is the deliberate way to watch several nodes simultaneously,
and it is the only way a new pane should ever appear.

> Invariant F4 — **Independent multiplicity.** Focuses are independent and may be
> many, across sessions. Each focus is owned by one node; each node occupies at most
> one focus. Creating a focus is always explicit.

## Demote and detach: ending or shelving a focused node

A node you are watching can be moved toward finishing in two deliberate steps, distinct in what they do to your viewport.

**Demote** turns an interactive node terminal *in place*: it keeps its pane and your focus, keeps running exactly where it is, but is now on a finishing track — it owes a final report up the spine and will end (then the hard case below applies). Demote changes only the node's disposition, never your viewport: nothing moves on screen.

**Detach** demotes *and* lets go: the node leaves your viewport for the backstage, where it keeps generating off-screen, now unfocused, and finishes on its own. This is the "I'm done watching this — let it run to completion without me" move; it frees the focus pane for whatever you point it at next.

> Invariant F5 — **Demote is viewport-neutral; detach is the deliberate let-go.** Putting a focused node on its finishing track never disturbs your viewport — the pane and focus stay exactly as they were. Sending it off-screen to finish on its own is a separate, explicit act that frees the pane and moves the node to the backstage, where it keeps running unfocused.

## The hard case: a focused node that finishes

A terminal node that finishes would normally go dormant — pi exits, pane closes. But a node can be **focused at the moment it finishes**, and the user must never be left staring at a dead pane or dropped onto an empty screen. What happens next is decided by one thing: does the finished node report to a **manager** (a node above it on the spine — the one it pushes its final up to)?

**With a manager — the focus follows the work upward.** The finished node hands its focus pane to its manager and its own pi ends. A manager live off-screen in the backstage is swapped into the pane; a dormant manager is woken — by the very final the finished node just pushed up — and resumes into the pane. Either way the user, who was steering the worker, is now steering the manager that received its result, in the same viewport, with no new window. The finished node is now unfocused and not generating, so it owns no pane (Invariant P); if its *own* children later push reports up to it, it wakes off-screen in the backstage, never unbidden in the user's session.

**With no manager — a top-level node is reaped.** A focused root that finishes has no successor to hand to: there is nothing left to steer there, so its focus closes and its pane reaps when its pi exits. The viewport is released, not frozen into a corpse.

> Invariant F3 — **A finished focused node hands its pane up the spine.** A node that finishes while focused never leaves a dead pane behind. With a manager, the manager takes over the same pane — swapped in if live, woken into it if dormant — and the finished node goes dormant in the backstage. With no manager, the focus closes and the pane reaps. The user always keeps steering the live frontier of the work, never a corpse, and no new window ever appears.

## What "good" feels like

- The user points focuses at nodes; each focus pane changes contents like flipping a
  channel. Nothing else on screen moves.
- Watching several nodes at once is just several focus panes, opened deliberately.
- Off-screen, the backstage hums with every generating-but-unfocused node. The user
  never sees it unless they go looking.
- A focused node can finish and hand its viewport up to the manager that receives its result — the user keeps steering the live frontier in the same pane, with no new window ever appearing unbidden.

## Anti-goals (the "broken" feel)

- **Unbidden windows** opening in a user's session — e.g. a background revive of a
  once-focused node new-windowing into the user's session. (This is the concrete bug
  this model exists to kill.)
- A focus viewport moving, splitting, or being replaced by a fresh empty window on a
  plain focus switch.
- A revived node appearing as a new window instead of resuming into its focus pane.
- The user being navigated *into* the backstage session instead of having the node
  brought to their focus.
- A node staying open in the backstage when it is neither focused nor generating (it
  should be dormant).
- A node that finishes while focused leaving a dead or frozen pane the user must clear by hand, instead of the manager taking over the pane (or the pane reaping when there is no manager).
