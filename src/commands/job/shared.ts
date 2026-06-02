import { listJobs } from '../../core/jobs.js';
import { stateBlock } from '../../core/help.js';

export const WAIT_BUDGET_MS = 10 * 60 * 1000;
export const FOLLOW_POLL_MS = 1000;
export const DEFAULT_KILL_SECS = 2;

/** Count of jobs currently in the live state, or null when listing fails.
 *  Backs the always-on "Workers running" signal on root -h so an agent never
 *  forgets it has in-flight workers to collect. */
export function liveJobCount(): number | null {
  try {
    return listJobs().filter((j) => j.state === 'live').length;
  } catch {
    return null;
  }
}

/** The job subtree's root-level dynamic block. A bounded aggregate (running
 *  count + how to collect), never an enumeration: live jobs are volatile and
 *  unbounded, so listing them in root -h would balloon (cli-design rule 15).
 *  Omitted when nothing is running. */
export function buildJobRootBlock(): string | null {
  const n = liveJobCount();
  if (n === null || n === 0) return null;
  return stateBlock('workers', { count: n }, '`crtr job read list` to see them; `crtr job read result ID` to collect');
}
