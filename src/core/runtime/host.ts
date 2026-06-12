// src/core/runtime/host.ts
//
// The Host abstraction (design §3): owns an engine PROCESS's lifecycle, not its
// display. After the broker-is-the-host cut there is ONE impl —
// HeadlessBrokerHost — a detached broker process with no tmux pane. Every node
// (managed child, named node, --root, front-door root) runs on it; a tmux pane
// is only an attach VIEWER. The `Host` interface is kept as a one-impl seam (the
// test/future-host boundary).
//
// This file imports neither './tmux.js' nor './placement.js' — the broker host
// needs no tmux verb at all (it supervises via the broker pid, tears down over
// the node's unix socket).

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, openSync, closeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect } from 'node:net';
import { getNode, type NodeRow } from '../canvas/index.js';
import { nodeDir, jobDir } from '../canvas/paths.js';
import { encodeFrame } from './broker-protocol.js';
import { FRONT_DOOR_ENV } from './front-door.js';
import { hostExecPath } from './branded-host.js';
import { isPidAlive } from '../canvas/pid.js';
import type { PiInvocation } from './launch.js';

/** View-side launch hints the broker host needs beyond the PiInvocation. The
 *  broker uses `cwd` + `resuming`; `name` is carried for the node's display. */
export interface LaunchPlacement {
  cwd: string;
  name: string;
  resuming: boolean;
}

/** A handle to a node's running engine container. The broker host supervises via
 *  the broker pid recorded as pi_pid; no tmux placement coords exist (the engine
 *  is never in a pane). */
export interface HostHandle {
  /** Supervised pid (signal-0 target). May be null right at launch before the
   *  detached child reports its pid; the broker re-records pi_pid during its
   *  extension bind, and reviveNode clearPid()s right after launch. */
  pid: number | null;
}

export interface Host {
  /** Bring a node's ENGINE into existence from its launch recipe; return a
   *  supervisable handle. */
  launch(nodeId: string, inv: PiInvocation, opts: LaunchPlacement): HostHandle;

  /** Is this node's engine alive? PURE / non-mutating. `string | NodeRow` so
   *  both call sites — the revive guard (passes the id) and the daemon (passes a
   *  row) — share one selector. For the broker this IS isPidAlive(pi_pid). */
  isAlive(node: string | NodeRow): boolean;

  /** Tear the engine down (close/cancel teardown). */
  teardown(nodeId: string): void;

  /** Deliver an OS signal to the engine container — present so the daemon never
   *  reaches around the abstraction. */
  signal(nodeId: string, sig: NodeJS.Signals): void;
}

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

/** How long teardown waits after sending the graceful `shutdown` frame before
 *  SIGTERMing a broker that connected but never exited (e.g. a hung dispose()). */
const BROKER_SHUTDOWN_GRACE_MS = 2_000;

export const headlessBrokerHost: Host = {
  launch(nodeId, inv, opts) {
    const dir = nodeDir(nodeId);
    mkdirSync(dir, { recursive: true });
    // The broker reads this recipe back via runBroker(nodeId) → broker-launch.json.
    writeFileSync(join(dir, 'broker-launch.json'), JSON.stringify(inv));
    // Redirect the detached broker's stdout+stderr to a per-node log under the
    // node's existing job/ dir (alongside log.jsonl / telemetry.json). Without
    // this (stdio:'ignore') EVERY broker diagnostic — the version-skew warning,
    // model-not-found, socket errors, first-prompt failure, and broker-cli's
    // fatal-crash stack — goes to /dev/null, which is exactly what makes a boot
    // failure invisible (review M-2). Append-mode so a crash-revive keeps history.
    const logDir = jobDir(nodeId);
    mkdirSync(logDir, { recursive: true });
    const logFd = openSync(join(logDir, 'broker.log'), 'a');
    // Launch from the crouter-branded host binary (a copy of node) so the
    // broker shows "crouter" in macOS Full Disk Access, not "node". On
    // non-darwin / dev / tests this is just process.execPath (see branded-host).
    const child = spawn(hostExecPath(), [resolveBrokerEntry(), nodeId], {
      cwd: opts.cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env, ...inv.env, [FRONT_DOOR_ENV]: '1' },
    });
    // The child holds its own dup of the fd; release the parent's copy so the
    // launching process (CLI or daemon) never leaks it.
    closeSync(logFd);
    child.unref();
    return { pid: child.pid ?? null };
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
      // Bounded exit confirmation (review Mn-3): a broker that connects fine but
      // then HANGS inside session.dispose() (disposeAndExit catches a throw, not
      // a hang) would leak the process holding the sole .jsonl writer. Arm a
      // short UNREF'd timer; if the captured pid is still alive when it fires,
      // SIGTERM it. unref'd so the happy path adds NO latency — a short-lived CLI
      // caller's loop is kept alive only by the still-open socket, i.e. precisely
      // the hung case where the fallback must run.
      const pid = getNode(nodeId)?.pi_pid;
      if (pid != null) {
        setTimeout(() => {
          if (isPidAlive(pid)) {
            try {
              process.kill(pid, 'SIGTERM');
            } catch {
              /* already gone */
            }
          }
        }, BROKER_SHUTDOWN_GRACE_MS).unref();
      }
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
