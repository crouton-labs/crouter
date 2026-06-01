// `crtr agent` umbrella — spawn primitives.
//
// `agent new` is the single spawn command (general-purpose by default,
// `--agent <id>` overlays a defined subagent). `agent fork` carries the
// current session context into a sibling pane. Spawning creates a job record;
// monitoring lives at `crtr job`.
//
// Spec/plan/debug workflows live under `crtr mode` (src/commands/mode.ts).
//
// Terminal-write contract for spawned workers:
//   A worker MAY call `crtr job submit` to deliver a result, but is not
//   required to. A job reaches a terminal state by any of three signals:
//     1. `crtr job submit` writes result.md (done|failed).
//     2. The wrapper shell's `crtr job _fail` runs when claude exits normally
//        without a submit (result.md absent → failed).
//     3. The hosting tmux pane is closed/killed — case 2 never runs (SIGHUP),
//        so the jobs layer reaps the job when its recorded pane disappears.
//   Spawns record their pane id so (3) and `crtr job cancel` can act on it.

import { defineBranch, defineLeaf } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateBlock } from '../core/help.js';
import { usage, general } from '../core/errors.js';
import type { Scope, Subagent } from '../types.js';
import {
  listSubagents,
  resolveSubagent,
  subagentId,
  scopeAgentsDir,
} from '../core/subagents.js';
import { resolveScopeArg, requireScopeRoot, projectScopeRoot } from '../core/scope.js';
import { ensureScopeInitialized } from '../core/config.js';
import { ensureDir, pathExists } from '../core/fs-utils.js';
import {
  createJob,
  appendEvent,
  recordJobPane,
  recordJobPid,
  writeMarkdownResult,
  readResult as readJobResult,
} from '../core/jobs.js';
import {
  spawnAgent,
  isInTmux,
  detectAgentKind,
  runAgentHeadless,
  spawnHeadlessDetached,
} from '../core/spawn.js';
import { agentNewPrompt } from '../prompts/agent.js';
import { readConfig } from '../core/config.js';

export const DEFAULT_KILL_SECS = 2;
const WAIT_BUDGET_MS = 10 * 60 * 1000;

// The built-in, persona-less agent type. `--agent general` (or omitting --agent)
// spawns the general-purpose worker; any other id overlays a defined subagent.
const GENERAL_AGENT = 'general';

// A spawn leaf returns a job handle, not a result. This follow_up is the
// ORCHESTRATOR's own next call: the agent that spawned the worker collects the
// result itself and reports the findings to the user. The observed failure mode
// is relaying these commands to the human ("run this to see the result") or
// inventing a batch-await that doesn't exist — the phrasing forecloses both.
export function followUpResult(jobId: string): string {
  return `You spawned this worker — collecting its result is your job, not the user's. When you're ready for it, run \`crtr job read result ${jobId} --wait\` yourself (blocks up to 10 min), then report the worker's findings. Spawned several? Call it once per job_id — there is no batch await. Never print these commands for the user to run.`;
}

export function resolveMaxPanes(): number {
  const cfg = readConfig('user');
  return cfg.max_panes_per_window;
}

export function assertTmux(): void {
  if (!isInTmux()) {
    throw new InputError({
      error: 'not_in_tmux',
      message: 'crtr agent new requires tmux (TMUX env var not set).',
      next: 'Run inside a tmux session.',
    });
  }
}

// ---------------------------------------------------------------------------
// Subagent catalog (dynamicState for `agent -h` and `agent subagent -h`)
// ---------------------------------------------------------------------------

