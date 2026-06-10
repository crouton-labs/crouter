// helpers/broker-clients.ts — the shared attach-client kit for the broker
// lifecycle/attach-gate suite (plan T8/T11). Extracted VERBATIM from the original
// single-file broker-lifecycle.test.ts when it was split into per-area files so
// node:test's file-level parallelism applies (each file holds its own isolated
// harness); the helpers are unchanged in behavior.
//
// The kit wraps the PRODUCTION attach client (pure node:net + the broker codec,
// no TUI) as the in-test controller/observer so the G1–G9 gate exercises the REAL
// client too (§0 one-writer: a viewer holds ONLY a socket), plus a raw node:net
// peer for the cases where the client lifecycle is awkward (G7 oversized line,
// G8 stalled viewer).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { spawnSync } from 'node:child_process';

import type { Harness } from './harness.js';
import { ViewSocketClient } from '../../../clients/attach/view-socket.js';
import {
  CLIENT_READ_CAPS,
  FrameDecoder,
  encodeFrame,
  type BrokerToClient,
  type ClientToBroker,
  type ClientRole,
  type WelcomeFrame,
} from '../../runtime/broker-protocol.js';

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
export const tok = (s: string): string => `${s}-${Math.random().toString(36).slice(2, 8)}`;
export const frameHas = (f: BrokerToClient, token: string): boolean =>
  JSON.stringify(f).includes(token);

export function brokerLogText(h: Harness, id: string): string {
  try {
    return readFileSync(join(h.home, 'nodes', id, 'job', 'broker.log'), 'utf8');
  } catch {
    return '';
  }
}

/** lsof the holders of `path`, or null when lsof is unavailable (skip the fd
 *  check). Exit-non-zero with empty stdout means "no holders". */
export function lsofHolders(path: string): number[] | null {
  if (spawnSync('which', ['lsof'], { stdio: 'ignore' }).status !== 0) return null;
  const out = (spawnSync('lsof', ['-t', '--', path], { encoding: 'utf8' }).stdout ?? '').trim();
  if (out === '') return [];
  return out
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n));
}

export interface Attached {
  client: ViewSocketClient;
  frames: BrokerToClient[];
  welcome: WelcomeFrame;
  send(frame: ClientToBroker): void;
  waitFrame(
    pred: (f: BrokerToClient) => boolean,
    label: string,
    timeoutMs?: number,
  ): Promise<BrokerToClient>;
  close(): void;
}

export interface RawClient {
  socket: Socket;
  frames: BrokerToClient[];
  closed: () => boolean;
  send(frame: ClientToBroker): void;
  writeRaw(data: Buffer | string): void;
  waitClosed(label: string, timeoutMs?: number): Promise<void>;
  close(): void;
}

export interface AttachKit {
  /** Connect a ViewSocketClient to a node's running broker, hello, await welcome. */
  attach(id: string, role: ClientRole, clientId: string): Promise<Attached>;
  /** Attach (as `role`) and retry until the welcome satisfies `pred`. */
  attachUntil(
    id: string,
    role: ClientRole,
    clientId: string,
    pred: (a: Attached) => boolean,
    label: string,
  ): Promise<Attached>;
  /** A raw node:net peer. read:false leaves the socket PAUSED (G8 stalled viewer). */
  connectRaw(id: string, opts: { read: boolean }): Promise<RawClient>;
  /** Close every client opened since the last closeAll — wire into afterEach. */
  closeAll(): void;
}

/** Build the attach kit against a lazily-resolved harness (the harness is
 *  created in the file's before() hook, after the kit is constructed). */
