// src/core/runtime/host.ts
//
// The Host abstraction (design §3): owns an engine PROCESS's lifecycle, not its
// display. Phase 1 has exactly ONE impl — TmuxPaneHost — a thin wrapper over
// today's placement functions, so this whole file adds an abstraction seam with
// ZERO behavior change. The broker host + host_kind dispatch land in Phase 3.
//
// IMPORT-LINT (tmux-surface.test.ts §5.1): this file must NOT import './tmux.js'
// directly. It reaches every driver verb (piCommand, reviveIntoPlacement,
// isNodePaneAlive, tearDownNode) through placement.ts's re-exports — placement.ts
// and tmux-chrome.ts are the only sanctioned tmux.ts importers.

import {
  reviveIntoPlacement,
  isNodePaneAlive,
  tearDownNode,
  piCommand,
} from './placement.js';
import { getNode, type NodeMeta, type NodeRow } from '../canvas/index.js';
import type { PiInvocation } from './launch.js';

/** View-side launch hints the legacy host needs beyond the PiInvocation. This is
 *  today's ReviveLaunch (placement.ts) MINUS `command`/`env` — the host derives
 *  `command = piCommand(inv.argv)` and `env = inv.env` from the PiInvocation
 *  itself. The broker (Phase 3) uses only `cwd` + `resuming`. */
export interface LaunchPlacement {
  cwd: string;
  name: string;
  resuming: boolean;
}

/** A handle to a node's running engine container.
 *  §3.2 specifies { kind, pid }; Phase 1 carries the placement coords too,
 *  because launch REPLACES reviveIntoPlacement (which returned PlacementResult)
 *  and reviveNode's unchanged ReviveResult is built from window+session. The
 *  daemon never reads window/session/pane (it supervises via pid / isAlive); the
 *  broker (Phase 3) returns window=null, pane=null. */
export interface HostHandle {
  kind: 'tmux' | 'broker';
  /** Supervised pid (signal-0 target). null at launch for TmuxPaneHost: the
   *  pane's fresh pi records its own pid via the stophook (session_start →
   *  recordPid), and reviveNode clearPid()s right after launch — so no Phase-1
   *  caller reads this. Present for the §3.2 contract + the daemon. */
  pid: number | null;
  window: string | null;
  session: string;
  pane: string | null;
}

export interface Host {
  /** Bring a node's ENGINE into existence from its launch recipe; return a
   *  supervisable handle. TmuxPaneHost ALSO performs placement (the pane IS the
   *  engine container). */
  launch(nodeId: string, inv: PiInvocation, opts: LaunchPlacement): HostHandle;

  /** Is this node's engine container present? PURE / non-mutating. §3.2 types
   *  this `NodeRow`; we keep `string | NodeRow` to match isNodePaneAlive (which
   *  it IS) so both call sites — the guard (passes the id) and the Phase-2 daemon
   *  (passes a row) — stay one-token changes. */
  isAlive(node: string | NodeRow): boolean;

  /** Tear the engine down (close/cancel teardown). */
  teardown(nodeId: string): void;

  /** Deliver an OS signal to the engine container — present so the daemon never
   *  reaches around the abstraction. No Phase-1 call site. */
  signal(nodeId: string, sig: NodeJS.Signals): void;
}

/** The sole Phase-1 host: today's behavior, wrapped. Stateless → a frozen
 *  singleton, no class needed. Every method delegates verbatim. */
export const tmuxPaneHost: Host = {
  launch(nodeId, inv, opts) {
    const placed = reviveIntoPlacement(nodeId, {
      command: piCommand(inv.argv),
      env: inv.env,
      cwd: opts.cwd,
      name: opts.name,
      resuming: opts.resuming,
    });
    return { kind: 'tmux', pid: null, window: placed.window, session: placed.session, pane: placed.pane };
  },
  isAlive(node) {
    return isNodePaneAlive(node);
  },
  teardown(nodeId) {
    tearDownNode(nodeId);
  },
  signal(nodeId, sig) {
    const pid = getNode(nodeId)?.pi_pid;
    if (pid != null) {
      try {
        process.kill(pid, sig);
      } catch {
        /* already gone */
      }
    }
  },
};

/** Select the Host for a node. Phase 1: ALWAYS the tmux host, for ALL nodes —
 *  there is NO host_kind column yet (that is Phase 3). The param is accepted (and
 *  ignored) so both eventual call sites — reviveNode `hostFor(meta)` (NodeMeta)
 *  and the Phase-2 daemon `hostFor(row)` (NodeRow) — typecheck without a re-edit. */
export function hostFor(_node: NodeMeta | NodeRow): Host {
  return tmuxPaneHost;
}
