---
kind: knowledge
when-and-why-to-read: When picking up crtr boot/startup-latency work or scoping
  a Go/Rust/Zig rewrite, this reference should be read because it records the
  open optimization TODOs and the native-rewrite analysis.
short-form: "TODO: crtr boot-latency wins (esbuild bundle, daemon-routed
  subcommands, Bun) + likely native (Go/Rust/Zig) dispatcher rewrite"
system-prompt-visibility: preview
file-read-visibility: none
---

Open TODO: further crtr startup-latency reductions, and scoping a likely native-language rewrite of the crtr CLI/plumbing.

## Already done (2026-06, committed)
Cold `crtr` boot went ~8.5s → ~0.65s by killing per-boot subprocess spawns, not by any language change:
- The one-way Claude→crtr bridge (`pi-personal-extensions/lib/crtr-bridge.ts` `buildCrtrBridge`, the `crtr pkg bridge sync` command) used to spawn once per Claude skill source, sequentially (~0.5s each, ~7s for ~13 sources) on EVERY pi `session_start` via `claude-plugin-commands` `resources_discover`. It was fingerprint-gated, then removed entirely; the later bidirectional `SKILL.md` bridge was replaced with an explicit one-shot `crtr sys sync` converter that imports legacy bundles into memory docs on demand. The per-boot spawn-storm source is gone, not merely gated.
- `crouter/src/core/runtime/broker-sdk.ts` `assertEngineVersion`: cached the `pi --version` probe (`~/.crouter/canvas/pi-version.json`, keyed on binary path+mtime+size). ~440ms → ~0ms.
- `pi-personal-extensions/extensions/crouter-help.ts`: the 15s TTL `crtr -h` cache was in-memory only (useless across fresh broker processes); now disk-backed + cwd-keyed. ~540ms → ~0ms warm.

## Open TODO — incremental wins (cheap, do regardless of a rewrite)
1. **Bundle crtr with esbuild** (highest ROI, days). Measured: ~470ms of every cold `crtr` invocation is just loading crtr's own ESM module graph (vs ~50ms Node baseline, ~40ms actual command work). Bundling to a single file (as `capture/` already does: `esbuild → bin/capture`) should cut that ~470ms to ~150–200ms.
2. **Route hot/read-only subcommands through `crtrd`** instead of cold-booting the CLI per call — a thin socket protocol on the existing daemon → ~15ms round-trip vs ~550ms boot.
3. **Bun instead of Node** for the CLI runtime — ~2–3× faster cold start, near-zero migration (same JS).

## Native rewrite (Go/Rust/Zig) — LIKELY direction; scope it right
Leaning toward doing this. What it buys and what it does NOT, so the scope is set correctly going in:
- **Buys: ~40× on CLI dispatch.** ~85% of a cold `crtr` call (~470ms of ~550ms) is loading the JS module graph; a native binary has no module-load phase and starts in ~5–15ms. Also lower memory + a faster `crtrd` supervisor. This is the real prize — and it directly attacks the spawn-pattern class of bug (every `crtr X` shelled from a hook).
- **Does NOT touch the agent boot.** The broker hosts the `pi` engine (`@earendil-works/pi-coding-agent`, Node/TS) IN-PROCESS. The ~1s broker boot (~380ms SDK import + ~600ms session build) is Node/pi and stays in any language — a native crtr still spawns a Node broker per node. So the rewrite targets the dispatcher + plumbing (placement, tmux glue, sqlite/canvas.db, daemon/supervision), not the agent runtime. Front-door agent latency barely moves (~0.65s → ~0.45s); per-subcommand latency and footprint move a lot.
- **Tradeoffs to design around:** pi is Node-only, so the crtr↔pi seam becomes a polyglot FFI/IPC boundary and loses shared TS types; the broker process stays Node by necessity; the canvas-* `-e` extensions stay JS. Plan the boundary (native crtr/daemon ↔ Node broker+extensions) up front.
- **Sequencing:** the caching fixes above already removed the acute spawn-storm, so a rewrite is no longer urgent — do the esbuild bundle first as a cheap measurement of how much of the dispatch cost is module-load vs unavoidable, which de-risks and right-sizes the rewrite.
