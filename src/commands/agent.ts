// `crtr agent` umbrella — spawn primitives.
//
// `agent new` is the single spawn command (general-purpose by default,
// `--agent <id>` overlays a defined subagent). `agent fork` carries the
// current session context into a sibling pane. Spawning creates a job record;
// monitoring lives at `crtr job`.
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

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { buildSubagentCatalog, buildAgentSelfContext } from './agent/shared.js';
import { newPrompt, rootInitLeaf, newFork } from './agent/spawn.js';
import { focusLeaf } from './agent/focus.js';
import { notifyLeaf, inboxLeaf } from './agent/inbox.js';
import { sessionBranch } from './agent/session.js';
import { subagentBranch } from './agent/subagent.js';

export { DEFAULT_KILL_SECS, followUpResult, resolveMaxPanes, assertTmux, assertExactlyOneFocusMode } from './agent/shared.js';

// ---------------------------------------------------------------------------
// agent (root umbrella)
// ---------------------------------------------------------------------------

export function registerAgent(): BranchDef {
  return defineBranch({
    name: 'agent',
    rootEntry: {
      concept: 'workers you spawn to offload work to a fresh context. `crtr agent new` runs an agent on any task and hands back just the conclusion; results collected by job handle',
      desc: 'spawn agent workers and manage subagent personas',
      useWhen: 'you are low on context about what the user means — almost always your first move is to spawn an explore agent to build that understanding in a fresh window instead of reading files into your own. This fires before almost any task, not just research: about to implement, debug, or change code you do not already know? Scout it first — "how does this repo work / where does X live / how does auth flow" is a sweep across many files an explore agent (`--agent explore`) hands back as a conclusion. Delegate any self-contained unit you can describe: map a subsystem, implement a change, write tests, reproduce a bug. Inverse — keep it inline: a single fact in a file, symbol, or value you already know. Two reflexes: scout before you build or answer; fan out independent subtasks as concurrent workers, not serial. Once you delegate a search, do not also run it yourself — wait for the result. Spawn and collect mechanics: `crtr agent new -h`.',
      dynamicState: buildSubagentCatalog,
    },
    help: {
      name: 'agent',
      summary: 'spawn agent workers and manage subagent personas',
      model:
        '`crtr agent new` spawns a worker (general-purpose by default, or a defined persona via `--agent <id>`); `crtr agent fork` carries the current session context to a new pane; `crtr agent focus` moves a running agent pane into the caller\'s view (--new splits, --replace hands off); `crtr agent notify`/`crtr agent inbox` deliver and read events between graph nodes (completion notices to subscribers/report-to targets); `crtr agent session` is the render model + live feed (show/list/watch); `crtr agent subagent` manages persona definitions. A session is a graph of nodes (root job + agent workers) and edges; root_node_id identifies the session root. Spawned workers register as jobs — monitor and collect at `crtr job`.',
      // The defined-subagents catalog is intentionally NOT re-emitted here: it
      // already renders verbatim in `crtr -h` (via rootEntry.dynamicState).
      // `crtr agent new -h` points to `crtr agent subagent list` for the live list.
      // Instead, surface the caller's OWN standing (job id + root/worker role)
      // so a spawn never reads as "I must create a parent".
      dynamicState: buildAgentSelfContext,
      children: [
        { name: 'new', desc: 'spawn a worker — general-purpose by default, or a defined subagent via --agent', useWhen: 'delegating any self-contained task (the main spawn command)' },
        { name: 'root-init', desc: 'bootstrap the persistent root job for this pi session (idempotent)', useWhen: 'called automatically by the standing extension at session_start; agents need not call it directly' },
        { name: 'fork', desc: 'fork current session into a sibling pane', useWhen: 'branching the current session\'s context into a new agent' },
        { name: 'focus', desc: 'move a running agent pane into the caller\'s view', useWhen: 'bringing a worker alongside (--new) or handing off your pane to a worker (--replace)' },
        { name: 'notify', desc: 'deliver an event into a node\'s inbox', useWhen: 'signaling a node that a subscribed/reported-to agent completed or changed state' },
        { name: 'inbox', desc: 'read events delivered to a node', useWhen: 'checking for completion notices from agents you spawned or subscribed to' },
        { name: 'session', desc: 'read model + live feed for spawned-agent sessions', useWhen: 'inspecting or monitoring the agent graph, or powering a live UI' },
        { name: 'subagent', desc: 'define and inspect reusable subagent personas', useWhen: 'managing markdown subagent definitions or seeing what personas exist' },
      ],
    },
    children: [newPrompt, rootInitLeaf, newFork, focusLeaf, notifyLeaf, inboxLeaf, sessionBranch, subagentBranch],
  });
}