// Preamble for the subagent catalog. Scoped to ONE job: how to invoke a worker
// and how to pick which agent runs it. The reach-for-it reflex and the
// when-to-delegate scenarios live on the root `useWhen` (which renders right
// above this on the root tool guide); the collection mechanics live on the
// spawn leaf's `follow_up`. Keeping each fact in one place avoids restating the
// same delegation pitch three times in the always-loaded root. Travels with the
// catalog to every surface it renders on (root, `agent -h`, `agent subagent -h`).
const SUBAGENT_USAGE =
  'One spawn command — `agent new` — runs any of these. `--agent <id>` overlays a defined persona (its system prompt, model, and tools); omit it (or pass `--agent general`) for the general-purpose worker. Same command either way. Pick the most specific agent that fits the task, else general. A defined agent earns its keep when a task recurs with a stable shape (a scout, a reviewer); for a fast throwaway pass, general on a cheap model is usually enough.';

function descLine(a: Subagent): string {
  const meta: string[] = [];
  if (a.frontmatter.model !== undefined && a.frontmatter.model !== '') meta.push(`model: ${a.frontmatter.model}`);
  if (a.frontmatter.tools !== undefined && a.frontmatter.tools.length > 0) meta.push(`tools: ${a.frontmatter.tools.join(',')}`);
  const annot = meta.length > 0 ? ` (${meta.join('; ')})` : '';
  const desc = (a.frontmatter.description !== undefined ? a.frontmatter.description : '').replace(/\s+/g, ' ').trim();
  return `- ${subagentId(a)}${annot}: ${desc}`;
}

/** The defined-subagents catalog as a self-named `<subagents count="N">`
 *  element: a usage preamble plus one full-description line per agent (the
 *  discriminator for picking which to delegate to). Project agents list first.
 *  Soft-fails to null when discovery throws or nothing is defined, so the block
 *  is simply omitted on a cold path. */
function buildSubagentCatalog(): string | null {
  let agents: Subagent[];
  try {
    agents = listSubagents();
  } catch {
    agents = [];
  }

  // Project agents (repo-specific) before user/builtin, then alphabetical.
  const ordered = [...agents].sort((a, b) => {
    const sa = a.scope === 'project' ? 0 : 1;
    const sb = b.scope === 'project' ? 0 : 1;
    return sa !== sb ? sa - sb : subagentId(a).localeCompare(subagentId(b));
  });

  const lines: string[] = [
    SUBAGENT_USAGE,
    '',
    'Agents (select with `agent new --agent <id>`):',
    `- ${GENERAL_AGENT} (default): general-purpose agent for any self-contained task — research, code search, multi-step work. Used when --agent is omitted or \`--agent ${GENERAL_AGENT}\`.`,
  ];
  for (const a of ordered) lines.push(descLine(a));

  // count includes the built-in general agent alongside the defined ones.
  return stateBlock('subagents', { count: agents.length + 1 }, lines.join('\n'));
}

