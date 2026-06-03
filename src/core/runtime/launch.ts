// The launch spec — how a node becomes (or comes back as) a running pi process.
//
// pi-only. No claude branch — we are a super-opinionated system. A node's
// LaunchSpec (persisted in meta.json) is the canonical recipe the daemon
// replays to revive it faithfully: `--resume` to wake a done/idle node (keeps
// its conversation), or fresh (against the context dir) for a refresh-yield.
// The spec is rewritten on every polymorph (base→orchestrator) so a node
// always comes back as its *current* self.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePersona } from '../personas/index.js';
import { nodeEnv } from './nodes.js';
import type { NodeMeta, LaunchSpec, Mode } from '../canvas/index.js';

// ---------------------------------------------------------------------------
// The two canvas pi-extensions every node loads. They self-gate on the live
// {kind,mode} env, so the worker→orchestrator polymorph flips hook behavior
// with no respawn.
// ---------------------------------------------------------------------------

function resolveExtension(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/core/runtime or src/core/runtime
  const candidates = [
    join(here, '..', '..', 'pi-extensions', `${name}.js`),
    join(here, '..', '..', 'pi-extensions', `${name}.ts`),
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

export const CANVAS_STOPHOOK_PATH = resolveExtension('canvas-stophook');
export const CANVAS_INBOX_WATCHER_PATH = resolveExtension('canvas-inbox-watcher');
export const CANVAS_NAV_PATH = resolveExtension('canvas-nav');
export const CANVAS_GOAL_CAPTURE_PATH = resolveExtension('canvas-goal-capture');
export const CANVAS_PASSIVE_CONTEXT_PATH = resolveExtension('canvas-passive-context');
export const CANVAS_COMMANDS_PATH = resolveExtension('canvas-commands');

/** The canvas extensions every node loads, in order: stophook (routing +
 *  telemetry + session-id capture), inbox-watcher (wake), nav (in-editor
 *  graph chrome), goal-capture (persist the first user message as the goal),
 *  passive-context (drain passive backlog as pre-text on the next message),
 *  commands (the /promote slash-command). All self-gate on CRTR_NODE_ID.
 *  goal-capture precedes passive-context so it reads the raw user text. */
export const CANVAS_EXTENSIONS = [
  CANVAS_STOPHOOK_PATH,
  CANVAS_INBOX_WATCHER_PATH,
  CANVAS_NAV_PATH,
  CANVAS_GOAL_CAPTURE_PATH,
  CANVAS_PASSIVE_CONTEXT_PATH,
  CANVAS_COMMANDS_PATH,
];

/** Bare model aliases resolve to the anthropic provider under pi (avoids the
 *  bedrock default). Anything with a `/` or an unknown name passes through. */
export function normalizeModel(model: string): string {
  const bare = new Set(['sonnet', 'opus', 'haiku']);
  if (bare.has(model)) return `anthropic/${model}`;
  return model;
}

// ---------------------------------------------------------------------------
// Build the launch spec from {kind, mode}
// ---------------------------------------------------------------------------

/** Compose a node's full pi launch recipe from its persona. The two canvas
 *  extensions are always first; persona-declared extensions follow. */
export function buildLaunchSpec(
  kind: string,
  mode: Mode,
  opts: { extraEnv?: Record<string, string> } = {},
): { launch: LaunchSpec; lifecycle: 'terminal' | 'resident'; skills: string[] } {
  const p = resolvePersona(kind, mode);
  const launch: LaunchSpec = {
    model: p.model !== undefined ? normalizeModel(p.model) : undefined,
    tools: p.tools,
    extensions: [...CANVAS_EXTENSIONS, ...p.extensions],
    systemPrompt: p.systemPrompt,
    env: { ...(opts.extraEnv ?? {}) },
  };
  return { launch, lifecycle: p.lifecycle, skills: p.skills };
}

// ---------------------------------------------------------------------------
// Build the pi argv to launch / revive a node
// ---------------------------------------------------------------------------

export interface PiInvocation {
  /** argv after the `pi` binary. */
  argv: string[];
  /** env to merge into the process. */
  env: Record<string, string>;
}

/** The pi session display name — the editor label in the top-left. Shows the
 *  node's name plus its current mode so base vs orchestrator reads at a glance
 *  (e.g. `developer (orchestrator)`). Recomputed from `meta.mode` on every
 *  revive, so a base→orchestrator polymorph updates the label. */
export function editorLabel(meta: NodeMeta): string {
  return `${meta.name} (${meta.mode})`;
}

/** Construct the pi invocation for a node.
 *  - fresh start: pass `prompt` (the node's first user message), no resume.
 *  - revive idle/done: pass `resumeSessionId` to `--resume` (keeps conversation).
 *  - refresh-yield: fresh again (no resume) — the node re-reads its roadmap. */
export function buildPiArgv(
  meta: NodeMeta,
  opts: { prompt?: string; resumeSessionId?: string } = {},
): PiInvocation {
  const spec = meta.launch;
  const argv: string[] = [];

  for (const ext of spec?.extensions ?? CANVAS_EXTENSIONS) {
    argv.push('-e', ext);
  }
  argv.push('-n', editorLabel(meta));
  if (opts.resumeSessionId !== undefined) argv.push('--resume', opts.resumeSessionId);
  if (spec?.model !== undefined) argv.push('--model', spec.model);
  if (spec?.tools !== undefined && spec.tools.length > 0) argv.push('--tools', spec.tools.join(','));
  if (spec?.systemPrompt !== undefined && spec.systemPrompt !== '') {
    argv.push('--append-system-prompt', spec.systemPrompt);
  }
  if (opts.prompt !== undefined && opts.prompt !== '') argv.push(opts.prompt);

  return { argv, env: nodeEnv(meta) };
}
