// `crtr canvas tmux-spread <node>` — explode the local subtree into a tiled grid.
//
// Bound by the alt+c → `e` chord (config: prefixBinds['e'].run = "canvas
// tmux-spread {self}"). It "expands" the graph you are watching: the caller's
// own viewer pane is broken out into a BRAND-NEW window, then a `crtr attach`
// viewer pane is tiled beside it for every broker-alive node in the local
// subtree (ancestry root → self → descendants), so the user lands on a single
// window showing the whole live subtree at once.
//
// SCOPE — the LOCAL SUBTREE: climbRoot(self) → the ancestry root, then every
// node under it (subtreeIds). TARGET — "broker-alive" nodes: status in
// (active, idle) AND isPidAlive(pi_pid); self included. CAP — 8 panes total,
// most-recently-active first (pi session-file mtime, descending). Self's pane is
// always shown (it is the anchor being broken out); up to 7 others fill the rest,
// and any beyond that are an `overflow` count.
//
// crtr is tmux-only and this is pure viewer chrome: it reuses the placement
// layer (openViewerWindow / registerViewerFocus) and the §5.1 import-lint front
// door (breakPane / selectLayout re-exported through placement), never importing
// tmux.ts directly.

import { statSync } from 'node:fs';
import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { climbRoot, subtreeIds } from '../core/canvas/nav-model.js';
import { isPidAlive } from '../core/canvas/pid.js';
import { getNode, setFocusPane, closeFocusRow } from '../core/canvas/index.js';
import type { NodeMeta } from '../core/canvas/index.js';
import {
  inTmux,
  currentTmux,
  breakPane,
  selectLayout,
  openViewerWindow,
  paneLocation,
  paneExists,
  closePane,
  getPaneOption,
  switchClient,
  selectWindow,
  focusOf,
  focusByPane,
  waitForBrokerViewSocket,
} from '../core/runtime/placement.js';

/** Hard ceiling on panes in the spread window (self + up to 7 siblings). */
const PANE_CAP = 8;

/** Recency key for ranking: the mtime of a node's pi session `.jsonl`, captured
 *  in `pi_session_file`. A node that never captured a session file (or whose file
 *  is gone) sorts last (0). */