// Decision guidance surfaced on `agent new -h`. Answers "when do I reach
// for this, how often, and which mode?" — the questions the flag constraints
// alone don't.
const PROMPT_GUIDE = `## How to invoke

The task goes on **stdin**, not as an argument; the agent id and flags are argv.
Three shapes cover almost everything:

  # Blocking (default): waits and returns the result inline, like a function call
  echo "find where request auth is handled" | crtr agent new

  # With a persona: --agent overlays a defined subagent (see \`crtr agent subagent list\`)
  echo "map the daemon lifecycle" | crtr agent new --agent explore

  # Background fan-out: each spawn returns a job_id immediately; collect when ready
  echo "task A" | crtr agent new --background   # -> { "job_id": "..." }
  echo "task B" | crtr agent new --background
  crtr job read result <job_id> --wait          # blocks until that worker finishes

Heredocs work for multi-line prompts: \`crtr agent new <<'EOF' ... EOF\`.

## When to delegate

Reach for this constantly — it is the main way to get work done without
burning your own context. A spawned agent runs in a fresh context window and
hands back only its conclusion, so your own thread stays lean. Delegate any
self-contained task you can describe in a prompt: exploring a codebase,
researching how something works, implementing a change, writing tests,
refactoring, reproducing a bug, drafting docs. When in doubt, delegate rather
than do it inline — especially for anything multi-step, file-heavy, or
parallelizable. Keep doing trivial, single-shot lookups yourself.

Two habits worth building. **Scout before you build:** before you start
working in unfamiliar code, spawn a quick recon agent to map it first — a fast,
cheap model (e.g. haiku) is plenty for "where does X live / how does Y work,"
and it keeps the exploration out of your own context. **Fan out independents:**
when a job splits into tasks that don't depend on each other, launch one
--background worker per task and let them run concurrently rather than doing
them in series.

This is the single spawn command: it runs the general-purpose agent by default,
and \`--agent <id>\` swaps in a defined persona instead (see below). Same path
either way — there is no separate command for custom agents.

One worker per independent task. For a big job, fan out several small,
well-scoped workers instead of one mega-prompt — they run concurrently and each
stays focused.

## Which mode

**Default (blocking)** — use for almost everything. It spawns the worker, waits,
and returns the result inline, like a function call. Pick this whenever you need
the answer before you can continue. Inside tmux the worker runs as an interactive
agent in a pane of the dedicated subagent session WITHOUT stealing your focus —
jump over to watch or steer it with Alt-o, or just wait for the inline result.
Outside tmux it runs as a print-mode child process. Either way the result comes
back inline.

**--background** — use when you do NOT need the result right now:
  - Fan out: launch several independent workers, keep working, then collect
    each at \`crtr job read result <id> --wait\` once you need them.
  - Fire-and-continue: kick off a long task and proceed with other work.
You own the collection — a backgrounded worker is yours to retrieve and report,
not the user's.

**--headed** — legacy/no-op. Workers are always headed (interactive in a pane)
inside tmux now; this flag is kept so older invocations don't break but changes
nothing. To watch or steer a worker, spawn normally and press Alt-o.

## Choosing the agent

**--agent <id>** selects which agent runs the task. Omit it (or pass
\`--agent general\`) for the general-purpose agent. Pass a defined id to overlay
that subagent: a reusable persona defined in markdown with frontmatter (see
\`crtr agent subagent\`), whose body becomes the worker's appended system prompt
and whose declared model / (pi) tools are applied for the run. Everything else
(modes, output) is identical. Reach for a defined agent when a recurring task
has a stable persona (a scout, a reviewer); use general for one-off delegation.`;

// ---------------------------------------------------------------------------
// agent new — the single spawn command. General-purpose by default;
// `--agent <id>` overlays a defined subagent persona.
// ---------------------------------------------------------------------------

