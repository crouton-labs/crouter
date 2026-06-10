// view-socket.ts — the socket client half of `crtr attach` (Phase 4, T7).
//
// The §0 ONE-WRITER INVARIANT lives in this directory: a viewer has ONLY a
// socket. ViewSocketClient connects to a node's ALREADY-running headless broker
// over its unix socket (`nodeDir(id)/view.sock`) and speaks the LOCAL
// broker-protocol codec (`node:net` + the bounded `FrameDecoder`). It NEVER
// spawns pi, NEVER opens the session `.jsonl`, NEVER constructs an engine — if
// the broker is not running, connect fails and `attach-cmd` exits (focus/T9 is
// what keeps a broker alive, not attach). It also never uses pi's `RpcClient`
// (which would spawn its own engine).
//
// Reconnect: a dropped broker emits `close`; the caller's reconnect supervisor
// decides whether to re-dial (a yield/revive keeps the SAME `view.sock` path —
// `redial()` re-establishes the socket on it) or give up ("broker gone"). On a
// connect-time ECONNREFUSED/ENOENT → a `BrokerUnavailableError` so the FIRST
// connect exits non-zero with a clear message; the same codes during a redial
// reject the redial promise as retryable. Decode is bounded by
// `CLIENT_READ_CAPS`; a broker that somehow sends an oversized frame surfaces as
// a clean error+exit, not a crash.

import { EventEmitter } from 'node:events';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { nodeDir } from '../../core/canvas/paths.js';
import type { NodeRow } from '../../core/canvas/types.js';
import {
  CLIENT_READ_CAPS,
  encodeFrame,
  FrameDecoder,
  FrameOverflowError,
  type BrokerToClient,
  type ClientToBroker,
} from '../../core/runtime/broker-protocol.js';

/** Surfaced when the node has no reachable broker at connect time (no socket
 *  file, or a stale socket with nothing listening). The command catches this to
 *  exit non-zero with a focus/revive hint. */
/** The reconnect supervisor's give-up predicate (extracted pure so it is
 *  testable without a socket or TUI). After a broker close the viewer KEEPS
 *  re-dialing the same `view.sock` while the node is still alive — a yield
 *  leaves `status='active'` (intent='refresh') and the daemon revives a fresh
 *  broker on the same path. It gives up only when the node is genuinely gone:
 *  a terminal status (done/dead/canceled) or a reaped row (null). `idle` is NOT
 *  terminal — an idle-release node revives on its next inbox wake, so keep
 *  trying (the supervisor's own ~30s bound caps an indefinite wait). */
export function reconnectShouldGiveUp(row: NodeRow | null): boolean {
  if (row === null) return true;
  return row.status === 'done' || row.status === 'dead' || row.status === 'canceled';
}

export class BrokerUnavailableError extends Error {
  constructor(readonly nodeId: string) {
    super(`node ${nodeId} has no running broker — focus or revive it first`);
    this.name = 'BrokerUnavailableError';
  }
}

/** The plan-fixed interface (Wave 3): `connect()`, `on('frame', …)`,
 *  `send(frame)`, `on('close', …)`, plus `connect`/`error` events. */
export interface ViewSocketClient {
  on(event: 'connect', listener: () => void): this;
  on(event: 'frame', listener: (frame: BrokerToClient) => void): this;
  on(event: 'close', listener: () => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  once(event: 'connect', listener: () => void): this;
  once(event: 'frame', listener: (frame: BrokerToClient) => void): this;
  once(event: 'close', listener: () => void): this;
  once(event: 'error', listener: (err: Error) => void): this;
  off(event: 'connect', listener: () => void): this;
  off(event: 'error', listener: (err: Error) => void): this;
}

export class ViewSocketClient extends EventEmitter {
  private socket: Socket | undefined;
  private decoder = new FrameDecoder(CLIENT_READ_CAPS);
  private closeEmitted = false;

  constructor(private readonly nodeId: string) {
    super();
  }

  /** The broker binds `join(nodeDir(id), 'view.sock')` — resolve it the same way. */
  get socketPath(): string {
    return join(nodeDir(this.nodeId), 'view.sock');
  }

  /** Open the connection. Wire up listeners; emits `connect` on success or
   *  `error` (a {@link BrokerUnavailableError} for ECONNREFUSED/ENOENT) on
   *  failure. Idempotent guard is the caller's job — call once. */
  connect(): void {
    const socket = createConnection(this.socketPath);
    this.socket = socket;
    socket.on('connect', () => this.emit('connect'));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => this.onError(err));
    socket.on('close', () => this.onClose());
  }

  /** Re-establish the socket after a broker exit (a yield→revive cycle), on the
   *  SAME stable `view.sock` path. Installs a FRESH FrameDecoder (a half-frame
   *  from the dead stream must not corrupt the new one) and resets the close
   *  guard, then re-dials. Resolves on `connect` (caller re-sends `hello`);
   *  rejects on the dial's `error` (ECONNREFUSED while the new broker is
   *  mid-boot, or ENOENT before it re-binds the socket) — both retryable. A
   *  post-connect error flows through the normal `onError`→`close` path. */
  redial(): Promise<void> {
    this.destroy();
    this.decoder = new FrameDecoder(CLIENT_READ_CAPS);
    this.closeEmitted = false;
    return new Promise<void>((resolve, reject) => {
      const socket = createConnection(this.socketPath);
      this.socket = socket;
      let settled = false;
      socket.on('connect', () => {
        if (settled) return;
        settled = true;
        this.emit('connect');
        resolve();
      });
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (err: NodeJS.ErrnoException) => {
        if (settled) {
          this.onError(err);
          return;
        }
        settled = true;
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
        reject(err);
      });
      socket.on('close', () => this.onClose());
    });
  }

  /** Encode + write one client→broker frame. No-op on a dead/absent socket
   *  (a `close` event drives teardown); never throws. */
  send(frame: ClientToBroker): void {
    const sock = this.socket;
    if (sock === undefined || sock.destroyed) return;
    try {
      sock.write(encodeFrame(frame));
    } catch {
      /* dead socket — 'close' will fire and drive teardown */
    }
  }

  /** Detach: destroy the socket. `close` fires → the caller tears down. */
  close(): void {
    this.destroy();
  }

  private onData(chunk: Buffer): void {
    let frames: unknown[];
    try {
      frames = this.decoder.push(chunk);
    } catch (err) {
      // A broker that somehow emits an oversized frame (or a corrupt stream):
      // clean error + drop, never a crash.
      const msg =
        err instanceof FrameOverflowError
          ? `broker sent an oversized frame (${err.message}) — disconnecting`
          : `failed to decode a broker frame: ${String(err)}`;
      this.emitError(new Error(msg));
      this.destroy();
      return;
    }
    for (const raw of frames) {
      this.emit('frame', raw as BrokerToClient);
    }
  }

  private onError(err: NodeJS.ErrnoException): void {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
      this.emitError(new BrokerUnavailableError(this.nodeId));
    } else {
      this.emitError(new Error(`view socket error: ${err.message}`));
    }
    // 'close' typically follows 'error'; teardown converges there.
  }

  private onClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    this.emit('close');
  }

  private destroy(): void {
    const sock = this.socket;
    if (sock !== undefined && !sock.destroyed) {
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
    }
  }

  /** Emit `error` only when a listener exists — a bare EventEmitter `error`
   *  with no listener throws, and this client must never throw uncaught. */
  private emitError(err: Error): void {
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }
}