function sessionMtime(meta: NodeMeta): number {
  const f = meta.pi_session_file;
  if (f === undefined || f === null || f === '') return 0;
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** A node whose broker engine is currently live and attachable. */
function brokerAlive(meta: NodeMeta): boolean {
  return (meta.status === 'active' || meta.status === 'idle') && isPidAlive(meta.pi_pid ?? null);
}

export const tmuxSpreadLeaf: LeafDef = defineLeaf({
  name: 'tmux-spread',
  description: 'break the caller\'s pane into a new window and tile a viewer for every broker-alive node in the local subtree',
  whenToUse: 'you want the whole live subtree you are watching on one tiled tmux window at once — bound to the alt+c → e chord; rarely run by hand',
  help: {
    name: 'canvas tmux-spread',
    summary:
      'Explode the local subtree into a tiled grid: break the caller\'s viewer pane into a brand-new window, then tile a `crtr attach` viewer pane beside it for every broker-alive node (status active/idle + live pi_pid) in the ancestry-root subtree, most-recently-active first, capped at 8 panes',
    params: [
      {
        kind: 'positional',
        name: 'node',
        required: true,
        constraint: 'The spread anchor (self) — its ancestry root + descendants define the subtree to tile. The alt+c chord passes {self}.',
      },
      {
        kind: 'flag',
        name: 'pane',
        type: 'string',
        required: false,
        constraint: 'tmux pane id of the caller\'s viewer (the pane broken into the new window). Defaults to $TMUX_PANE.',
      },
    ],
    output: [
      { name: 'window', type: 'string', required: false, constraint: 'The new window id holding the tiled spread.' },
      { name: 'session', type: 'string', required: false, constraint: 'The session the spread window lives in (the caller\'s session — break-pane keeps it).' },
      { name: 'panes', type: 'number', required: true, constraint: 'How many panes the spread window ended with (self + opened siblings).' },
      { name: 'nodes', type: 'string', required: true, constraint: 'Space-joined ids tiled into the window (self first).' },
      { name: 'overflow', type: 'number', required: true, constraint: 'Broker-alive siblings beyond the cap that were NOT shown.' },
    ],
    outputKind: 'object',
    effects: [
      'Breaks the caller\'s viewer pane into a brand-new tmux window (tmux break-pane).',
      'Opens a `crtr attach` viewer pane (and a focuses row) for each shown sibling, moving any that had a viewer elsewhere into the spread.',
      'Tiles the window and switches the client onto it.',
    ],
  },
  run: async (input) => {
    if (!inTmux()) {
      throw new InputError({
        error: 'no_tmux',
        message: 'tmux-spread needs a tmux server — crtr placement is tmux-only.',
        next: 'Run from inside a tmux session (an agent viewer pane).',
      });
    }

    const anchorId = input['node'] as string;
    // Resolve the caller's viewer pane like placement.focus() does: an explicit
    // --pane, else $TMUX_PANE (set when run via tmux run-shell / the alt+c
    // chord), else the attached client's active pane (the graph-modal `e` path
    // shells from the headless broker, which carries no $TMUX_PANE).
    const callerPane =
      (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'] ?? currentTmux()?.pane;
    if (callerPane === undefined || callerPane === '') {
      throw new InputError({
        error: 'no_pane',
        message: 'no caller pane to break out',
        next: 'Run from inside an agent\'s pane, or pass --pane <pane-id>.',
      });
    }

    const anchor = getNode(anchorId);
    if (anchor === null) {
      throw new InputError({
        error: 'not_found',
        message: `no node: ${anchorId}`,
        next: 'List nodes with `crtr node inspect list`.',
      });
    }

    // Local subtree: ancestry root → every descendant (root itself is excluded by
    // subtreeIds, so prepend it). Then keep only broker-alive nodes.
    const root = climbRoot(anchorId);
    const candidates = [root, ...subtreeIds(root)]
      .map((id) => getNode(id))
      .filter((m): m is NodeMeta => m !== null && brokerAlive(m));

    // Rank the OTHER nodes most-recently-active first; self is always the anchor,
    // so it claims one pane and up to PANE_CAP-1 siblings fill the rest.
    const others = candidates
      .filter((m) => m.node_id !== anchorId)
      .sort((a, b) => sessionMtime(b) - sessionMtime(a));
    const shown = others.slice(0, PANE_CAP - 1);
    const overflow = others.length - shown.length;

    // Break the caller's pane into a fresh window — the spread anchor. The pane
    // keeps its %id, only its window changes; break-pane keeps it in the caller's
    // session. A failure here is a real error (no half-spread fallback).
    const broken = breakPane(callerPane);
    if (broken === null) {
      throw new InputError({
        error: 'break_failed',
        message: `tmux break-pane failed for ${callerPane}`,
        next: 'Ensure the pane exists and tmux is healthy.',
      });
    }
    const anchorPane = broken.pane;
    const window = broken.window;
    const session = paneLocation(anchorPane)?.session ?? null;

    // Keep the viewer registry correct: re-point self's focus row at the moved
    // pane's (possibly new) session cache.
    const selfFocus = focusByPane(callerPane);
    if (selfFocus !== null) setFocusPane(selfFocus.focus_id, anchorPane, session);

    const spreadIds: string[] = [anchorId];
    for (const m of shown) {
      const id = m.node_id;
      // UNIQUE(node_id): a sibling that already has a viewer ELSEWHERE must be
      // MOVED into the spread — vacate its old pane + row first (mirror focus()
      // case (c)): only kill the pane if it still carries THIS node's @crtr_node
      // tag (else it is the user's shell / another node's viewer — drop the stale
      // row only).
      const prior = focusOf(id);
      if (prior !== null && prior.pane !== null) {
        if (paneExists(prior.pane) && getPaneOption(prior.pane, '@crtr_node') === id) {
          closePane(prior.pane);
        }
        closeFocusRow(prior.focus_id);
      }
      // Broker is already alive, but close the cold-start race before attach.
      waitForBrokerViewSocket(id);
      const row = openViewerWindow(id, session ?? '', { cwd: m.cwd, besidePane: anchorPane });
      if (row === null) continue; // tmux refused this split (e.g. no space) — best-effort skip
      spreadIds.push(id);
      // Re-tile after each split so the next split has room (a fixed anchor pane
      // would otherwise halve until tmux runs out of space).
      selectLayout(window, 'tiled');
    }

    selectLayout(window, 'tiled');
    if (session !== null) {
      switchClient(session);
      selectWindow(session, window);
    }

    return {
      window,
      session: session ?? undefined,
      panes: spreadIds.length,
      nodes: spreadIds.join(' '),
      overflow,
    };
  },
  render: (out) => {
    const o = out as { panes: number; window?: string; overflow: number };
    const tail = o.overflow > 0 ? ` (+${o.overflow} more not shown)` : '';
    return `spread ${o.panes} pane(s) into window ${o.window ?? '?'}${tail}`;
  },
});