const newPrompt = defineLeaf({
  name: 'new',
  help: {
    name: 'agent new',
    summary: 'spawn a worker (matches the host CLI: claude or pi) — the general-purpose agent by default, or a defined subagent via --agent. Blocking by default, returning the result inline; inside tmux the worker runs in an unfocused pane you can watch with Alt-o',
    guide: PROMPT_GUIDE,
    params: [
      { kind: 'stdin', name: 'prompt', required: true, constraint: 'Task/prompt sent to the spawned agent as the first user message.' },
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory for the spawned agent. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: false, constraint: 'Display name passed to the agent CLI (`-n`); surfaces in pane title and resume picker. Defaults to the --agent id (or "general").' },
      { kind: 'flag', name: 'agent', type: 'string', required: false, default: 'general', constraint: 'Which agent runs the task. Omit or "general" for the general-purpose agent; any other id (<name> or <plugin>/<name>) overlays that defined subagent\'s persona/model/tools. List with `crtr agent subagent list`.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'With --agent, narrows resolution when the subagent name is ambiguous across scopes.' },
      { kind: 'flag', name: 'model', type: 'string', required: false, constraint: 'Model pattern/id passed via `--model`. Overrides a subagent\'s declared model.' },
      { kind: 'flag', name: 'headed', type: 'bool', required: false, constraint: 'Legacy/no-op. Workers are always interactive panes in the dedicated subagent session (inside tmux); this flag is accepted for back-compat but changes nothing. Use Alt-o to watch/steer.' },
      { kind: 'flag', name: 'background', type: 'bool', required: false, constraint: 'Return a job handle immediately instead of blocking for the result. Collect later with `crtr job read result`.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read status|logs|result` and `crtr job cancel`.' },
      { name: 'agent', type: 'string', required: true, constraint: 'The agent that ran the task: "general" or a resolved subagent id.' },
      { name: 'status', type: 'string', required: false, constraint: 'Blocking runs only: done | failed | closed | timeout.' },
      { name: 'result_md', type: 'string', required: false, constraint: 'Blocking runs: the agent\'s output (a submitted markdown result in tmux, or print-mode stdout outside tmux).' },
      { name: 'result', type: 'object', required: false, constraint: 'Blocking runs: a structured result, when one was submitted programmatically.' },
      { name: 'reason', type: 'string', required: false, constraint: 'Blocking runs: explanation when status is failed or closed.' },
      { name: 'follow_up', type: 'string', required: false, constraint: 'Background runs only: your own next call — run it and report the worker\'s result; do not relay it to the user.' },
    ],
    outputKind: 'object',
    effects: [
      'Default (blocking): inside tmux, runs an interactive agent in a pane of the dedicated subagent session (no focus change) that delivers its result via `crtr job submit`; outside tmux, runs a print-mode child process whose stdout is the result. Set CRTR_SUBAGENT_TMUX=off to force the child-process path. Either way the result is returned inline.',
      'All spawns land in a per-host-session tmux session (crtr-agents-<pane>); Alt-o toggles between it and the originating pane.',
      '--headed is legacy/no-op (workers are always headed inside tmux).',
      '--background: returns a job handle immediately; the worker runs async and its result is collected via `crtr job`.',
      'Always creates a job entry at $XDG_STATE_HOME/crtr/jobs/<job_id>/ and records the result there.',
    ],
  },
  run: async (input) => {
    const prompt = input['prompt'] as string;
    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const background = input['background'] === true;

    // Optional subagent overlay: --agent loads a persona (markdown + frontmatter)
    // that supplies the appended system prompt, model, and (pi) tools. Without
    // it, this is a plain general-purpose spawn.
    const agentArg = typeof input['agent'] === 'string' && input['agent'] !== '' ? (input['agent'] as string) : undefined;
    const scopeStr = input['scope'] as string | undefined;
    // `general` (or no --agent) is the built-in general-purpose worker: no
    // persona overlay. Any other id resolves a defined subagent.
    let sub: Subagent | undefined;
    if (agentArg !== undefined && agentArg !== GENERAL_AGENT) {
      const resolveOpts: { scope?: Scope } = {};
      if (scopeStr !== undefined) {
        const resolved = resolveScopeArg(scopeStr);
        if (resolved !== 'all') resolveOpts.scope = resolved;
      }
      sub = resolveSubagent(agentArg, resolveOpts);
    }

    const agentId = sub !== undefined ? subagentId(sub) : GENERAL_AGENT;
    const nameArg = typeof input['name'] === 'string' && input['name'] !== '' ? (input['name'] as string) : undefined;
    const name = nameArg ?? agentId;
    const systemPrompt = sub?.systemPrompt;
    const tools = sub?.frontmatter.tools;
    const model = (typeof input['model'] === 'string' && input['model'] !== '' ? (input['model'] as string) : undefined)
      ?? sub?.frontmatter.model;
    const subOut = { agent: agentId };

    const { jobId } = createJob(sub !== undefined ? 'subagent' : 'general', { cwd });

    // Inside tmux (unless opted out with CRTR_SUBAGENT_TMUX=off), EVERY worker
    // runs as an interactive agent in a pane of the dedicated subagent session.
    // We never steal focus — `--headed` is retained only for back-compat and no
    // longer changes behavior; jump to the session yourself with Alt-o. The pane
    // agent delivers its result via `crtr job submit` (the instruction is
    // appended to the prompt). Outside tmux there is no pane to host an
    // interactive agent, so we fall back to a print-mode child process whose
    // stdout is the result.
    const useTmux = isInTmux() && process.env.CRTR_SUBAGENT_TMUX !== 'off';
    if (useTmux) {
      const result = spawnAgent({
        prompt: agentNewPrompt(prompt, jobId),
        cwd,
        jobId,
        maxPanesPerWindow: resolveMaxPanes(),
        name,
        systemPrompt,
        model,
        tools,
      });
      if (result.status === 'spawned') {
        if (result.paneId !== undefined) recordJobPane(jobId, result.paneId);
        const paneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
        appendEvent(jobId, { level: 'info', event: 'worker_started', message: `pane ${paneLabel} spawned (unfocused)` });
        if (background) {
          return { job_id: jobId, ...subOut, follow_up: followUpResult(jobId) };
        }
        const r = await readJobResult(jobId, { waitMs: WAIT_BUDGET_MS });
        const out: Record<string, unknown> = { job_id: jobId, ...subOut, status: r.status };
        if (r.result_md !== undefined) out['result_md'] = r.result_md;
        if (r.result !== undefined) out['result'] = r.result;
        if (r.reason !== undefined) out['reason'] = r.reason;
        return out;
      }
      // tmux placement failed → fall through to the child-process path below.
      appendEvent(jobId, { level: 'info', event: 'tmux_spawn_failed', message: `${result.message}; falling back to a print-mode child process` });
    }

    // ---- No tmux: print-mode child process (stdout is the result) ----
    if (background) {
      const res = spawnHeadlessDetached({ prompt, name, cwd, jobId, systemPrompt, model, tools });
      if (res.status === 'spawn-failed') {
        throw new InputError({ error: 'spawn_failed', message: res.message, next: 'Check the agent CLI is installed and on PATH.' });
      }
      if (res.pid !== undefined) recordJobPid(jobId, res.pid);
      appendEvent(jobId, { level: 'info', event: 'worker_started', message: res.message });
      return { job_id: jobId, ...subOut, follow_up: followUpResult(jobId) };
    }

    appendEvent(jobId, { level: 'info', event: 'worker_started', message: 'agent started (blocking, no tmux)' });
    const r = await runAgentHeadless({ prompt, name, cwd, systemPrompt, model, tools });
    if (r.status === 'done') {
      writeMarkdownResult(jobId, r.output, 'done');
    } else {
      writeMarkdownResult(jobId, r.output, 'failed', `agent exited with code ${r.exitCode ?? 'null'}`);
    }
    appendEvent(jobId, {
      level: r.status === 'done' ? 'info' : 'error',
      event: 'worker_finished',
      message: `agent ${r.status}`,
    });
    return { job_id: jobId, ...subOut, status: r.status, result_md: r.output };
  },
});

