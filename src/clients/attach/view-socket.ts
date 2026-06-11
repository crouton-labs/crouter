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
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { nodeDir } from '../../core/canvas/paths.js';
import type { NodeRow } from '../../core/canvas/types.js';
import {
  CLIENT_READ_CAPS,
  encodeFrame,
  FrameDecoder,
  FrameOverflowError,
  type BrokerDataFrame,
  type BrokerToClient,
  type ClientToBroker,
  type DequeueFrame,
  type GetSettingsFrame,
  type GetTreeFrame,
  type ListModelsFrame,
  type ListScopedModelsFrame,
  type ListSessionsFrame,
} from '../../core/runtime/broker-protocol.js';

/** A correlated read-op (or `dequeue`) request MINUS the client-chosen `id` —
 *  {@link ViewSocketClient.request} mints the `id`, sends the frame, and resolves
 *  with the matching `data` reply. The picker/operator code builds these; the
 *  socket owns the correlation token so callers never hand-roll one. */
export type ReadOpRequest =
  | Omit<ListModelsFrame, 'id'>
  | Omit<ListSessionsFrame, 'id'>
  | Omit<GetTreeFrame, 'id'>
  | Omit<GetSettingsFrame, 'id'>
  | Omit<ListScopedModelsFrame, 'id'>
  | Omit<DequeueFrame, 'id'>;

/** How long {@link ViewSocketClient.request} waits for the correlated reply before
 *  rejecting — bounds a pending picker fetch if the broker drops the request
 *  (it should always reply with `data` or a correlated `error`). */
const REQUEST_TIMEOUT_MS = 10_000;

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
  /** In-flight correlated read-ops, keyed by the `id` minted in {@link request}.
   *  Resolved by the matching `data` frame / rejected by the matching `error`
   *  frame in {@link onData}, the request's timeout, or socket teardown. */
  private pending = new Map<
    string,
    { resolve: (frame: BrokerDataFrame) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly nodeId: string) {
    super();
  }

  /** Issue a correlated read-op and resolve with the broker's `data` reply (or
   *  reject on the correlated `error`, a timeout, or socket teardown). Mints the
   *  `id`, sends `{...frame, id}`, and parks a resolver consumed by {@link onData}.
   *  The reply is narrowed by the caller on its `kind`. */
  request(frame: ReadOpRequest): Promise<BrokerDataFrame> {
    const id = randomUUID();
    return new Promise<BrokerDataFrame>((resolve, reject) => {
      // Fail fast on a dead/absent socket rather than parking a promise that the
      // reply will never reach (it would otherwise hang the full timeout). A
      // post-`close` request lands here too — `rejectAllPending` already ran.
      const sock = this.socket;
      if (sock === undefined || sock.destroyed) {
        reject(new Error(`cannot issue '${frame.type}': no live broker connection`));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`request '${frame.type}' timed out after ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ ...frame, id } as ClientToBroker);
    });
  }

  /** Reject + clear every in-flight request (socket gone / decode error) so a
   *  picker fetch never hangs past the connection it rode on. */
  private rejectAllPending(reason: string): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();
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
      this.rejectAllPending(msg);
      this.emitError(new Error(msg));
      this.destroy();
      return;
    }
    for (const raw of frames) {
      const frame = raw as BrokerToClient;
      // Correlated replies (read-ops + dequeue) are consumed by the pending-by-id
      // resolver, NOT re-emitted as a generic 'frame' (the attach frame router
      // would otherwise treat a `data` frame as an AgentSessionEvent). A `data`
      // frame is ALWAYS a reply, so it is swallowed unconditionally — even a late
      // post-timeout one (no pending entry) is dropped, never leaked to the
      // router. An `error` is correlated only when its `id` matches an in-flight
      // request; an uncorrelated error still flows through.
      if (frame.type === 'data') {
        const entry = typeof frame.id === 'string' ? this.pending.get(frame.id) : undefined;
        if (entry) {
          this.pending.delete(frame.id);
          clearTimeout(entry.timer);
          entry.resolve(frame);
        }
        continue;
      }
      if (frame.type === 'error' && typeof frame.id === 'string' && this.pending.has(frame.id)) {
        const entry = this.pending.get(frame.id)!;
        this.pending.delete(frame.id);
        clearTimeout(entry.timer);
        entry.reject(new Error(frame.message || `request failed: ${frame.code}`));
        continue;
      }
      this.emit('frame', frame);
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
    this.rejectAllPending('broker connection closed');
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
