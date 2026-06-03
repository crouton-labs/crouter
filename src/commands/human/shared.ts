import { readConfig } from '../../core/config.js';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countPanesInCurrentWindow, spawnAndDetach, shellQuote } from '../../core/spawn.js';
import { reportsDir } from '../../core/canvas/paths.js';

export const DECK_SCHEMA_HINT =
  'Deck must match the humanloop deck schema: {title?, ' +
  'source?:{sessionName?,askedBy?,blockedSince?}, ' +
  'interactions:[{id,title,subtitle?,(body?|bodyPath?),options:[{id,label,' +
  'description?,shortcut?}],multiSelect?,allowFreetext?,freetextLabel?,' +
  "kind?:'notify'|'validation'|'decision'|'context'|'error'}]}.";

export interface RunRecord {
  mode: 'ask' | 'approve' | 'notify' | 'review';
  job_id?: string;
  approve_iid?: string;
  file?: string;
  output?: string;
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
 * Spawn the detached `_run` pane that drives the humanloop TUI for this node.
 * Returns whether the pane spawned, the follow_up text, and (when spawned) the
 * tmux pane id so a blocking caller (review) can detect the pane dying before
 * the human submits. Degrades to the inbox-drain follow_up when not in tmux /
 * spawn fails — kickoffs are intentionally non-fatal off-tmux.
 *
 * Completion routing needs no bookkeeping here: the human node was created
 * under the asking node as its parent (spawnNode auto-subscribes the parent),
 * so the `pushFinal` the `_run` worker emits fans the answer straight into the
 * asking node's inbox.
 */
export function spawnHumanJob(
  jobId: string,
  idir: string,
  cwd: string,
): { spawned: boolean; follow_up: string; paneId?: string } {
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
  return {
    spawned: true,
    follow_up: followUpResult(jobId),
    ...(spawn.paneId !== undefined ? { paneId: spawn.paneId } : {}),
  };
}

/** True when a tmux pane is still alive. */
function paneAlive(paneId: string): boolean {
  const r = spawnSync('tmux', ['display-message', '-p', '-t', paneId, '#{pane_id}'], {
    encoding: 'utf8',
  });
  return r.status === 0 && r.stdout.trim() !== '';
}

export interface HumanResult {
  status: string;
  result?: unknown;
  reason?: string;
}

/**
 * Block until `nodeId` emits a `final` report (the human submitted) or — when a
 * pane id is given — that pane dies before submitting (the human closed it).
 * Polls once a second: this is a human-time operation, so a coarse poll is fine
 * and sidesteps fs.watch directory-existence races. The `_run` worker writes
 * the humanloop result as the report body (JSON), which we parse back out.
 */
export function waitForFinalReport(nodeId: string, paneId?: string): Promise<HumanResult> {
  const dir = reportsDir(nodeId);
  const findFinal = (): string | null => {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir).filter((f) => f.endsWith('-final.md')).sort();
    return files.length > 0 ? join(dir, files[files.length - 1]!) : null;
  };
  const parse = (path: string): HumanResult => {
    const body = readFileSync(path, 'utf8').replace(/^---[\s\S]*?---\n/, '').trim();
    try {
      return { status: 'done', result: JSON.parse(body) };
    } catch {
      return { status: 'done' };
    }
  };
  const immediate = findFinal();
  if (immediate !== null) return Promise.resolve(parse(immediate));
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const p = findFinal();
      if (p !== null) {
        clearInterval(timer);
        resolve(parse(p));
        return;
      }
      if (paneId !== undefined && !paneAlive(paneId)) {
        clearInterval(timer);
        resolve({ status: 'closed', reason: 'review pane closed before submit' });
      }
    }, 1000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}