// ---------------------------------------------------------------------------
// agent fork
// ---------------------------------------------------------------------------

const newFork = defineLeaf({
  name: 'fork',
  help: {
    name: 'agent fork',
    summary: 'fork the current agent session into a sibling pane; returns a job handle immediately',
    params: [
      { kind: 'flag', name: 'cwd', type: 'path', required: false, constraint: 'Working directory. Defaults to process.cwd().' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Display name passed to the agent CLI (`-n`); surfaces in pane title and resume picker.' },
    ],
    output: [
      { name: 'job_id', type: 'string', required: true, constraint: 'Use with `crtr job read *` and `crtr job cancel`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Your own next call — run it and report the worker\'s result; do not relay it to the user.' },
    ],
    outputKind: 'object',
    effects: [
      'Claude Code only: requires $CLAUDE_CODE_SESSION_ID. pi does not expose its session id to subprocesses, so fork is unavailable under pi — use `agent new` instead.',
      'Spawns a forked agent session in a sibling tmux pane.',
      'Creates a job entry and result sidecar as with `agent new`.',
    ],
  },
  run: async (input) => {
    assertTmux();
    const agentKind = detectAgentKind();
    if (agentKind === 'pi') {
      throw new InputError({
        error: 'fork_unsupported',
        message: 'crtr agent fork is not supported under pi: pi does not expose the active session id to subprocesses.',
        next: 'Use `crtr agent new` to spawn a fresh pi agent instead.',
      });
    }
    const parentSessionId = process.env['CLAUDE_CODE_SESSION_ID'];
    if (parentSessionId === undefined || parentSessionId === '') {
      throw new InputError({
        error: 'missing_session_id',
        message: 'crtr agent fork requires $CLAUDE_CODE_SESSION_ID — must run inside Claude Code.',
        next: 'Run this command from within a Claude Code session.',
      });
    }

    const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd();
    const name = input['name'] as string;

    const { jobId } = createJob('fork', { cwd });

    const result = spawnAgent({
      prompt: `Fork of session ${parentSessionId}`,
      cwd,
      jobId,
      fork: { sessionId: parentSessionId },
      maxPanesPerWindow: resolveMaxPanes(),
      name,
    });

    if (result.status === 'not-in-tmux') {
      throw new InputError({ error: 'not_in_tmux', message: result.message, next: 'Run inside a tmux session.' });
    }
    if (result.status === 'spawn-failed') {
      throw new InputError({ error: 'spawn_failed', message: result.message, next: 'Check tmux is running and try again.' });
    }

    if (result.paneId !== undefined) recordJobPane(jobId, result.paneId);
    const forkPaneLabel = result.paneId !== undefined ? result.paneId : 'unknown';
    appendEvent(jobId, { level: 'info', event: 'worker_started', message: `forked pane ${forkPaneLabel} spawned` });

    return { job_id: jobId, follow_up: followUpResult(jobId) };
  },
});

// ---------------------------------------------------------------------------
// agent subagent (management branch: list / read / scaffold)
// ---------------------------------------------------------------------------

const subagentList = defineLeaf({
  name: 'list',
  help: {
    name: 'agent subagent list',
    summary: 'list defined subagents (markdown + frontmatter) discoverable from scope roots and plugins',
    params: [
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project', 'all'], required: false, constraint: 'Default: all.' },
      { kind: 'flag', name: 'full', type: 'bool', required: false, constraint: 'When present, includes each subagent\'s model and tools.' },
    ],
    output: [
      { name: 'items', type: 'object[]', required: true, constraint: 'Each: {id, name, plugin, scope, description}. With --full also {model, tools}. Sorted by name.' },
      { name: 'total', type: 'integer', required: true, constraint: 'Number of subagents returned.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Next commands for reading or spawning a subagent.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const scopeStr = input['scope'] as string | undefined;
    const full = input['full'] === true;
    let scopeFilter: Scope | undefined;
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved !== 'all') scopeFilter = resolved;
    }
    const agents = listSubagents(scopeFilter);
    return {
      items: agents.map((a) => {
        const base: Record<string, unknown> = {
          id: subagentId(a),
          name: a.name,
          plugin: a.plugin,
          scope: a.scope,
          description: a.frontmatter.description !== undefined ? a.frontmatter.description : null,
        };
        if (full) {
          base['model'] = a.frontmatter.model !== undefined ? a.frontmatter.model : null;
          base['tools'] = a.frontmatter.tools !== undefined ? a.frontmatter.tools : null;
        }
        return base;
      }),
      total: agents.length,
      follow_up: 'Read one with `crtr agent subagent read <name>`; delegate with `crtr agent new --agent <name>`.',
    };
  },
});

const subagentRead = defineLeaf({
  name: 'read',
  help: {
    name: 'agent subagent read',
    summary: 'load a subagent\'s system prompt (markdown body) and metadata',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Subagent identifier: <name> or <plugin>/<name>.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Narrows resolution when the name is ambiguous.' },
      { kind: 'flag', name: 'no-body', type: 'bool', required: false, constraint: 'When present, omits the system prompt body — returns metadata only.' },
    ],
    output: [
      { name: 'id', type: 'string', required: true, constraint: 'Resolved subagent id.' },
      { name: 'name', type: 'string', required: true, constraint: 'Subagent name.' },
      { name: 'plugin', type: 'string', required: true, constraint: 'Plugin the subagent belongs to, or _ for a scope-root agent.' },
      { name: 'scope', type: 'string', required: true, constraint: 'Scope it resolved from.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the .md file.' },
      { name: 'description', type: 'string', required: true, constraint: 'Frontmatter description.' },
      { name: 'model', type: 'string | null', required: true, constraint: 'Declared model, or null.' },
      { name: 'tools', type: 'string[] | null', required: true, constraint: 'Declared tool allow-list, or null.' },
      { name: 'system_prompt', type: 'string', required: false, constraint: 'Markdown body applied as the appended system prompt. Omitted with --no-body.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const nameRaw = input['name'] as string;
    const scopeStr = input['scope'] as string | undefined;
    const noBody = input['noBody'] === true;
    const resolveOpts: { scope?: Scope } = {};
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved !== 'all') resolveOpts.scope = resolved;
    }
    const sub = resolveSubagent(nameRaw, resolveOpts);
    const out: Record<string, unknown> = {
      id: subagentId(sub),
      name: sub.name,
      plugin: sub.plugin,
      scope: sub.scope,
      path: sub.path,
      description: sub.frontmatter.description !== undefined ? sub.frontmatter.description : '',
      model: sub.frontmatter.model !== undefined ? sub.frontmatter.model : null,
      tools: sub.frontmatter.tools !== undefined ? sub.frontmatter.tools : null,
    };
    if (!noBody) out['system_prompt'] = sub.systemPrompt;
    return out;
  },
});

