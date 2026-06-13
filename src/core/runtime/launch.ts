// The launch spec — how a node becomes (or comes back as) a running pi process.
//
// pi-only. No claude branch — we are a super-opinionated system. A node's
// LaunchSpec (persisted in meta.json) is the canonical recipe the daemon
// replays to revive it faithfully: `--session <id>` to wake a done/idle node
// (keeps its conversation), or fresh (against the context dir) for a refresh-yield.
// The spec is rewritten on every polymorph (base→orchestrator) so a node
// always comes back as its *current* self.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolve as resolvePersona } from '../personas/index.js';
import { nodeEnv } from './nodes.js';
import { editorLabel } from '../canvas/index.js';
import { nodeDir } from '../canvas/paths.js';
import type { NodeMeta, LaunchSpec, Mode, Lifecycle } from '../canvas/index.js';

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
export const CANVAS_RECAP_PATH = resolveExtension('canvas-recap');
export const CANVAS_GOAL_CAPTURE_PATH = resolveExtension('canvas-goal-capture');
export const CANVAS_PASSIVE_CONTEXT_PATH = resolveExtension('canvas-passive-context');
export const CANVAS_CONTEXT_INTRO_PATH = resolveExtension('canvas-context-intro');
export const CANVAS_DOC_SUBSTRATE_PATH = resolveExtension('canvas-doc-substrate');
export const CANVAS_COMMANDS_PATH = resolveExtension('canvas-commands');
export const CANVAS_RESUME_PATH = resolveExtension('canvas-resume');
export const CANVAS_VIEW_PATH = resolveExtension('canvas-view');

/** The canvas extensions every node loads, in order: stophook (routing +
 *  telemetry + session-id capture), inbox-watcher (wake), nav (in-editor
 *  graph chrome), recap (the per-node inactivity recap card — Haiku over the
 *  conversation, shown above the manager line after 300s of no message),
 *  goal-capture (persist the first user message as the goal),
 *  passive-context (drain passive backlog as pre-text on the next message),
 *  context-intro (inject the <crtr-context> bearings block — carrying the
 *  <knowledge> catalog — as its own session message, once per brand-new chat),
 *  doc-substrate (the unified document substrate's two hooks: <preferences> +
 *  <memory-guidance> at boot, on-read context injection), commands (the /promote slash-command), resume (the /resume-node
 *  whole-canvas picker → `crtr node focus`), view (the /view popup → `crtr
 *  view pick` / `crtr view run <name>`).
 *  All self-gate on CRTR_NODE_ID. goal-capture precedes passive-context so it
 *  reads the raw user text. */
export const CANVAS_EXTENSIONS = [
  CANVAS_STOPHOOK_PATH,
  CANVAS_INBOX_WATCHER_PATH,
  CANVAS_NAV_PATH,
  CANVAS_RECAP_PATH,
  CANVAS_GOAL_CAPTURE_PATH,
  CANVAS_PASSIVE_CONTEXT_PATH,
  CANVAS_CONTEXT_INTRO_PATH,
  CANVAS_DOC_SUBSTRATE_PATH,
  CANVAS_COMMANDS_PATH,
  CANVAS_RESUME_PATH,
  CANVAS_VIEW_PATH,
];

/** The named capability tiers a caller picks with `--model`, in descending
 *  strength. Each maps to a concrete pi model spec. `strong`/`medium`/`light`
 *  resolve to the latest opus/sonnet/haiku; `ultra` to the frontier model. */
export const MODEL_TIERS: Record<string, string> = {
  ultra: 'anthropic/claude-fable-5',
  strong: 'anthropic/claude-opus-4-8',
  medium: 'anthropic/claude-sonnet-4-6',
  light: 'anthropic/claude-haiku-4-5',
};

/** Bare family aliases → the same concrete versioned ids as the tiers. These
 *  MUST be real registry ids (see `pi --list-models`): an unversioned spec like
 *  `anthropic/sonnet` is NOT in the registry and silently falls back to the SDK
 *  default (opus), so it can never be the resolution target. */
const BARE_ALIASES: Record<string, string> = {
  opus: 'anthropic/claude-opus-4-8',
  sonnet: 'anthropic/claude-sonnet-4-6',
  haiku: 'anthropic/claude-haiku-4-5',
};

/** Resolve a model token to the spec pi gets via `--model`. A named tier
 *  (ultra/strong/medium/light) maps to its concrete spec; a bare family alias
 *  (sonnet/opus/haiku) maps to that family's current versioned id; anything
 *  with a `/` or an unknown name passes through. */
export function normalizeModel(model: string): string {
  if (model in MODEL_TIERS) return MODEL_TIERS[model];
  if (model in BARE_ALIASES) return BARE_ALIASES[model];
  return model;
}

