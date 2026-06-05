# personas/ — the system-prompt composer

Composes a node's **system-prompt prose** from markdown files keyed by kind×mode.
`resolve(kind, mode)` → `ResolvedPersona` (systemPrompt + extensions/skills/model/
lifecycle/tools pulled from frontmatter). Spawn/launch call this.

- **Name clash to keep straight:** this dir COMPOSES prose; `runtime/persona.ts`
  INJECTS transition guidance at turn boundaries. Unrelated jobs.
- `resolve` never throws on missing files — a missing persona falls back to
  sensible defaults so a node always boots.
- File resolution precedence: project > user > builtin (`src/builtin-personas`).
- An `orchestrator.md` must `@include orchestration-kernel.md` (inlined by the
  loader); if absent, resolve composes `base.md body + kernel`.
- Lifecycle default: base→terminal, orchestrator→resident.
