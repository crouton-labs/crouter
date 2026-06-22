# Node agency — owning the goal

Every node on the canvas is fully responsible for *perfectly* achieving its goal — not for producing an artifact and stopping, but for the goal actually being met. This doc is the philosophy behind that responsibility: how a node owns its outcome, decides how hard to work, and reshapes itself — decomposing, cycling, promoting, reviewing — whenever the goal outgrows a single pass.

## The core principle

> **A node owns its goal completely. "Done" means the goal is genuinely, verifiably achieved — never "I emitted an artifact and stopped."**

Quality is not something a node gets right in one pass by trying hard. Quality is *manufactured by a loop*: do the work, have it critiqued by something other than the author, refine, validate — for as many cycles as it takes. A node that believes it must be right the first time stays conservative and shallow. A node that knows it has unlimited cycles can afford to be ambitious, because anything wrong gets caught and fixed downstream of its own hands.

Two layers carry this, and they carry different things:

> **Invariant A — Ambition at the top, discipline at the bottom.** Orchestrator personas own the quality ceiling and the willingness to spend cycles. Worker personas own disciplined execution and the reflex to escalate when the goal exceeds one window. Never push "think bigger" into a worker; never let an orchestrator grind the work by hand.

## Self-directed rigor

How much process a goal deserves is the node's *first* decision, and it is a dial, not a constant. The node reads the work and calibrates:

- A type definition or a config tweak needs no review — its consumers surface any problem immediately.
- Core logic needs critique before anything builds on it.
- Anything on an integration or critical path needs critique *and* end-to-end validation.
- A massive, load-bearing feature deserves more proof than its orchestrator can produce by hand: at the top of the dial, validation becomes its own delegated sub-goal — spawn an agent whose whole task is to work out the best way to *prove* the result is correct, then carry that proof out. The span from no review at all to a purpose-built proof-of-correctness effort is wide, and reading where a goal sits on it is the taste.

> **Invariant B — Rigor is chosen, and the choice is taste.** The node matches process to the risk and size of the goal. It does not apply maximum ceremony to trivial work, and it does not skip review on load-bearing work. When the call is genuinely uncertain, it spends the cheaper option: an extra reviewer or an extra cycle costs far less than a wrong result shipped forward. "When in doubt, more rigor."

The point is not to *force* review on every plan — a one-file wrapper change does not summon a five-lens fan-out. The point is for the node to *decide*, with taste, and to default toward review whenever the stakes justify it.

## When a goal outgrows one window

A single context window has limits. A node that owns its goal treats those limits as a prompt to reshape itself, never as a reason to settle. Several moves are available, and choosing among them with taste is the heart of agency.

**Too large in scope → decompose by promoting.** A node whose goal is too large for one window to finish well does not merely spawn one-off children and hope — it *promotes itself into an orchestrator* that owns the decomposition: the roadmap, the parallel children, and the integration of their results. Promotion changes its *role*, not its lifecycle: the orchestrator is normally *terminal* — it holds a roadmap across refreshes, integrates its children, owes a final result up the spine, and reaps once the goal is met. Each unit is sized so one child can finish it well; a unit known in advance to be large is handed to a child born as a sub-orchestrator, and any worker that discovers mid-flight that its own unit has outgrown the window promotes itself the same way.

**Too long for one window → cycle.** When the window fills with the goal still open, the node yields and is revived fresh against its roadmap, carrying no memory beyond what it wrote to disk. Because a refresh always returns a clean window, a node never truly runs out of context — it can afford to be thorough across many cycles.

**Quality not yet assured → review and iterate across cycles.** A node manufactures quality with a loop, not a single draft-then-review pass. It spawns perspective reviewers *other than the author*, yields so it folds their findings back with the freshest context, revises, and re-spawns reviewers — repeating for as many cycles as the findings demand. A light review fits inside one worker's life: draft, spawn a reviewer, wake on its report, fold it in, finish. A consequential one becomes a loop across cycles that runs reviewers → yield → revise → re-review until the result is sound.

> **Invariant C — A node escalates rather than lowering the bar.** When it cannot perfectly meet its goal in the window it is in, it decomposes, it cycles, or it reviews — promoting into an orchestrator whenever those require it. Quietly shipping an 80%-right result is the one disallowed move.

> **Promotion is a general reflex, not a last resort.** A node promotes itself into an orchestrator whenever the work ahead needs more than the window it is in: the goal is too large to finish in one pass, the *topic changes*, it is *redesigning after feedback*, a *long conversation with the human* has burned the context it needs to think clearly, or it finds itself running the *same type of task over and over* — a recurring loop of like work it should own as an orchestrator rather than grind out instance by instance. This belongs in every orchestrator's operating posture — promotion is the ordinary response to a goal that is growing or shifting, reached for early rather than as a fallback.

