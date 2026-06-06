# personas/ — the system-prompt composer

Composes a node's **system-prompt prose** from FOUR inputs:
`resolve(kind, mode, { lifecycle, hasManager })` → `ResolvedPersona`. The prompt is
`runtime-base.md` (lifecycle-neutral core) + spine fragment + lifecycle fragment +
`---` + the persona body (+ kernel for orchestrators). The body is `<kind>/PERSONA.md`
(mode `base`) or `<kind>/orchestrator.md` (mode `orchestrator`). Spawn/launch call
this via `buildLaunchSpec`.

- The kind×mode persona body is the ROLE (what this agent does); it is
  lifecycle-neutral — the finish/report contract lives in the fragments, NOT the
  body. Don't reintroduce `push final` into a `*/PERSONA.md` body.
- Each `<kind>/PERSONA.md` carries a `whenToUse:` frontmatter one-liner (the
  "when to use this node type" gloss) — `kindWhenToUse(kind)` reads it; it drives
  the dynamic `<kinds>` list in `node new -h` / `node promote -h`.
- **Sub-personas:** any descendant dir (any depth) under a top-level kind dir
  holding a `PERSONA.md` is a sub-persona reachable by its full kind string
  (e.g. `plan/reviewers/security`); dirs without a `PERSONA.md` (e.g.
  `reviewers/`) are transparent grouping namespaces. `subPersonasFor(kind)`
  enumerates the sub-personas AVAILABLE TO `kind` — its `availableTo` frontmatter
  (list of kind strings, or `"*"`/`"all"`), defaulting to its top-level ancestor
  kind — and `resolve` renders them into that kind's composed prompt (and
  nowhere else). Sub-personas never appear in `availableKinds()`.
- **lifecycle** (`terminal`/`resident`) selects `lifecycle/<lc>.md` — the "how you
  end" contract (push final + reap vs. dormant/wake). **spine** (`hasManager` ≡
  `parent !== null`) selects `spine/<has|no>-manager.md` — `has-manager` teaches
  the `push update/urgent`/escalate family; `no-manager` (a top-of-spine root)
  omits the push family entirely. Both are INPUTS the caller decides (root/child,
  terminal/resident) — NOT derived from frontmatter (the `lifecycle:` frontmatter
  key is now vestigial).
- The `lifecycle/*.md` fragments are the SINGLE source shared with
  `runtime/persona.ts`: baked into the static prompt here, and re-delivered as
  transition guidance there on a flip — so they can't drift.
- **Name clash to keep straight:** this dir COMPOSES prose; `runtime/persona.ts`
  INJECTS transition guidance at turn boundaries. Unrelated jobs.
- `resolve` never throws on missing files — a missing persona/fragment falls back
  to sensible defaults (empty fragment drops out) so a node always boots.
- File resolution precedence: project > user > builtin (`src/builtin-personas`).
- An `orchestrator.md` must `@include orchestration-kernel.md` (inlined by the
  loader); if absent, resolve composes `PERSONA.md body + kernel`.
