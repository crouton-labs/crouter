// recycle.ts — the "finalize + reboot this pane" action behind `crtr node recycle`.
//
// Recycle FINALIZES the agent occupying a tmux pane and recycles that pane for
// fresh work, in three steps:
//
//   1. Finalize — push the agent's last surfaced message as a `final` report so
//      every subscriber/manager waiting on it is unblocked, and mark it done.
//   2. Close    — kill the agent's pi (respawn-pane -k tears it down in place).
//   3. Recycle  — boot a fresh resident root in that same pane (a new `crtr`).
//
// NOT to be confused with `node demote` (flip-to-terminal IN PLACE, which keeps
// the agent focused and running): recycle ENDS this agent and boots a brand-new
// resident root here.
//
// The agent's real conversation lives inside pi (not on disk), so the final
// body is its newest report (which, on a natural stop, IS its last assistant
// message) — falling back to a short note when it never reported.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { getNode, setPresence, updateNode, setFocusOccupant, fullName, type NodeMeta } from '../canvas/index.js';
import { reportsDir } from '../canvas/paths.js';
import { pushFinal } from '../feed/feed.js';
import { spawnNode, nodeSession, rootOfSpine } from './nodes.js';
import { buildLaunchSpec, buildPiArgv } from './launch.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import { focusOf, recycleFocusPane, piCommand, paneLocation } from './placement.js';
import { hostFor } from './host.js';
import { ensureDaemon } from '../../daemon/manage.js';

export interface RecycleResult {
  /** True when the pane was recycled (a fresh root respawned in it). */
  recycled: boolean;
  /** True when a `final` report was pushed for the recycled node. */
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
 *  Best-effort; `recycled:false` when there is no pane to act on. */
export async function recycleNode(nodeId: string, callerPane?: string): Promise<RecycleResult> {
  const meta = getNode(nodeId);
  if (meta === null) return { recycled: false, finalized: false, newRoot: null, delivered: [] };

  const pane = callerPane ?? process.env['TMUX_PANE'];
  if (pane === undefined || pane === '') {
    return { recycled: false, finalized: false, newRoot: null, delivered: [] };
  }

  // 1. Finalize — fan the agent's last message out as a `final`, mark it done.
  const body = lastReportBody(nodeId) ||
    `Closed via recycle — no final summary was authored by ${meta.name}.`;
  let delivered: string[] = [];
  let finalized = false;
  try {
    const res = await pushFinal(nodeId, body);
    delivered = res.deliveredTo;
    finalized = true;
  } catch { /* recycle the pane even if the report failed */ }

  // A broker node has NO tmux pane, so recycleFocusPane below (respawn-pane -k)
  // never kills its engine — route its teardown through the Host seam so the
  // broker PROCESS exits and releases the sole .jsonl writer (mirrors the T12
  // close.ts/reset.ts fix; review reuse MINOR-3). Status is already flipped done
  // by pushFinal above (crash-safe order: the daemon won't revive a done node).
  if (meta.host_kind === 'broker') {
    try { hostFor(meta).teardown(nodeId); } catch { /* best-effort */ }
  }

  // Capture M's focus viewport (if any) BEFORE nulling — the fresh root inherits
  // it (the SAME focus row + pane). The demoted node no longer holds a pane: it is
  // being reclaimed.
  const f = focusOf(nodeId);
  try { setPresence(nodeId, { pane: null, window: null, tmux_session: null }); } catch { /* best-effort */ }

  // 2 + 3. Recycle — boot a fresh resident root in the SAME pane.
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const loc = paneLocation(pane);
  const { launch } = buildLaunchSpec('general', 'base', { lifecycle: 'resident', hasManager: false });
  const root = spawnNode({
    kind: 'general',
    mode: 'base',
    lifecycle: 'resident',
    cwd: meta.cwd,
    name: 'general',
    parent: null,
    launch,
  });
  // REVIVE-HOME: a recycled root's durable revive target is the session
  // of the pane it was recycled into (the one place home_session is rewritten
  // after birth). Falls back to the backstage when the pane can't be located.
  updateNode(root.node_id, { home_session: loc?.session ?? nodeSession() });
  // Hand the viewport to the fresh root: reuse M's focus row over the SAME pane
  // (respawn-pane -k below keeps the %id), so the user keeps watching this slot.
  if (f !== null) { try { setFocusOccupant(f.focus_id, root.node_id); } catch { /* best-effort */ } }
  const fresh = getNode(root.node_id) as NodeMeta;
  const inv = buildPiArgv(fresh);
  const env = { ...inv.env, CRTR_ROOT_SESSION: nodeSession(), CRTR_SUBTREE: rootOfSpine(root.node_id), [FRONT_DOOR_ENV]: '1' };
  const ok = recycleFocusPane(root.node_id, pane, {
    command: piCommand(inv.argv), env, cwd: meta.cwd, name: fullName(fresh), resuming: false,
  });

  return { recycled: ok, finalized, newRoot: root.node_id, delivered };
}
