// `crtr human` subtree — in-process humanloop bridge.
//
// Kickoff leaves (ask/approve/review) create a kind:'human' node under the
// asking node, write deck.json/run.json into the per-cwd interaction dir, spawn
// a detached `crtr human _run` pane, and return immediately. The human's answer
// is pushed as the node's final report, which fans out to the asking node's
// inbox — no polling surface. notify/show create no node. _run runs the blocking
// humanloop call at the pane TTY and pushes the result itself.
//
// TTY safety: every leaf is argv-only — none declares a stdin parameter, so
// the spawned pane's TTY stays free for humanloop's raw-mode input. Control
// params travel via CRTR_HUMAN_DIR (set inline in the spawned command) +
// run.json, never stdin.

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { humanAsk, humanApprove, humanReview, humanNotify, humanShow } from './human/prompts.js';
import { humanInbox, humanList, humanCancel, humanRun } from './human/queue.js';

export function registerHuman(): BranchDef {
  return defineBranch({
    name: 'human',
    rootEntry: {
      concept:
        'human-in-the-loop decisions, document review, and live display: ask puts a structured choice to a person, approve gates a handoff on a Yes/No sign-off, review collects anchored comments on a plan or spec, notify informs without blocking, show puts a file live on screen',
      desc: 'ask, approve, review, notify, show, cancel, inbox, list',
      useWhen:
        'you have a question for the user or want their feedback — always reach for human instead of guessing or assuming when a person can decide',
    },
    help: {
      name: 'human',
      summary: 'human-in-the-loop decisions, document review, and live display',
      model:
        "Reach for human whenever you have a question for the user or want their feedback — never guess or assume when a person can decide. ask puts a structured choice in front of them; approve gates a handoff on a Yes/No sign-off; review collects anchored comments on a plan or spec; notify informs without blocking; show puts a file live on screen. Every body and displayed file is directive-flavored markdown rendered by termrender (panels, columns, trees, callouts, mermaid) — see `termrender doc -h` for the directive set before authoring one. ask/approve/review are the DEFAULT channel for questions, sign-offs, and feedback — reach for them even for quick or open-ended asks (use `allowFreetext`), and don't substitute prose in your reply. ask and approve are kickoffs: they create a kind:'human' node under you and return instantly, never blocking — the answer is pushed to your inbox when the human responds, so just keep working and you'll be woken with it. review is different: it BLOCKS until the human submits, so background the call if you want to keep working (your harness notifies you when it finishes). 'Humans respond on human time' describes response latency only — it is never a reason to avoid asking. notify/show create no node.",
      children: [
        { name: 'ask', desc: 'put a decision deck to a person', useWhen: 'a structured choice needs a human' },
        { name: 'approve', desc: 'a Yes/No approval gate', useWhen: 'gating a handoff on human sign-off' },
        { name: 'review', desc: 'anchored-comment review of a .md', useWhen: 'a human should comment on a plan or spec' },
        { name: 'notify', desc: 'fire-and-forget acknowledgement', useWhen: 'informing a person without blocking' },
        { name: 'show', desc: 'put a file live on screen', useWhen: 'displaying a doc while a human comments' },
        { name: 'cancel', desc: 'retract a pending ask/approve/review', useWhen: 'a question went stale before the human answered' },
        { name: 'inbox', desc: 'interactively drain pending interactions', useWhen: 'a human clears the queue at their terminal' },
        { name: 'list', desc: 'enumerate pending interactions', useWhen: 'discovering what is blocked on a human' },
      ],
    },
    children: [
      humanAsk,
      humanApprove,
      humanReview,
      humanNotify,
      humanShow,
      humanInbox,
      humanList,
      humanCancel,
      humanRun,
    ],
  });
}
