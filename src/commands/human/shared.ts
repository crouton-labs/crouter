import { readConfig } from '../../core/config.js';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { atomicWriteJson, readJson } from '@crouton-kit/humanloop';
import { countPanesInCurrentWindow, spawnAndDetach, shellQuote } from '../../core/spawn.js';

export const DECK_SCHEMA_HINT =
  'Deck must match the humanloop deck schema: {title?, ' +
  'source?:{sessionName?,askedBy?,blockedSince?}, ' +
  'interactions:[{id,title,subtitle?,(body?|bodyPath?),options:[{id,label,' +
  'description?}],multiSelect?,allowFreetext?,freetextLabel?,' +
  "kind?:'notify'|'validation'|'decision'|'context'|'error'}]}.";

export interface RunRecord {
  mode: 'ask' | 'approve' | 'notify' | 'review';
  job_id?: string;
  approve_iid?: string;
  file?: string;
  output?: string;
  /** tmux pane id of the detached TUI, recorded so `human cancel` can kill it. */
  pane_id?: string;
}

export function resolveMaxPanes(): number {
  return readConfig('user').max_panes_per_window;
}

export function pickPlacement(): 'split-h' | 'new-window' {
  return countPanesInCurrentWindow() >= resolveMaxPanes() ? 'new-window' : 'split-h';
}

export function runCmd(dir: string): string {
  return `CRTR_HUMAN_DIR=${shellQuote(dir)} crtr human _run`;
}

export function followUpResult(_jobId: string): string {
  return "The human's answer is delivered to your inbox when they respond — no need to poll.";
}

export function followUpDrain(_jobId: string): string {
  return (
    'Not in tmux: a human must drain it — run `crtr human inbox` (or re-run ' +
    'inside tmux). The answer then arrives in your inbox.'
  );
}

/**
 * Road sign for a spawned `human review`. It is a non-blocking kickoff, so the
 * text steers the caller to stop rather than wait, verify, or re-present: the
 * pane is already live and tracks the file, and the comments arrive via the
 * inbox/wake when the human submits.
 */
export function followUpReview(_jobId: string): string {
  return (
    "The document is live on the human's screen for anchored, line-by-line " +
    'review. The pane tracks the file — edit the .md in place and it re-renders ' +
    'on save, so never cancel and re-present just to show a change. Do not poll, ' +
    'verify it opened, or background this call; end your turn. The human reviews ' +
    'on their own time, and their comments (with any line edits) arrive in your ' +
    'inbox and wake you when they submit.'
  );
}

/**
 * Spawn the detached `_run` pane that drives the humanloop TUI for this node.
 * Returns whether the pane spawned and the follow_up road sign. Degrades to the
 * inbox-drain follow_up when not in tmux / spawn fails — kickoffs are
 * intentionally non-fatal off-tmux.
 *
 * Completion routing needs no bookkeeping here: the human node was created
 * under the asking node as its parent (spawnNode auto-subscribes the parent),
 * so the `pushFinal` the `_run` worker emits — for ask, approve, AND review —
 * fans the answer straight into the asking node's inbox. The pane id is recorded
 * on run.json (not returned) so `human cancel` can later kill the TUI.
 */
export function spawnHumanJob(
  jobId: string,
  idir: string,
  cwd: string,
): { spawned: boolean; follow_up: string } {
  const spawn = spawnAndDetach({
    command: runCmd(idir),
    cwd,
    jobId,
    placement: pickPlacement(),
    killAfterSeconds: 0,
  });
  if (spawn.status !== 'spawned') {
    return { spawned: false, follow_up: followUpDrain(jobId) };
  }
  // Record the pane id on run.json so `human cancel` can later kill the TUI.
  // run.json was already written by the caller; merge the pane id in place.
  if (spawn.paneId !== undefined) {
    const rcPath = join(idir, 'run.json');
    const rc = readJson<RunRecord>(rcPath);
    if (rc !== null) atomicWriteJson(rcPath, { ...rc, pane_id: spawn.paneId });
  }
  return { spawned: true, follow_up: followUpResult(jobId) };
}

/**
 * Best-effort kill of a humanloop worker pane. SAFETY-CRITICAL: a malformed or
 * empty `-t` target makes tmux fall back to the CALLER's current pane, so a bad
 * paneId could kill the agent's own pi pane (and, if it is the last pane, the
 * whole session). This refuses to kill anything that is not provably the worker:
 *
 *   1. paneId must be a real tmux pane id (`%<n>`) — never an empty/odd string.
 *   2. The pane's start command must contain `verify` (the interaction dir, which
 *      humanloop bakes into the worker's `CRTR_HUMAN_DIR=... crtr human _run`
 *      launch). A shell (`zsh -l`) or the agent's pi never matches, so we can
 *      only ever kill the exact worker we spawned for this job.
 *
 * Returns true only when a matching pane was found and killed. Never throws.
 */
export function killPane(paneId: string, verify: string): boolean {
  if (!/^%\d+$/.test(paneId)) return false;
  const probe = spawnSync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_start_command}'], {
    encoding: 'utf8',
  });
  // Pane is gone (status !== 0) → nothing to kill. Pane exists but its launch
  // command doesn't carry our interaction dir → it is NOT our worker; refuse.
  if (probe.status !== 0 || !probe.stdout.includes(verify)) return false;
  const r = spawnSync('tmux', ['kill-pane', '-t', paneId], { encoding: 'utf8' });
  return r.status === 0;
}