// ---------------------------------------------------------------------------
// Build the launch spec from {kind, mode}
// ---------------------------------------------------------------------------

/** Compose a node's full pi launch recipe from its persona. The system prompt
 *  is composed from FOUR inputs: kind×mode (the persona body) plus lifecycle
 *  (terminal/resident — the finish contract) and spine position (hasManager —
 *  whether the push-up family is taught at all). Callers pass the authoritative
 *  lifecycle + hasManager (`parent !== null`) so a polymorph/flip rebuilds the
 *  prompt faithfully. The two canvas extensions are always first; persona-
 *  declared extensions follow. */
export function buildLaunchSpec(
  kind: string,
  mode: Mode,
  opts: { lifecycle: Lifecycle; hasManager: boolean; extraEnv?: Record<string, string>; model?: string },
): { launch: LaunchSpec; lifecycle: 'terminal' | 'resident'; skills: string[] } {
  const p = resolvePersona(kind, mode, { lifecycle: opts.lifecycle, hasManager: opts.hasManager });
  // A caller-supplied override (durable on `meta.model_override`, re-passed on
  // every polymorph) wins over the persona's declared default; absent both, the
  // model is left unset and the node inherits pi's default.
  const chosenModel = opts.model ?? p.model;
  const launch: LaunchSpec = {
    model: chosenModel !== undefined ? normalizeModel(chosenModel) : undefined,
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

/** Persist a node's (possibly large) system prompt to a file in its node dir and
 *  return the absolute path, so callers can pass a short path to pi instead of
 *  the inline text. Returns null if the write fails — the caller then falls back
 *  to passing the prompt inline. Rewritten every launch so a polymorph's updated
 *  prompt always lands. */
function writeSystemPromptFile(nodeId: string, prompt: string): string | null {
  try {
    const dir = nodeDir(nodeId);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'system-prompt.md');
    writeFileSync(p, prompt, 'utf8');
    return p;
  } catch {
    return null;
  }
}

export interface PiInvocation {
  /** argv after the `pi` binary. */
  argv: string[];
  /** env to merge into the process. */
  env: Record<string, string>;
}

/** Construct the pi invocation for a node.
 *  - fresh start: pass `prompt` (the node's first user message), no resume.
 *  - fork start: pass `forkFrom` (absolute .jsonl path or partial uuid) to `--fork`
 *    — pi COPIES that conversation into a NEW session for this node, then `prompt`
 *    is delivered as the next message. One-shot at birth: the node thereafter
 *    captures its OWN pi_session_file and revives by `--session` like any other.
 *  - revive idle/done: pass `resumeSessionPath` (absolute .jsonl path, preferred)
 *    or `resumeSessionId` (bare uuid fallback) to `--session` (keeps conversation).
 *  - refresh-yield: fresh again (no resume) — the node re-reads its roadmap. */
export function buildPiArgv(
  meta: NodeMeta,
  opts: { prompt?: string; resumeSessionId?: string; resumeSessionPath?: string; forkFrom?: string } = {},
): PiInvocation {
  const spec = meta.launch;
  const argv: string[] = [];

  for (const ext of spec?.extensions ?? CANVAS_EXTENSIONS) {
    argv.push('-e', ext);
  }
  argv.push('-n', editorLabel(meta));
  // pi's `--resume` is a bare toggle that opens the interactive picker; the
  // flag that resumes a *specific* session is `--session <path|id>`. Prefer the
  // absolute FILE path when present: pi resolves a bare id cwd-relative first
  // and shows a cross-project "Fork? [y/N]" prompt when the revive cwd differs
  // from the session's creation cwd, whereas a path (contains `/` or ends
  // `.jsonl`) is opened directly — immune to any cwd discrepancy. The bare uuid
  // is the fallback for older nodes booted before pi_session_file was captured.
  // `--fork <path|id>` is the spawn-time branch: pi copies the source session
  // into a fresh one for this node (the source is untouched), then delivers the
  // kickoff prompt as the next message. Mutually exclusive with `--session`
  // (resume) — fork wins when both are somehow set, but in practice a spawn
  // never resumes and a revive never forks.
  if (opts.forkFrom !== undefined && opts.forkFrom !== '') {
    argv.push('--fork', opts.forkFrom);
  } else {
    const resumeArg = opts.resumeSessionPath ?? opts.resumeSessionId;
    if (resumeArg !== undefined) argv.push('--session', resumeArg);
  }
  if (spec?.model !== undefined) argv.push('--model', spec.model);
  if (spec?.tools !== undefined && spec.tools.length > 0) argv.push('--tools', spec.tools.join(','));
  if (spec?.systemPrompt !== undefined && spec.systemPrompt !== '') {
    // pi's --append-system-prompt reads a FILE when the arg is an existing path,
    // else treats the arg as literal text. Pass the prompt as a file path, not
    // inline: an orchestrator persona is ~17KB, and passed inline it inflates the
    // `tmux new-window 'pi …'` command past tmux's command-length limit, so the
    // spawn dies with "command too long" and the node is marked dead before pi
    // ever starts (base workers fit, orchestrator children don't). Writing it to
    // the node dir keeps the command tiny. Falls back to inline if the write
    // fails (e.g. an ephemeral meta with no node dir).
    const promptArg = writeSystemPromptFile(meta.node_id, spec.systemPrompt) ?? spec.systemPrompt;
    argv.push('--append-system-prompt', promptArg);
  }
  if (opts.prompt !== undefined && opts.prompt !== '') argv.push(opts.prompt);

  return { argv, env: nodeEnv(meta) };
}

// ---------------------------------------------------------------------------
// The inverse of buildPiArgv: PiInvocation → headless-broker SDK config
// ---------------------------------------------------------------------------

/** The pi-SDK launch config the headless broker drives an in-process engine
 *  with — the structural inverse of `buildPiArgv`'s flag vocabulary. Each field
 *  maps one of buildPiArgv's emitted flags back to its SDK option:
 *  `-e`→`extensionPaths`, `-n`→`editorName`, `--fork`→`forkFrom`,
 *  `--session`→`resumeSessionPath|resumeSessionId`, `--model`→`model`,
 *  `--tools`→`tools`, `--append-system-prompt`→`appendSystemPromptPath`, the
 *  trailing positional→`firstPrompt`. */
export interface BrokerSdkConfig {
  /** The node's pinned working dir (from `CRTR_NODE_CWD`, else `process.cwd()`). */
  cwd: string;
  /** Absolute `.js` extension paths (the canvas extensions). */
  extensionPaths: string[];
  /** Session label (`-n`). */
  editorName?: string;
  /** Spawn-time fork source (`--fork <path|id>`). */
  forkFrom?: string;
  /** Resume by absolute `.jsonl` path (preferred — `SessionManager.open`). */
  resumeSessionPath?: string;
  /** Resume by bare session uuid (legacy fallback). */
  resumeSessionId?: string;
  /** Model spec, e.g. `anthropic/sonnet` (`--model`). */
  model?: string;
  /** Tool allowlist (`--tools a,b,c` → `['a','b','c']`). */
  tools?: string[];
  /** `--append-system-prompt` arg — a file path in practice (pi's loader
   *  resolves a path or literal text identically). */
  appendSystemPromptPath?: string;
  /** The fresh-start kickoff message (the trailing positional). */
  firstPrompt?: string;
}

/** Translate a `PiInvocation` (the recipe `buildPiArgv` produced) into the SDK
 *  config the broker hosts an engine with. This is the EXACT inverse of
 *  `buildPiArgv` and must track its flag set 1:1 — co-located here so the two
 *  never drift. Safe because `buildPiArgv` is the SOLE producer of these flags
 *  (we own both ends). SIDE EFFECT: merges `inv.env` into `process.env` so the
 *  in-process engine + the bound canvas extensions see the same env a forked pi
 *  would (CRTR_NODE_ID, CRTR_SUBTREE, …). */
export function piInvocationToSdkConfig(inv: PiInvocation): BrokerSdkConfig {
  for (const [k, v] of Object.entries(inv.env)) process.env[k] = v;

  const cfg: BrokerSdkConfig = {
    cwd: inv.env['CRTR_NODE_CWD'] ?? process.cwd(),
    extensionPaths: [],
  };

  const argv = inv.argv;
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    switch (tok) {
      case '-e':
        cfg.extensionPaths.push(argv[++i]);
        break;
      case '-n':
        cfg.editorName = argv[++i];
        break;
      case '--fork':
        cfg.forkFrom = argv[++i];
        break;
      case '--session': {
        const v = argv[++i];
        // A path (contains `/` or ends `.jsonl`) resumes via SessionManager.open;
        // a bare uuid is the legacy fallback. Same classification buildPiArgv
        // documents (path preferred, immune to cwd discrepancy).
        if (v.includes('/') || v.endsWith('.jsonl')) cfg.resumeSessionPath = v;
        else cfg.resumeSessionId = v;
        break;
      }
      case '--model':
        cfg.model = argv[++i];
        break;
      case '--tools':
        cfg.tools = argv[++i].split(',').filter((t) => t !== '');
        break;
      case '--append-system-prompt':
        cfg.appendSystemPromptPath = argv[++i];
        break;
      default:
        // buildPiArgv consumes every flag's value via the cases above, so any
        // token reaching here is the single trailing positional (the prompt).
        cfg.firstPrompt = tok;
        break;
    }
  }

  return cfg;
}