export function createAttachKit(getH: () => Harness): AttachKit {
  const liveClients: Array<{ close: () => void }> = [];

  // Connect a ViewSocketClient to a node's running broker, hello, await welcome.
  // awaitBoot returns once the boot proof is written — which is BEFORE the broker's
  // server.listen() binds view.sock — so a fresh attach can momentarily race the
  // bind; retry the connect on BrokerUnavailable until it is listening.
  async function attach(id: string, role: ClientRole, clientId: string): Promise<Attached> {
    const h = getH();
    await h.waitFor(() => existsSync(h.brokerSock(id)), { label: `view.sock for ${id}`, timeoutMs: 20_000 });
    const frames: BrokerToClient[] = [];
    let client!: ViewSocketClient;
    for (let attempt = 0; ; attempt++) {
      client = new ViewSocketClient(id);
      client.on('frame', (f) => frames.push(f));
      try {
        await new Promise<void>((resolve, reject) => {
          client.once('connect', resolve);
          client.once('error', reject);
          client.connect();
        });
        break;
      } catch (err) {
        client.close();
        if (attempt >= 30) throw err;
        await delay(100);
      }
    }
    client.on('error', () => {}); // post-connect error sink (never throw uncaught)
    // Register cleanup the instant the socket is connected — BEFORE the hello/welcome
    // round-trip — so a welcome timeout cannot leak a connected socket past the test.
    liveClients.push({ close: () => client.close() });
    const waitFrame = (
      pred: (f: BrokerToClient) => boolean,
      label: string,
      timeoutMs = 15_000,
    ): Promise<BrokerToClient> => h.waitFor(() => frames.find(pred) ?? null, { label, timeoutMs });
    client.send({ type: 'hello', role, client_id: clientId });
    let welcome: WelcomeFrame;
    try {
      welcome = (await waitFrame((f) => f.type === 'welcome', `welcome for ${clientId}`)) as WelcomeFrame;
    } catch (err) {
      client.close();
      throw err;
    }
    return { client, frames, welcome, send: (f) => client.send(f), waitFrame, close: () => client.close() };
  }

  // Attach (as `role`) and retry until the welcome satisfies `pred` — used where the
  // observable lands a beat after a prior action (G3 snapshot accrual, G5b control
  // handoff after a controller detaches). Deterministic: it polls an observable.
  async function attachUntil(
    id: string,
    role: ClientRole,
    clientId: string,
    pred: (a: Attached) => boolean,
    label: string,
  ): Promise<Attached> {
    for (let attempt = 0; ; attempt++) {
      const a = await attach(id, role, `${clientId}-${attempt}`);
      if (pred(a)) return a;
      a.close();
      if (attempt >= 40) throw new Error(`attachUntil timed out: ${label}`);
      await delay(150);
    }
  }

  // A raw node:net peer. read:true decodes incoming frames; read:false leaves the
  // socket PAUSED (no 'data' listener, never resumed) so it never drains — the
  // stalled viewer (G8) whose backlog the broker must shed at the HWM.
  async function connectRaw(id: string, opts: { read: boolean }): Promise<RawClient> {
    const h = getH();
    await h.waitFor(() => existsSync(h.brokerSock(id)), { label: `view.sock for ${id}`, timeoutMs: 20_000 });
    const frames: BrokerToClient[] = [];
    const decoder = new FrameDecoder(CLIENT_READ_CAPS);
    let isClosed = false;
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = createConnection(h.brokerSock(id));
      s.once('connect', () => resolve(s));
      s.once('error', reject);
    });
    socket.on('close', () => {
      isClosed = true;
    });
    socket.on('error', () => {
      /* close follows */
    });
    if (opts.read) {
      socket.on('data', (chunk: Buffer) => {
        try {
          for (const f of decoder.push(chunk)) frames.push(f as BrokerToClient);
        } catch {
          /* a client-side overflow is irrelevant here */
        }
      });
    }
    const rc: RawClient = {
      socket,
      frames,
      closed: () => isClosed,
      send: (f) => {
        try {
          socket.write(encodeFrame(f));
        } catch {
          /* dead */
        }
      },
      writeRaw: (d) => {
        try {
          socket.write(d);
        } catch {
          /* dead */
        }
      },
      waitClosed: (label, timeoutMs = 15_000) =>
        h.waitFor(() => (isClosed ? true : null), { label, timeoutMs }).then(() => undefined),
      close: () => {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      },
    };
    liveClients.push(rc);
    return rc;
  }

  function closeAll(): void {
    for (const c of liveClients.splice(0)) {
      try {
        c.close();
      } catch {
        /* already gone */
      }
    }
  }

  return { attach, attachUntil, connectRaw, closeAll };
}