const SUBAGENT_STUB = (name: string, description: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n# model: claude-sonnet-4-5        # optional: model pattern/id passed via --model\n# tools: read, grep, find, ls, bash  # optional (pi): tool allow-list passed via --tools\n---\n\nYou are ${name}. Describe the persona, responsibilities, and output format here.\nThis markdown body is applied as the spawned agent's appended system prompt.\n`;

const subagentScaffold = defineLeaf({
  name: 'scaffold',
  help: {
    name: 'agent subagent scaffold',
    summary: 'create a subagent definition stub (markdown + frontmatter) under <scope>/agents',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'Subagent name; also the filename stem (<name>.md).' },
      { kind: 'flag', name: 'description', type: 'string', required: false, constraint: 'Short description written to frontmatter. Required for the subagent to appear in listings.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Default: project if available, else user.' },
    ],
    output: [
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the scaffolded .md file.' },
      { name: 'id', type: 'string', required: true, constraint: 'Resolved subagent id.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Next step to edit and use the subagent.' },
    ],
    outputKind: 'object',
    effects: [
      'Creates `<scope-root>/agents/<name>.md` with a frontmatter + body stub.',
      'Fails if the file already exists.',
    ],
  },
  run: async (input) => {
    const name = (input['name'] as string).trim();
    if (name === '' || name.includes('/')) {
      throw usage('subagent name must be a non-empty single segment (no slashes)');
    }
    const description = typeof input['description'] === 'string' ? (input['description'] as string) : '';
    const scopeStr = input['scope'] as string | undefined;

    let scope: Scope;
    if (scopeStr !== undefined) {
      const resolved = resolveScopeArg(scopeStr);
      if (resolved === 'all') throw usage('scope must be user or project, not all');
      scope = resolved;
    } else {
      scope = projectScopeRoot() !== null ? 'project' : 'user';
    }

    const scopeRootPath = requireScopeRoot(scope);
    ensureScopeInitialized(scope, scopeRootPath);
    const dir = scopeAgentsDir(scope);
    if (dir === null) throw general(`no agents dir for scope ${scope}`);
    const filePath = join(dir, `${name}.md`);
    if (pathExists(filePath)) throw general(`subagent already exists: ${filePath}`);
    ensureDir(dir);
    writeFileSync(filePath, SUBAGENT_STUB(name, description), 'utf8');

    return {
      path: filePath,
      id: name,
      follow_up: `Edit ${filePath}, then delegate with \`crtr agent new --agent ${name}\`.`,
    };
  },
});

