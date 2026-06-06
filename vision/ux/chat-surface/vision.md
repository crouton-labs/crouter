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
- **focused + not generating** (e.g. terminated while focused, awaiting children) →
  kept visibly present in its focus pane as a frozen/dormant pane, so it can resume
  in place (see the hard case).
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

## The hard case: a focused node that terminates

A terminal (base) node finishes its work and would normally go dormant — pi exits,
pane closes. But a node can be **focused at the moment it terminates**, with children
still working beneath it. Concretely: a node spawns a child, the child spawns its own
children, the user focuses that middle child. The middle child finishes and goes
dormant while its grandchildren keep running; when they finish they **push their
reports up** to the dormant middle node, which must be **woken** to absorb them.

The user was *looking at* that middle node. It must not vanish, and on wake it must
not pop open somewhere new.

> Invariant F3 — **Seamless resume into the focus.** A node that terminates while
> focused stays present in its focus pane (a frozen pane showing its last state) and,
> when later revived — including by the autonomous wake when its children push reports
> up — resumes **into that same pane.** No new window. To the user it looks like the
> pane was there the whole time; the node simply starts talking again.

## What "good" feels like

- The user points focuses at nodes; each focus pane changes contents like flipping a
  channel. Nothing else on screen moves.
- Watching several nodes at once is just several focus panes, opened deliberately.
- Off-screen, the backstage hums with every generating-but-unfocused node. The user
  never sees it unless they go looking.
- A focused node can finish, hand off to its children, and later wake to absorb their
  results — in the same pane, with no new window ever appearing unbidden.

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
