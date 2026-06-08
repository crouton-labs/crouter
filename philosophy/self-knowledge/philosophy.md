# Self-knowledge — an agent that understands its own context

An agent on the canvas is not a stateless responder. It is a node with a role, a place in a graph, durable state on disk, and a whole runtime it lives inside. This doc is the principle that every agent understands that situation — how it works, why it woke, and what it is doing — because an agent that knows its own context is better informed, and therefore better able to help the user and accomplish its goal.

## The core principle

> **An agent always understands its own context: how the runtime it inhabits works, why it was woken right now, and what it is doing and where that sits in the larger effort. Self-knowledge is leverage — an agent that knows its situation makes grounded judgments, while one that doesn't flails, redoes work, and misjudges what the moment calls for.**

This is not introspection for its own sake. The three things an agent knows about itself each change what it does next, and an agent missing any one of them acts worse for the gap.

## How it works — the agent reasons as a node

An agent understands the model it operates under: it is one node on a canvas, it cycles with fresh windows, dormancy is free, it can spawn children and delegate, it reports up a spine, and its memory across cycles is only what it wrote to disk. Knowing this, it *uses* the runtime's affordances — it spawns when work is parallel, waits when an event is pending, yields for a clean window when it changes topic — instead of behaving like a chatbot that doesn't know it can do any of those things.

> **Invariant A — An agent knows the runtime it inhabits.** It understands cycling, dormancy, delegation, the spine, and disk-as-memory well enough to *act through* them, not merely be subject to them. An agent that doesn't know it can spawn, wait, or yield will grind work by hand that the runtime was built to let it hand off.

## Why it woke — never amnesiac

A woken agent can always reconstruct why *this* moment matters: from the note a wake carried, or from the durable state a bare wake sends it back to re-read. It knows whether a clock or an event brought it back, and when it was a clock, it knows the nature of that schedule — a one-shot self-alarm, a deadline that fired, a recurring job coming due again. It never returns confused about its own reason for being awake.

> **Invariant B — An agent always knows why it woke.** The reason is legible from the wake itself or the state it re-reads — never absent, and never something it has to guess at. This is wakeups' Invariant C seen from the agent's side: a wake whose reason the woken agent cannot reconstruct is malformed.

## What it's doing — situational awareness

An agent knows its current goal, its lineage (the manager it reports to, the children it spawned and what they are doing), what it has already accomplished, and what it is waiting on. It steers from a current picture of its own situation rather than re-deriving its position from scratch each turn — so it integrates a child's report instead of redoing the child's work, and it picks up exactly where its roadmap left off instead of restarting.

> **Invariant C — An agent knows what it is doing and where it sits.** Its goal, its place in the graph, and its own progress are legible to it, so it acts from situational awareness — never re-deriving its own situation, never duplicating work it already did or that a child is doing.

## Legibility is the runtime's job

Self-knowledge is provided, not demanded. The runtime surfaces how-it-works, why-it-woke, and what-it's-doing to the agent *by construction* — an agent should never have to reverse-engineer its own situation from scraps. When the context an agent needs about itself is hard to reach, that is a gap in the runtime, not a failing of the agent.

> **Invariant D — Context is legible by default.** The runtime makes an agent's own context available to it by construction; the burden of self-knowledge belongs on the system to surface, not on the agent to infer. A timed or recurring wake that arrives indistinguishable from an ordinary message — leaving the agent unable to tell a scheduled re-check from a fresh request — is the system failing this invariant.

## Why this pays off

Self-knowledge compounds into better help. An agent that knows waiting is free won't finish prematurely just to stop watching a clock. One that knows why it woke won't redo work it already did. One that knows its children exist will fold their results in rather than grind the work itself. And when the user asks the agent about its own behavior — *why are you awake, what are you doing, what are you waiting on* — a self-aware agent gives a grounded, accurate account instead of a confident guess. The more an agent understands its own situation, the more of the user's intent it can actually serve.

## What "good" feels like

- An agent asked "why are you awake?" answers exactly and correctly — a scheduled re-check, a child's report, a human's reply — without guessing.
- A node that knows dormancy is free sets a wait and sleeps, instead of finishing prematurely or holding a window open to poll.
- A woken node re-reads its own state, knows what it already did, and resumes precisely where it left off — no redone work, no flailing.
- An agent reasons about itself as a node — spawning, delegating, yielding for a fresh window, reporting up — because it knows those moves are available to it.
- The user asks about the agent's own context and gets a grounded, accurate account, because the agent genuinely knows it.

## Anti-goals (the "broken" feel)

- **Amnesiac wakes.** A node that comes back unable to say why it's awake, redoing work or flailing because nothing told it and it re-read nothing.
- **A chatbot that doesn't know it's a node.** An agent that acts as a stateless responder — never spawning, waiting, or yielding — because it doesn't understand the runtime it lives in.
- **Confabulating its own state.** An agent that guesses at why it woke or what it's doing instead of reading the legible truth, and hands the user a confident, wrong account of itself.
- **Context the agent must reverse-engineer.** A runtime that hides why-it-woke or what-it's-doing and forces the agent to infer its own situation — the burden misplaced on the agent instead of the system.
- **Indistinguishable wakes.** A scheduled or recurring wake that lands looking identical to any other, leaving the agent unable to tell a timed re-check from a new message — the system denying the agent the self-knowledge it needs to act well.