const subagentBranch = defineBranch({
  name: 'subagent',
  help: {
    name: 'agent subagent',
    summary: 'define and inspect reusable subagent personas (markdown + frontmatter)',
    model:
      'A subagent is a markdown file with YAML frontmatter (name, description, optional model/tools) whose body becomes a spawned worker\'s appended system prompt — the same model as the pi subagent extension, surfaced through crtr. Files live under `<scope-root>/agents/*.md` (and plugins\' `agents/`). `list` enumerates them, `read` loads one\'s body + metadata, `scaffold` creates a stub. Spawn one with `crtr agent new --agent <name>`.',
    dynamicState: buildSubagentCatalog,
    children: [
      { name: 'list', desc: 'list defined subagents', useWhen: 'discovering which personas are available' },
      { name: 'read', desc: 'load a subagent\'s system prompt + metadata', useWhen: 'inspecting a persona before using or editing it' },
      { name: 'scaffold', desc: 'create a subagent stub under <scope>/agents', useWhen: 'defining a new subagent' },
    ],
  },
  children: [subagentList, subagentRead, subagentScaffold],
});

// ---------------------------------------------------------------------------
// agent (root umbrella)
// ---------------------------------------------------------------------------

export function registerAgent(): BranchDef {
  return defineBranch({
    name: 'agent',
    rootEntry: {
      concept: 'workers you spawn to offload work to a fresh context. `agent new` runs an agent on any task and hands back just the conclusion; results collected by job handle',
      desc: 'spawn agent workers and manage subagent personas',
      useWhen: 'almost any self-contained task — reach for `agent new` OFTEN, and earlier than feels necessary, to keep work off your own context. Two habits pay off most: (1) before working in unfamiliar code, send a quick recon agent to map it first — a fast, cheap model (e.g. haiku) handles "where does X live / how does Y work" fine and keeps the digging out of your context; (2) when subtasks are independent, fan them out as parallel workers instead of doing them in series. Each worker runs in a fresh context and hands back only its conclusion. Blocking by default (returns inline like a function call); inside tmux the worker runs in an unfocused pane of the dedicated subagent session — press Alt-o to watch or steer it. --background fans out without waiting. Select a persona with `--agent <id>` (see `agent subagent`). Only trivial one-shot lookups are worth doing inline.',
      dynamicState: buildSubagentCatalog,
    },
    help: {
      name: 'agent',
      summary: 'spawn agent workers and manage subagent personas',
      model:
        '`agent new` spawns a worker (general-purpose by default, or a defined persona via `--agent <id>`); `agent fork` carries the current session context to a new pane; `agent subagent` manages persona definitions. Spawned workers register as jobs — monitor and collect at `crtr job`. Spec, plan, and debug workflows live under `crtr mode`.',
      dynamicState: buildSubagentCatalog,
      children: [
        { name: 'new', desc: 'spawn a worker — general-purpose by default, or a defined subagent via --agent', useWhen: 'delegating any self-contained task (the main spawn command)' },
        { name: 'fork', desc: 'fork current session into a sibling pane', useWhen: 'branching the current session\'s context into a new agent' },
        { name: 'subagent', desc: 'define and inspect reusable subagent personas', useWhen: 'managing markdown subagent definitions or seeing what personas exist' },
      ],
    },
    children: [newPrompt, newFork, subagentBranch],
  });
}
