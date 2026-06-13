// `crtr human` subtree — in-process humanloop bridge.
//
// Kickoff leaves (ask/review) create a kind:'human' node under the
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
import { humanAsk, humanReview, humanNotify, humanShow } from './human/prompts.js';
import { humanInbox, humanList, humanCancel, humanRun } from './human/queue.js';

export function registerHuman(): BranchDef {
  return defineBranch({
    name: 'human',
    rootEntry: {
      concept: 'human-in-the-loop decisions, document review, and live display',
      desc: 'ask, review, notify, show, cancel, inbox, list',
      useWhen:
        'you have a question for the user, want their feedback, or are presenting them with options or a choice — always reach for human instead of guessing or assuming, or laying a choice out as prose, when a person can decide; and whenever the user wants to review a spec, plan, or requirements document, this is the command (use `human review` for anchored line-by-line comments)'
    },
    help: {
      name: 'human',
      summary: 'human-in-the-loop decisions, document review, and live display',
      model:
        "Every body and displayed file is directive-flavored markdown rendered by termrender (panels, columns, trees, callouts, mermaid) — see `termrender doc -h` for the directive set before authoring one. ask and review are kickoffs: they create a kind:'human' node under you and return instantly, never blocking — the human's response is pushed to your inbox when they answer, so keep working (or just end your turn) and you'll be woken with it. ask covers everything from a yes/no sign-off gate (two options) to an open-ended judgment call; review puts a .md live on the human's screen for anchored comments and tracks the file, so edit in place rather than canceling and re-presenting. notify and show create no node.",
    },
    children: [
      humanAsk,
      humanReview,
      humanNotify,
      humanShow,
      humanCancel,
      humanInbox,
      humanList,
      humanRun,
    ],
  });
}
