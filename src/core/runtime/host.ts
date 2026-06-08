// src/core/runtime/host.ts
//
// The Host abstraction (design §3): owns an engine PROCESS's lifecycle, not its
// display. TWO impls live here: TmuxPaneHost — a thin wrapper over today's
// placement functions (the pane IS the engine container) — and, since Phase 3,
// HeadlessBrokerHost — a detached broker process with no tmux pane. `host_kind`
// (on the node row/meta since Wave 1) selects between them via hostFor().
//
// IMPORT-LINT (tmux-surface.test.ts §5.1): this file must NOT import './tmux.js'
// directly. It reaches every driver verb (piCommand, reviveIntoPlacement,
// isNodePaneAlive, tearDownNode) through placement.ts's re-exports — placement.ts
// and tmux-chrome.ts are the only sanctioned tmux.ts importers. The broker host
// needs no tmux verb at all.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import {
  reviveIntoPlacement,
  isNodePaneAlive,
  tearDownNode,
  piCommand,
} from './placement.js';
import { getNode, type NodeMeta, type NodeRow } from '../canvas/index.js';
import { nodeDir } from '../canvas/paths.js';
import { encodeFrame } from './broker-protocol.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import { isPidAlive } from './pid.js';
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

// ---------------------------------------------------------------------------
// HeadlessBrokerHost (design §3.3): a detached broker PROCESS, no tmux pane. It
// boots the dedicated broker-cli entry directly (NEVER src/cli.ts), supervises
// via the broker pid recorded as pi_pid, and tears down over the node's unix
// socket (graceful `shutdown` frame, SIGTERM fallback).
// ---------------------------------------------------------------------------

/** Resolve the absolute path to the broker entry. At runtime this file is
 *  dist/core/runtime/host.js; the entry lives at dist/core/runtime/broker-cli.js
 *  (sibling in the same directory) — the manage.ts/resolveCrtrdEntry pattern. */
function resolveBrokerEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'broker-cli.js');
}

export const headlessBrokerHost: Host = {
  launch(nodeId, inv, opts) {
    const dir = nodeDir(nodeId);
    mkdirSync(dir, { recursive: true });
    // The broker reads this recipe back via runBroker(nodeId) → broker-launch.json.
    writeFileSync(join(dir, 'broker-launch.json'), JSON.stringify(inv));
    const child = spawn(process.execPath, [resolveBrokerEntry(), nodeId], {
      cwd: opts.cwd,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ...inv.env, [FRONT_DOOR_ENV]: '1' },
    });
    child.unref();
    return { kind: 'broker', pid: child.pid ?? null, window: null, session: '', pane: null };
  },
  isAlive(node) {
    return isPidAlive((typeof node === 'string' ? getNode(node) : node)?.pi_pid);
  },
  teardown(nodeId) {
    // Graceful: connect to view.sock + send a `shutdown` frame → the broker
    // dispose()s the engine, unlinks the socket, exits 0. Status is already
    // flipped done/canceled by the caller (crash-safe ordering), so the daemon
    // won't revive. On connect failure (broker dead/crashed) fall back to a
    // SIGTERM of the broker pid + unlink the stale socket.
    const sockPath = join(nodeDir(nodeId), 'view.sock');
    const cleanupSocket = () => {
      try {
        if (existsSync(sockPath)) unlinkSync(sockPath);
      } catch {
        /* best-effort cleanup */
      }
    };
    const sock = connect(sockPath);
    let connected = false;
    sock.on('error', () => {
      // A post-connect error (broker exiting after we sent shutdown) is benign
      // and swallowed; only a connect failure triggers the SIGTERM fallback.
      if (connected) return;
      const pid = getNode(nodeId)?.pi_pid;
      if (pid != null) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      cleanupSocket();
    });
    sock.once('connect', () => {
      connected = true;
      try {
        sock.write(encodeFrame({ type: 'shutdown' }));
      } catch {
        /* the broker may have raced us to exit */
      }
      sock.end();
      cleanupSocket();
    });
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

/** Select the Host for a node by its persisted `host_kind` (NULL/'tmux' → the
 *  tmux host; 'broker' → the headless broker host). The param is `NodeMeta |
 *  NodeRow` so both call sites — reviveNode `hostFor(meta)` and the daemon
 *  `hostFor(row)` — share one selector. */
export function hostFor(node: NodeMeta | NodeRow): Host {
  return node.host_kind === 'broker' ? headlessBrokerHost : tmuxPaneHost;
}
