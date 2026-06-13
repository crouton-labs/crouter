// recycle.ts — the "finalize + reboot this pane" action behind `crtr node recycle`.
//
// Recycle FINALIZES the agent occupying a tmux pane and recycles that pane for
// fresh work, in three steps:
//
//   1. Finalize — push the agent's last surfaced message as a `final` report so
//      every subscriber/manager waiting on it is unblocked, and mark it done.
//   2. Close    — tear the agent's broker engine down (the pane is only a viewer).
//   3. Recycle  — boot a fresh resident broker root the pane re-attaches to.
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

import { getNode, setPresence, setFocusOccupant, fullName, type NodeMeta } from '../canvas/index.js';
import { reportsDir } from '../canvas/paths.js';
import { pushFinal } from '../feed/feed.js';
import { spawnNode, rootOfSpine } from './nodes.js';
import { buildLaunchSpec, buildPiArgv } from './launch.js';
import { focusOf, respawnPaneSync, setPaneOption, waitForBrokerViewSocket, viewerSplitEnv } from './placement.js';
import { headlessBrokerHost } from './host.js';
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

  // The node's pane is a VIEWER (`crtr attach`), not its engine: the engine is
  // the detached broker process, so respawn-pane -k below would only kill the
  // viewer, never the engine. Tear the broker PROCESS down so it exits and
  // releases the sole .jsonl writer. Status is already flipped done by pushFinal
  // above (crash-safe order: the daemon won't revive a done node).
  try { headlessBrokerHost.teardown(nodeId); } catch { /* best-effort */ }

  // Capture M's focus viewport (if any) BEFORE nulling — the fresh root inherits
  // it (the SAME focus row + pane). The demoted node no longer holds a pane: it is
  // being reclaimed.
  const f = focusOf(nodeId);
  try { setPresence(nodeId, { pane: null, window: null, tmux_session: null }); } catch { /* best-effort */ }

  // 2 + 3. Recycle — boot a fresh resident BROKER root for the SAME pane: the
  // viewer pane re-attaches to the fresh broker (broker-is-the-host — the viewer
  // pane stays a viewer, never becomes an engine pane).
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
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
  // Hand the viewport to the fresh root: reuse M's focus row over the SAME pane
  // (respawn-pane -k below keeps the %id), so the user keeps watching this slot.
  if (f !== null) { try { setFocusOccupant(f.focus_id, root.node_id); } catch { /* best-effort */ } }
  const fresh = getNode(root.node_id) as NodeMeta;
  const inv = buildPiArgv(fresh);
  // CRTR_SUBTREE groups the fresh root's subtree; FRONT_DOOR is set by the broker
  // host itself, so it is not added here.
  inv.env = { ...inv.env, CRTR_SUBTREE: rootOfSpine(root.node_id) };

  const ok = recycleBrokerViewer(fresh, pane, inv);

  return { recycled: ok, finalized, newRoot: root.node_id, delivered };
}

/** Recycle a BROKER root into `pane`: the fresh root is broker-hosted, so its
 *  engine runs in a DETACHED broker, not the pane. Birth-launch that broker via
 *  the Host seam (mirrors spawnChild's birth path — the host records its pid),
 *  wait for its view.sock to accept, then respawn the pane in place to the VIEWER
 *  `crtr attach to <root>`. The pane stays a viewer (attach self-tags it
 *  `@crtr_node`); it never hosts the engine. Returns false (recycle reports the
 *  pane was not respawned) when the broker never serves — the fresh root row
 *  still exists, broker-hosted, for the daemon to revive. */
function recycleBrokerViewer(fresh: NodeMeta, pane: string, inv: ReturnType<typeof buildPiArgv>): boolean {
  headlessBrokerHost.launch(fresh.node_id, inv, { cwd: fresh.cwd, name: fullName(fresh), resuming: false });
  if (!waitForBrokerViewSocket(fresh.node_id)) return false;
  // Clear the finalized node's stale `@crtr_node` tag before respawn so the tag
  // never names a done node during the gap before the new `crtr attach` re-tags
  // on connect. Node ids are shell-safe identifiers; no quoting needed.
  try { setPaneOption(pane, '@crtr_node', ''); } catch { /* best-effort */ }
  // SYNC respawn: the recycle command runs as a SEPARATE CLI process (the viewer
  // runs `crtr attach`, a TUI — it never execs recycle), so we are NOT respawning
  // our own pane and can confirm the respawn actually landed (the honest exit
  // status), unlike the tmux path which often recycles the caller's own pane.
  return respawnPaneSync({ pane, cwd: fresh.cwd, env: viewerSplitEnv(), command: `crtr attach to ${fresh.node_id}` });
}
