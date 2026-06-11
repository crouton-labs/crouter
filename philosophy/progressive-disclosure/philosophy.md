# Progressive disclosure — a document declares how much of itself enters context

Every piece of knowledge an agent can draw on — something it consults or a preference it embodies — is one document, and that document decides how much of itself an agent sees, and when. This doc is the philosophy behind that decision: all agent knowledge lives in a single substrate, and each document chooses the smallest amount of itself that enters an agent's context to do its job, disclosing more only when the work reaches for it. Progressive disclosure is the organizing principle — context is the scarce resource, and every document pays its own way into it.

## The core principle

> **One substrate holds all agent knowledge, and each document declares how much of itself surfaces, and where. It claims the lowest rung of visibility that still lets the work find it, and earns a higher one only by paying its way. Context is precious; knowledge is cheap to keep and cheap to ignore until it is needed.**

A document that costs nothing until it is needed can be written down the moment it is worth keeping. That is the point: an agent learns constantly, and the cost of what it learns should be paid only when it is relevant. The substrate makes "write it down" and "bound what it costs" the same act, so knowledge accumulates without context bloating — clean by construction, not by an agent's restraint.

## One substrate, not six

There is one kind of thing here: a document — markdown carrying a small declaration of how it loads. What were once six separate notions — a memory, a skill, a doc, a directive, a rule, a note — are one substrate with a kind and a loading policy. They were never six subsystems with six stores, six loaders, and six commands; they are one configurable system, and collapsing them is the deletion-positive heart of this design. Fewer concepts, one mental model, one authoring flow, one path that resolves them all.

Knowledge that is the agent's to keep — held independent of any one conversation — falls into exactly two kinds, split on how an agent *uses* it: **knowledge** is anything the agent *consults* (how to do something, how something works, what is true), and a **preference** is how the agent should *behave* (a standing directive it embodies rather than looks up). The load-bearing split is consult-vs-behave — the one distinction that changes a default rung, an injection point, or an update rule; the older procedural/referential line inside "consult" was about a document's content, not its use, so it forked no behavior and folds into knowledge.

> **Invariant A — One substrate, one schema, one resolution path.** All agent knowledge is one kind of document, distinguished only by which of the two kinds it is — data, not a fork in the machine. There is one way to author it, one way to resolve it, one way to read it; no knowledge type carries its own parallel subsystem.

## The visibility ladder

Disclosure runs on one ladder of four rungs, each a strict superset of the one before it:

- **none** — invisible; the document does not enter context on its own, and is found only when an agent goes looking for it.
- **name** — the agent learns the document exists and how to pull it: its title, and enough to route to it.
- **preview** — a short routing line surfaces: when this matters, and what reading it buys.
- **content** — the full body enters context inline.

The same ladder is applied at two independent surfaces. One is **boot**: how much of the document enters an agent's context when it starts. The other is **on-read**: how much surfaces when an agent reads a file the document sits beside. A document sets each surface separately — it can be a bare name at boot and full content the moment its neighboring code is touched, or a routing line at boot and invisible on-read. Visibility is not one global setting per document; it is two dials on one ladder, each tuned to the moment it governs.

The preview rung is the hinge of the whole model. It is a routing line, not a summary — it tells an agent precisely whether to spend the next, larger read, and nothing more. It costs almost nothing in context and buys the most important thing: an accurate decision about whether to disclose further. A preview that tried to *stand in* for the body would defeat itself (see the satisficing rule); a preview that honestly routes to the body is what lets most knowledge stay cheap.

> **Invariant B — One ladder, two surfaces.** Disclosure is a single monotone ladder — none → name → preview → content — applied independently at the two surfaces, boot and on-read. Each rung discloses a strict superset of the one below it, and a document sets its rung at each surface on its own.

## Satisficing — the lowest rung that does the job

Context is the scarce resource, so the governing discipline is to occupy the lowest rung that still does the job. Most knowledge sits at the name rung or below at boot — present enough to be discoverable, absent enough to cost nothing — and discloses further only when the work reaches for it. A document earns a higher rung the way anything earns a scarce resource: by paying its way. Full content at boot is for the rare document an agent genuinely needs on every wake; a routing line at boot is for one it should merely be reminded exists; everything else stays invisible until something asks for it.

This is also why the ladder has no "just the summary" rung between preview and content. An agent handed an abbreviation of a document satisfices — it believes it now has enough and never reads the body — so a digest dropped into context is worse than none: it silently suppresses the full read it was meant to invite. The preview rung is safe precisely because it does not pretend to be the content; it points at it. Disclosure to an agent is name → preview → the whole thing, never a summary standing in for the real read.

