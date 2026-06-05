// demote.ts — the "graduate this agent" action behind `crtr node demote`.
//
// Demote finishes the agent occupying a tmux pane and recycles that pane for
// fresh work, in three steps:
//
//   1. Finalize — push the agent's last surfaced message as a `final` report so
//      every subscriber/manager waiting on it is unblocked, and mark it done.
//   2. Close    — kill the agent's pi (respawn-pane -k tears it down in place).
//   3. Recycle  — boot a fresh resident root in that same pane (a new `crtr`).
//
// The agent's real conversation lives inside pi (not on disk), so the final
// body is its newest report (which, on a natural stop, IS its last assistant
// message) — falling back to a short note when it never reported.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, setPresence, type NodeMeta } from '../canvas/index.js';
import { reportsDir } from '../canvas/paths.js';
import { pushFinal } from '../feed/feed.js';
import { spawnNode } from './nodes.js';
import { buildLaunchSpec, buildPiArgv } from './launch.js';
import { respawnPane, piCommand, paneLocation, nodeSession } from './tmux.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import { getFocus, setFocus } from './presence.js';
import { ensureDaemon } from '../../daemon/manage.js';

export interface DemoteResult {
  /** True when the pane was recycled (a fresh root respawned in it). */
  demoted: boolean;
  /** True when a `final` report was pushed for the demoted node. */
  finalized: boolean;
  /** The fresh root node booted into the pane, or null on failure. */
  newRoot: string | null;
  /** Subscriber node ids that received the final report. */
  delivered: string[];
}

/** The agent's most recent surfaced message: the newest reports/*.md body with
 *  its YAML frontmatter stripped. Empty string when the node never reported. */
function lastReportBody(nodeId: string): string {
  try {
    const dir = reportsDir(nodeId);
    const files = readdirSync(dir).filter((f) => f.endsWith('.md'));
    if (files.length === 0) return '';
    let newest = '';
    let newestMs = -1;
    for (const f of files) {
      const ms = statSync(join(dir, f)).mtimeMs;
      if (ms > newestMs) { newestMs = ms; newest = f; }
    }
    const raw = readFileSync(join(dir, newest), 'utf8');
    // Strip leading YAML frontmatter: ---\n …\n---\n<body>
    const m = /^---\n[\s\S]*?\n---\n/.exec(raw);
    return (m !== null ? raw.slice(m[0].length) : raw).trim();
  } catch {
    return '';
  }
}

/** Finish `nodeId` and recycle its pane into a fresh root. `callerPane` is the
 *  tmux pane the agent occupies (the Alt+C menu passes it as `#{pane_id}`).
 *  Best-effort; `demoted:false` when there is no pane to act on. */
export async function demoteNode(nodeId: string, callerPane?: string): Promise<DemoteResult> {
  const meta = getNode(nodeId);
  if (meta === null) return { demoted: false, finalized: false, newRoot: null, delivered: [] };

  const pane = callerPane ?? process.env['TMUX_PANE'];
  if (pane === undefined || pane === '') {
    return { demoted: false, finalized: false, newRoot: null, delivered: [] };
  }

  // 1. Finalize — fan the agent's last message out as a `final`, mark it done.
  const body = lastReportBody(nodeId) ||
    `Closed via demote — no final summary was authored by ${meta.name}.`;
  let delivered: string[] = [];
  let finalized = false;
  try {
    const res = await pushFinal(nodeId, body);
    delivered = res.deliveredTo;
    finalized = true;
  } catch { /* recycle the pane even if the report failed */ }

  // The demoted node no longer holds a window — the pane is being reclaimed.
  try { setPresence(nodeId, { window: null, tmux_session: null }); } catch { /* best-effort */ }
  if (getFocus() === nodeId) setFocus('');

  // 2 + 3. Recycle — boot a fresh resident root in the SAME pane.
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const loc = paneLocation(pane);
  const { launch } = buildLaunchSpec('general', 'base');
  const root = spawnNode({
    kind: 'general',
    mode: 'base',
    lifecycle: 'resident',
    cwd: meta.cwd,
    name: 'general',
    parent: null,
    launch,
  });
  if (loc !== null) setPresence(root.node_id, { tmux_session: loc.session, window: loc.window });
  const fresh = getNode(root.node_id) as NodeMeta;
  const inv = buildPiArgv(fresh);
  const env = { ...inv.env, CRTR_ROOT_SESSION: nodeSession(), [FRONT_DOOR_ENV]: '1' };
  const ok = respawnPane({ pane, cwd: meta.cwd, env, command: piCommand(inv.argv) });

  return { demoted: ok, finalized, newRoot: root.node_id, delivered };
}
