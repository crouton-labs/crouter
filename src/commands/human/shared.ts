import { readConfig } from '../../core/config.js';
import { countPanesInCurrentWindow, spawnAndDetach, shellQuote } from '../../core/spawn.js';
import { currentSessionContext, hostNodeIdFor, findSessionByRootPane, findSessionByPiSession, loadSessionView } from '../../core/sessions.js';
import { recordJobPane, recordJobReportTo, appendEvent } from '../../core/jobs.js';

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

export function followUpResult(jobId: string): string {
  return `crtr job read result ${jobId}`;
}

export function followUpDrain(jobId: string): string {
  return (
    'Not in tmux: a human must drain it — run `crtr human inbox` (or re-run ' +
    `inside tmux). Then: crtr job read result ${jobId}`
  );
}

/**
 * Spawn the detached `_run` pane for a job-backed kickoff, record the pane for
 * cancellation, log the start, and return whether the pane spawned plus the
 * appropriate follow_up. Degrades to the inbox-drain follow_up (job still
 * created) when not in tmux / spawn fails — kickoffs are intentionally
 * non-fatal off-tmux.
 */
/**
 * Record completion routing for a human job (R1/R2) so its answer injects into
 * the pi parent that asked. Sets report_to to the spawning node when one exists:
 *   - inside a spawned agent: report_to=[parent job id], session=CRTR_SESSION_ID
 *   - top-level human pane:    report_to=[pane host node], session resolved by
 *     the originating tmux pane (only if a session already exists)
 * Absent any resolvable parent/session, routing is left empty (notification
 * skipped) per the spec.
 */
export function recordHumanReportTo(jobId: string, title: string): void {
  const { sessionId: envSession, parentJobId } = currentSessionContext();
  const pane = process.env['TMUX_PANE'];
  // The session lives under the spawner's cwd namespace (CRTR_SESSION_CWD when
  // inside a spawned agent), else this process's cwd for a top-level pane.
  // Recorded so delivery targets the same namespace the parent watcher reads.
  const sessionCwd = process.env['CRTR_SESSION_CWD'] && process.env['CRTR_SESSION_CWD'] !== ''
    ? process.env['CRTR_SESSION_CWD']
    : process.cwd();
  // The pi conversation that owns this top-level pane (injected by the
  // inbox-watcher extension); identity follows the conversation, not the pane.
  const piSessionId = process.env['CRTR_PI_SESSION_ID'] && process.env['CRTR_PI_SESSION_ID'] !== ''
    ? process.env['CRTR_PI_SESSION_ID']
    : null;
  let sessionId: string | null = envSession;
  let reportTo: string[] | undefined;
  if (envSession !== null) {
    // Spawned-agent context: report to the parent job node.
    // Phase 4.4: drop hostPaneNodeId(pane) fallback — parentJobId is always
    // set for a spawned agent (CRTR_PARENT_JOB_ID or CRTR_JOB_ID).
    reportTo = [parentJobId ?? ''].filter((s) => s !== '');
  } else {
    // Top-level: bind to the pi conversation's session, falling back to a
    // pane-keyed lookup when no pi id is available.
    const found = (piSessionId !== null ? findSessionByPiSession(piSessionId, sessionCwd) : null)
      ?? (pane !== undefined && pane !== '' ? findSessionByRootPane(pane, sessionCwd) : null);
    if (found !== null) {
      const view = loadSessionView(found, sessionCwd);
      if (view !== null) {
        sessionId = found;
        // Phase 4.4: use root_node_id authoritatively; fall back to legacy hostNodeIdFor.
      reportTo = [view.root_node_id ?? hostNodeIdFor(view)];
      }
    }
  }
  if (sessionId === null || reportTo === undefined || reportTo.length === 0) return;
  recordJobReportTo(jobId, { reportTo, sessionId, sessionCwd, name: 'human', title });
}

export function spawnHumanJob(jobId: string, idir: string, cwd: string): { spawned: boolean; follow_up: string } {
  const spawn = spawnAndDetach({
    command: runCmd(idir),
    cwd,
    jobId,
    placement: pickPlacement(),
    killAfterSeconds: 0,
    failGuard: true,
  });
  if (spawn.status !== 'spawned') {
    return { spawned: false, follow_up: followUpDrain(jobId) };
  }
  if (spawn.paneId !== undefined) recordJobPane(jobId, spawn.paneId);
  const paneLabel = spawn.paneId !== undefined ? spawn.paneId : 'unknown';
  appendEvent(jobId, {
    level: 'info',
    event: 'worker_started',
    message: `human pane ${paneLabel} spawned`,
  });
  return { spawned: true, follow_up: followUpResult(jobId) };
}
