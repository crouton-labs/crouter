# Upstream want: system entries inside the messages array (pi-ai)

**Status:** blocked on upstream pi-ai. Captured 2026-06-08. Not actionable from crtr alone.

## The capability

Anthropic's Messages API now accepts `system`-role entries *inside* the `messages` array (not just the single top-level `system` param). Per the Opus 4.8 release notes: developers can update Claude's instructions mid-task **without breaking the prompt cache** and **without routing the update through a user turn**. The release calls out the agent-harness use case directly — update permissions, token budgets, or environment context as an agent runs.

## Why crtr cares

This is the ideal mechanism for our node-identity re-assertion and, more broadly, for any mid-run instruction change. Today the `<crtr-identity>` bearings block is injected as a pi `custom_message`, and `convertToLlm` (`pi-agent-core/.../harness/messages.js`) maps a `custom` message to **`role: "user"`** on the wire. So our identity assertion ships as a *user-role peer message* — another voice in the conversation arguing with the (forked) transcript, sitting awkwardly in the cached prefix region. An in-array system entry would be both **authoritative** (system voice over the transcript, not a peer) and **cache-safe**. That combination is exactly what killed the "put identity in the system layer" option (Option B in the identity-gating discussion): the only objection there was that mutating the top-level system prompt busts the cache. An in-array system entry sidesteps that — it reopens Option B as the clean design, and generalizes to mid-run permission / token-budget / env-context updates the Anthropic note describes.

## Why it's blocked

pi has no representation for it, at any layer:

- **pi-ai wire `Message` type** (`pi-ai/dist/types.d.ts`) is exactly `UserMessage | AssistantMessage | ToolResultMessage` — roles `user | assistant | toolResult` only. The system prompt is a separate single top-level field: `Context = { systemPrompt?: string; messages: Message[]; tools? }`. No `system` role exists inside `messages`.
- **The Anthropic provider** (`pi-ai/dist/providers/anthropic.js`) maps `context.systemPrompt` → the top-level `params.system` block, then walks `messages` emitting only user/assistant/toolResult. No code path emits an in-array system entry even though the API now accepts one.
- **The SDK** exposes only `systemPrompt` / `systemPromptOverride` (a single string), reinforcing the one-system-prompt-set-once model.

## What it would take

An upstream change in **pi-ai**: a new message kind that the Anthropic provider maps to an in-array `{ role: "system" }` entry, plus a harness path (and probably a `pi.sendMessage` shape / `deliverAs`) for crtr to emit one. Cannot be done from a crtr extension. If/when pi-ai adds it, revisit the identity-gating design — move concrete node identity into a system-layer entry and drop the conversation-level disown line entirely.
