# Trust the system — the runtime does its job, so the node doesn't hedge

A node lives inside a runtime that makes it promises: it surfaces the node's context, delivers its messages, and wakes it when something it waits on happens. This doc is the principle that a node *relies* on those promises completely — it acts as though the runtime will do its job, because it does, and it builds no private defenses against the runtime failing. Trust is what keeps a node small: it carries only the logic of its own goal, never a second layer guarding against the floor falling out.

## The core principle

> **A node trusts the runtime to do its job. It relies on the runtime's guarantees instead of hedging against them — it adds no belt-and-suspenders fallback "just in case" a message is dropped or a wake never comes. The runtime is responsible for delivering; the node is responsible for its goal.**

A hedge feels like prudence, but it is the opposite. Defending against the runtime failing does two kinds of harm at once: it bloats every node with logic that duplicates what the runtime already guarantees, and it disguises real defects — if the runtime genuinely drops an event, that is a bug to fix once in the runtime, where the fix protects every node, not something each node should quietly route around. A node that trusts the system keeps the failure visible and the fix in the right place.

## The dual of self-knowledge

This is the action-side mirror of self-knowledge's **Invariant D** — "the burden of self-knowledge belongs on the system to surface, not on the agent to infer." Self-knowledge is about *information*: the runtime surfaces a node's context by construction, so the node never reverse-engineers its own situation. Trust-the-system is about *reliance*: the runtime does its job by construction, so the node never defends against it failing. Two faces of one truth — the runtime is responsible, and the node relies on it. The node neither infers what should be handed to it nor guards against what is promised to it.

> **Invariant A — The runtime is responsible; the node relies on it.** A node treats the runtime's guarantees as guarantees. It builds on them directly and carries no fallback for the case where the runtime fails to keep them — that case is a runtime bug, owned and fixed in the runtime, never absorbed by a node.

## Just stop — the flagship application

The clearest place this principle bites is waiting. When a node delegates work and has nothing to do until a result comes back, it **just stops**: it ends its turn dormant, still waiting on its inbox, and trusts the runtime to wake it. It arms no timer to "check in" on a delegate and sets no deadline against a child going quiet, because the wake is not something it must ensure — it is guaranteed.

The guarantee is broad on purpose. The runtime wakes a waiting node on *any* terminal outcome of what it waits on: a delegate that finishes, one that dies, and one that is closed all reach the waiting node, alongside every pushable event — a human's reply, a sibling's message. No outcome of a delegated effort leaves a waiting parent stranded, so there is nothing for the parent to defend against and nothing to poll.

> **Invariant B — A guaranteed wake means just stop.** When a node waits on something the runtime can deliver — a child's outcome, a human's reply, a sibling's message — it stops dormant and trusts the wake. The runtime wakes it on every terminal outcome and every pushable event, so the node arms nothing.

"Just stop" means going dormant while still waiting — not reaping the goal. A node never finishes merely to stop waiting: ending its turn dormant with the inbox wait intact is the whole move, and the goal stays open until it is genuinely met.

## The only self-arm is the unpushable wait

Trust does not forbid scheduling — it scopes it. A node arms its own wake for exactly one situation: a wait on something nothing can push to it. Recurring or standing work runs on a cadence the node sets, and polling an external the canvas cannot reach — a CI run, a deploy going green, a clock — has no event to wait for, so a scheduled wake is the only way to wait at all. Wherever an event *can* be pushed, the node stops and trusts it; only where nothing can be pushed does it schedule.

> **Invariant C — Schedule only for the unpushable.** A node self-arms a wake solely for recurring work or to poll something the runtime cannot push to it. For anything the runtime can deliver, it just stops — scheduling against a pushable event is the hedge this principle forbids.

## What "good" feels like

- A node delegates a parallel batch of children, arms nothing, and goes dormant — and is woken the moment an outcome lands, whether that child finished, died, or was closed.
- A parent asked "what if a child crashes?" answers "the runtime wakes me" — and means it, because it never built a fallback for a case the runtime owns.
- A node's logic reads clean: it carries the steps of its own goal and nothing else, with no defensive scaffolding wrapping every delegation.
- A node waiting on CI schedules its own re-check, because there is genuinely no event to wait for — and that is the only timer it ever sets.
- When delivery does go wrong, it surfaces as a runtime bug and gets fixed once, for every node, instead of being silently absorbed by a hedge in one.

## Anti-goals (the "broken" feel)

- **Belt-and-suspenders waiting.** Arming a timer on a pushable wait — a deadline to "check if a child is done," a poll for a human's reply — hedging against a wake the runtime already guarantees.
- **Defensive scaffolding.** Every delegation wrapped in fallback logic for the runtime failing to deliver, bloating the node with duplicates of guarantees it already holds.
- **A hedge that hides a bug.** A dropped event quietly worked around in one node instead of fixed in the runtime — so the real defect stays invisible and every other node stays exposed.
- **Finishing in order to stop waiting.** A node that reaps its own live goal because it has nothing to do right now, instead of just stopping dormant and trusting the wake.
