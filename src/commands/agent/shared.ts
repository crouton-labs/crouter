import { stateBlock } from '../../core/help.js';
import { InputError } from '../../core/io.js';
import { isInTmux } from '../../core/spawn.js';
import { readConfig } from '../../core/config.js';
import { listSubagents, subagentId } from '../../core/subagents.js';
import type { Subagent } from '../../types.js';

export const DEFAULT_KILL_SECS = 2;

// The built-in, persona-less agent type. `--agent general` (or omitting --agent)
// spawns the general-purpose worker; any other id overlays a defined subagent.
export const GENERAL_AGENT = 'general';

// Decision guidance surfaced on `agent new -h`. Answers "when do I reach
// for this, how often, and which agent?" — the questions the flag constraints
// alone don't.
export const PROMPT_GUIDE = `## How to invoke

The task goes on **stdin** or as a single positional argument; the agent id and
flags are argv. Pipe it, heredoc it, or quote it inline — whichever fits.

  # Non-blocking: returns a job handle immediately; collect when ready
  echo "find where request auth is handled" | crtr agent new

  # Inline positional — equivalent to piping it on stdin
  crtr agent new --agent general "say hi"

  # With a persona: --agent overlays a defined subagent (see \`crtr agent subagent list\`)
  echo "map the daemon lifecycle" | crtr agent new --agent explore

Heredocs work for multi-line prompts: \`crtr agent new <<'EOF' ... EOF\`.

## Always non-blocking, always tmux

\`crtr agent new\` is always fire-and-forget. The worker runs as an interactive agent
in a pane of the dedicated subagent session (crtr-agents-<pane>) without
stealing your focus — press Alt-o to watch or steer it. The command returns
immediately with a job handle.

**Under pi, completions auto-inject.** When a worker finishes, a completion
notice (job_id, name, status) is pushed into your session automatically — you do
NOT need to \`--wait\` or poll \`crtr agent inbox\`. Keep working after spawning;
when the notice arrives, fetch the body with \`crtr job read result <job_id>\` only
if you need it. If you are mid-turn it arrives as a follow-up; bursts coalesce
into one notice. Pass \`--steer-on-complete\` to have a worker's completion
interrupt your current turn instead of waiting. (Under claude there is no live
push — fall back to \`crtr job read result <job_id> --wait\` / \`crtr agent inbox\`.)

To bring the worker alongside, use \`crtr agent focus <job_id> --new\` (split) or
\`--replace\` (hand off your pane). Requires tmux; errors \`not_in_tmux\` outside tmux.

You own collection — don't relay these commands to the user.

## Choosing the agent

**--agent <id>** selects which agent runs the task. Omit it (or pass
\`--agent general\`) for the general-purpose agent. Pass a defined id to overlay
that subagent: a reusable persona defined in markdown with frontmatter (see
\`crtr agent subagent\`), whose body becomes the worker's appended system prompt
and whose declared model / (pi) tools are applied for the run. Everything else
is identical. Reach for a defined agent when a recurring task has a stable
persona (a scout, a reviewer); use general for one-off delegation.`;

// A spawn leaf returns a job handle, not a result. This follow_up is the
// ORCHESTRATOR's own next call: the agent that spawned the worker collects the
// result itself and reports the findings to the user. The observed failure mode
// is relaying these commands to the human ("run this to see the result") or
// inventing a batch-await that doesn't exist — the phrasing forecloses both.
export function followUpResult(jobId: string): string {
  return `You spawned this worker — collecting its result is your job, not the user's. When you're ready for it, run \`crtr job read result ${jobId} --wait\` yourself (blocks up to 10 min), then report the worker's findings. Spawned several? Call it once per job_id — there is no batch await. Never print these commands for the user to run.`;
}

export function deriveTitle(prompt: string): string {
  const line = prompt.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().slice(0, 80);
}

export function parseNodeRefList(raw: unknown): string[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(',')) {
    const ref = part.trim();
    if (ref === '' || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
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

/**
 * Validate that exactly one of --new / --replace was passed. Exported for unit
 * testing; the focusLeaf run() handler calls this directly.
 */
export function assertExactlyOneFocusMode(input: Record<string, unknown>): void {
  const wantsNew = input['new'] === true;
  const wantsReplace = input['replace'] === true;
  if ((!wantsNew && !wantsReplace) || (wantsNew && wantsReplace)) {
    throw new InputError({
      error: 'usage',
      message: 'focus requires exactly one of --new | --replace',
      next: 'Pass exactly one: `crtr agent focus <target> --new` or `crtr agent focus <target> --replace`.',
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
export const SUBAGENT_USAGE =
  'One spawn command — `crtr agent new` — runs any of these. `--agent <id>` overlays a defined persona (its system prompt, model, and tools); omit it (or pass `--agent general`) for the general-purpose worker. Same command either way. Pick the most specific agent that fits the task, else general. A defined agent earns its keep when a task recurs with a stable shape (a scout, a reviewer); for a fast throwaway pass, general on a cheap model is usually enough.';

export function descLine(a: Subagent): string {
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
export function buildSubagentCatalog(): string | null {
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
    'Agents (select with `crtr agent new --agent <id>`):',
    `- ${GENERAL_AGENT} (default): general-purpose agent for any self-contained task — research, code search, multi-step work. Used when --agent is omitted or \`--agent ${GENERAL_AGENT}\`.`,
  ];
  for (const a of ordered) lines.push(descLine(a));

  // count includes the built-in general agent alongside the defined ones.
  return stateBlock('subagents', { count: agents.length + 1 }, lines.join('\n'));
}