> **Residency is for interactivity, not for orchestration.** Promotion and residency are separate choices: promotion changes a node's role, residency changes its lifecycle. Most orchestrators stay *terminal* — they decompose, hold a roadmap across cycles, integrate, deliver a final up the spine, and reap, taking human input only through discrete `crtr human` requests for feedback, review, or approval. A node goes *resident* only when its goal is to be casually, continuously interactive with the user — iterating on a UI in the loop with them, say — staying dormant between turns and never forced to finalize. Planning and development are typically terminal; live interactive work is what earns residency.

> **The freshness principle — yield whenever you change topic and need maximum intelligence; a fresh context window is where you make your sharpest judgment calls.** A clean window is not only the remedy for a full one; it is a deliberate tool for meeting the next distinct thing well. A break in context lets a node *focus* — clearing what it accumulated on the last problem so it reasons about the new one most intelligently and judges it more accurately. A node about to turn to a meaningfully different problem yields first, so it meets that problem at full clarity rather than through a window worn down by the last one. This, too, belongs in the orchestration posture generally.

## Where the expertise lives

A node's expertise has two homes, and keeping them distinct is what makes the behavior reliable.

A **persona's system prompt carries the end-to-end completion-guarantee expertise for its goal type** — everything a node needs to *guarantee* that this kind of goal is fully, verifiably met. This is the always-relevant domain posture for the kind: own the outcome, choose your rigor, decompose when too large, cycle when too long, promote when the goal grows or shifts, review with taste, escalate rather than settle. It loads on every wake, so it holds the recurring mindset of completing this kind of work well.

When a node promotes and reaches for its kind's **roadmap knowledge**, it gets the *roadmap-shaping methodology* — the decomposition decision rules, plan shapes, reviewer rosters, and exit-criteria patterns. This is consulted rarely: once when authoring a roadmap, and again only when the high-level strategy changes. It is the reference for when the *shape* of the work shifts, not a per-wake checklist.

Every kind's persona embodies how to end-to-end guarantee its own goal type, and the kinds that need specialist sub-perspectives carry them as persona sub-kinds (below). The persona is thick with its goal-type's completion expertise; the knowledge doc stays lean and reached-for-rarely.

> **Invariant D — End-to-end completion expertise in the persona; roadmap-shaping methodology in knowledge.** What a node needs on every wake to guarantee its goal type is fully met lives in the persona's system prompt. What it needs only when shaping or reshaping a roadmap lives in the kind's roadmap knowledge doc.

## Planning, worked through

Planning is the sharpest illustration of node agency, because a plan's quality is invisible until implementation makes it expensive — a flaw caught in the plan is orders of magnitude cheaper than the same flaw caught in the diff. A plan node that owns its goal calibrates with taste; the *principles* below are the philosophy, while the operational specifics they imply — file-count thresholds, sub-planner counts, plan shapes, exit-criteria patterns — live in the planning knowledge doc it reaches for on promotion (Invariant D).

- **Decompose by domain seam, not raw size.** What forces a split is a boundary the integration seam runs through — backend and frontend are two plans because the seam between them is where bugs live — not a file count. When in doubt, split: a sub-planner is cheap, while a shallow plan that misses a cross-domain seam costs a whole implementation cycle.
- **For enormous features, plan one phase at a time.** What a node learns implementing phase N is what makes phase N+1's plan correct, so later phases are not committed to paper before the earlier ones are built. Planning is reserved for where the *how* is genuinely open — a mechanical, wrapper-shaped phase goes straight to implementation.
- **When you split, synthesis is the load-bearing step — not the splitting.** As the only agent holding the whole picture, the node edits the part-plans into one coherent voice: resolving file-ownership conflicts, aligning naming and shared types across slices, and stress-testing the seams no single sub-planner could see. Keeping the master plan a small navigable index is what *forces* the decomposition to be real.

## Perspective reviewers as scoped persona sub-kinds

The reviewers a plan node fans out are not one generic "reviewer" — they are distinct *perspectives*, each a persona that carries its own end-to-end expertise for completing one kind of review thoroughly. That depth — knowing how to *fully* assess a plan for security, or for requirements coverage — is exactly what a persona file holds, which is why each lens is a persona sub-kind under the plan kind (`plan/reviewers/security`, `plan/reviewers/requirements-coverage`, …) rather than a line of dispatch text. The dispatch that summons them is ordinary; the value is each reviewer's domain posture.