> **Invariant C — The lowest rung that does the job.** A document occupies the least visibility that still lets the work find it when it matters, and earns more only by proving it pays its way. Context spent on knowledge the current work does not need is the cost this principle exists to refuse.

## The document owns its own disclosure

The policy for surfacing a document lives in the document, beside the knowledge it governs — not in a separate system deciding what to inject. Authoring a piece of knowledge and declaring how it loads are one act: the same hand that writes the body sets its rungs. There is no central injector with its own model of what every agent should see; each document carries its own answer, and the runtime simply honors it. This is what keeps the substrate coherent as it grows — a thousand documents need no central registry of who-sees-what, because each one already knows.

> **Invariant D — Disclosure policy lives in the document.** A document declares its own visibility, beside its content; nothing external decides what to inject. Writing the knowledge and bounding its cost are the same act, performed by the same author.

## Disclosure is contextual, not global

Disclosure is conditioned on who is asking and where. A document can be gated on the node it would load into — its kind, its mode, how deep in an orchestration it sits, where it is working — so a document surfaces only for the work it actually serves. A bigger, scaled-up effort looks at more avenues than a small one, and that falls straight out as a condition over the work's own shape rather than a special mechanism: loading scales with the work. Every document also resolves by scope — project knowledge overrides user knowledge overrides what ships built in — and the unit of scope is any directory that declares itself a workspace, so the knowledge an agent sees is the knowledge of where it is working. The on-read surface is positional by nature: a document sits beside the thing it explains and surfaces when that thing is touched. Disclosure is always answered for this node, in this place, doing this work — never one global setting every agent receives identically.

> **Invariant E — Disclosure is per-node and per-place.** A document's eligibility is conditioned on the node it would load into and resolved by scope precedence. Disclosure is contextual — answered for the specific agent and the specific workspace — never a single global injection every agent receives the same.

## The substrate improves itself

The substrate is writable by the agents that use it. Because every document bounds its own cost, an agent can write knowledge down as freely as a thought is worth keeping — the fear that recording something will bloat every future context is gone, since the document itself declares how little of it surfaces, and when. Knowledge that proves its worth gets written; knowledge that proves more valuable than its rung climbs to a higher one; knowledge that earns its keep gets refined. This is self-improving prompting and progressive disclosure made into storage: an agent keeps learning, writes what it learns back into the substrate, and the cost of that learning is paid only when it is relevant. The store of knowledge and the agents that use it are one loop.

> **Invariant F — The substrate is writable by its users.** Agents author and refine the documents they load. Because each document declares its own cost, writing knowledge down and bounding what it costs are the same act — so the substrate is safe to grow constantly, and knowledge that proves its worth is re-tiered rather than lost.

## What "good" feels like

- One mental model for all of it: an agent reaches for "a document," not for a memory versus a skill versus a rule — same authoring, same resolution, same read.
- Boot is light. An agent starts with a compact catalog of what exists and a handful of routing lines, not a wall of bodies — it knows what it can pull, and pulls only what the work needs.
- A reference sits next to the code it explains and says nothing until that code is touched, then surfaces exactly the pointer that saves the next agent an hour.
- An agent decides whether to spend a read from a single accurate routing line, and is right — because the preview routes honestly instead of pretending to be the content.
- A bigger effort surfaces more avenues than a small one, automatically, because disclosure reads the shape of the work rather than treating every agent the same.
- An agent writes down what it just learned without a second thought about context cost, because the document it writes already declares how little of itself will ever surface uninvited.
- Knowledge that keeps proving useful climbs to a higher rung; knowledge that was over-eager drops to a lower one — the substrate tunes itself toward paying its way.

## Anti-goals (the "broken" feel)

- **Six subsystems wearing one coat.** Separate stores, loaders, and commands for memories, skills, docs, directives, rules, and notes — six mental models where one belongs, and six places to look for the same kind of thing.
- **Everything at boot.** Loading full bodies into every agent's starting context "so it's there if needed," drowning the work in knowledge it does not need and spending the scarce resource for nothing.
- **A summary that stands in for the read.** A digest rung that lets an agent satisfice — believing it has enough and never opening the body — so the abbreviation silently suppresses the real disclosure it was meant to invite.
- **A central injector deciding what every agent sees.** Disclosure policy held apart from the knowledge, in one system's model of who-should-see-what, instead of each document carrying its own answer — a registry that rots the moment the knowledge outgrows it.
- **Global, context-blind visibility.** A document that surfaces the same way for every node regardless of kind, depth, scope, or place — the same wall of context for a one-file errand and a massive orchestration.
- **Knowledge left unwritten for fear of cost.** An agent that declines to record what it learned because writing it down would bloat future prompts — the exact fear the substrate is built to remove.