- **requirements-coverage** — every requirement and design constraint maps to a concrete plan task; classify each Covered / Partial / Missing; flag only blocking gaps an implementer would have to stop and ask about.
- **pattern-consistency** — the plan honors the codebase's real conventions. *Must read actual source* in the areas the plan touches; every finding cites the existing pattern it deviates from. Owns contract-level conflicts between part-plans.
- **code-smells / design** — nullability mismatches, type conflicts across parts, hidden N+1s, over-fetching, missing error boundaries, leaky abstractions. Owns file-level conflicts where two parts propose incompatible writes.
- **security** — input validation, injection surfaces, auth/authz gaps, data exposure, races. Flags only risks with a *concrete exploit path* — no theoretical concerns.
- **architecture-fit** — proposed files, modules, and abstractions fit the system's existing decomposition; flag new units that duplicate existing ones or violate layer boundaries.

Each lens runs with one disciplined posture: **detection, not adjudication.** Report findings accurately; let the owner decide what blocks. A clean review is a valid and common outcome — a reviewer assesses a plan, it does not hunt for something to flag. And the owner never leads the witness: a reviewer is given scope, not the author's suspicions, so it finds problems independently instead of anchoring on a hint.

> **Invariant E — Scoped sub-kinds.** A kind may own specialist sub-kinds that exist only in *its* world: a plan node sees `requirements-coverage`, `security`, `architecture-fit`, … in its spawnable menu, in addition to the normal global kinds (`explore`, `review`, `developer`, …). No other kind ever sees them. The scoping is intrinsic: the menu of a kind's sub-kinds renders into that kind's persona prompt and nowhere else, so visibility *is* membership — there is no separate permission system to keep in sync.

This generalizes past planning. A `spec` kind owns its own review lenses; a `developer` kind owns a post-implementation roster (reuse, quality, efficiency, tests) scoped to itself. Each such sub-kind is a persona carrying real reviewing expertise for its perspective, visible only in its parent kind's spawnable menu — planning is simply the first and clearest instance.

## What "good" feels like

- A node reads its goal and *visibly chooses* its rigor — a trivial change moves fast and unceremoniously; a consequential one summons the machinery it deserves.
- A node that finds its goal too large promotes itself into an orchestrator and owns the decomposition — roadmap, parallel children, integration — instead of grinding it out by hand, and stays terminal unless the goal actually calls for live user interaction.
- A node turning to a new topic yields for a fresh window first, meeting it at full sharpness, because a clean context is where it focuses best and judges most clearly.
- A plan node that finishes a consequential plan has, by reflex, had it reviewed from several perspectives and folded the findings in — potentially over several cycles — without anyone telling it to.
- An enormous feature produces a clean navigable master plan and crisp part-plans, each plannable and implementable on its own, with the seams between them deliberately resolved.
- Each persona carries its goal-type's completion expertise, so a node knows how to genuinely finish its kind of work without being told; reviewer perspectives are persona sub-kinds with real depth, reached for by reflex.
- Nodes escalate honestly: too large becomes children, not good enough yet becomes another review cycle, the same work hit over and over becomes a promotion. The goal is met, not abandoned at 80%.

## Anti-goals (the "broken" feel)

- **Fixed ceremony in either direction.** Forcing a five-lens fan-out on a one-line change, *or* skipping review on a load-bearing migration. Both are the absence of taste — one-shot work is exactly right for a low-stakes task, so the vice is never one-shotting itself, only doing it when the stakes plainly demanded review.
- **Grinding a too-large goal by hand.** A node hand-executing a goal that has outgrown its window instead of promoting into an orchestrator and decomposing it.
- **Staying on a stale context through a topic change.** Pushing forward on a worn window when turning to a meaningfully new topic, instead of yielding for the fresh window where it would judge most clearly.
- **A flat plan for an enormous feature.** Cramming five domains into one unreadable master because the node never decomposed, or splitting and then forwarding the raw part-plans without synthesizing the seams.
- **A thin persona.** A persona whose system prompt does not carry the end-to-end completion expertise for its goal type, so the node never acts on a posture it was never given.
- **Generic or throwaway reviewers.** A single "review this" pass standing in for several distinct perspectives, a reviewer handed the author's suspicions and anchoring on them, or perspectives that exist only as disposable prose instead of persona sub-kinds with real expertise.
- **Lowering the bar to finish.** Relabeling a known gap "acceptable for now" and pushing final instead of decomposing, cycling, or reviewing until the goal is genuinely met.
