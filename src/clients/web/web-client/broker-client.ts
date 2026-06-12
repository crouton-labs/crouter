// broker-client.ts — the browser half of the broker protocol, over the `crtr web`
// WS relay. This is the WebSocket parallel of `src/clients/attach/view-socket.ts`
// (the terminal client's socket layer) — the relay forwards frames VERBATIM, so
// the browser is the SAME protocol peer as `crtr attach`.
//
// The relay (`src/clients/web/server.ts`) sends ONE complete frame per WS text
// message (`ws.send(JSON.stringify(frame))`) and re-frames each browser message
// as one newline-terminated JSON line into the broker socket. So the browser
// needs NO FrameDecoder — WebSocket preserves message boundaries; we `JSON.parse`
// each message and `JSON.stringify` each send.
//
// §0 ONE-WRITER INVARIANT holds transitively: this client only opens a WS to the
// relay, which only relays to an ALREADY-running broker. It never spawns pi,
// never opens a session. A node with no running broker → the relay closes the WS
// with code 1011 + reason "no running broker for <id>"; we surface that as
// `unavailable` so the UI can offer a [Wake] (which goes through the bridge
// command path, NOT this socket — design §6).

import type { BrokerToClient, ClientToBroker } from './protocol.js';

/** Why a connection ended, derived from the relay's WS close code + reason. The
 *  relay closes 1011 with "no running broker for <id>" when the broker socket
 *  refuses/ENOENTs (the true-liveness signal, design §8) and "no node <id>" when
 *  the id is unknown; 1008 for an invalid id. Everything else is a transient
 *  drop we can re-dial. */
export type CloseKind = 'no-broker' | 'no-node' | 'invalid' | 'transient';

export interface BrokerClientHandlers {
  /** WS open — the socket is up; the broker's `welcome` frame follows. */
  onOpen?: () => void;
  /** One decoded broker→client frame (welcome / control / data / display /
   *  a raw pi AgentSessionEvent). */
  onFrame?: (frame: BrokerToClient) => void;
  /** The socket closed. `kind` classifies WHY so the UI can decide between a
   *  [Wake] button (no-broker), a "gone" state (no-node), or a reconnect. */
  onClose?: (kind: CloseKind, reason: string) => void;
}

/** Classify a WS close (code + reason) into a {@link CloseKind}. Mirrors the
 *  relay's `bridgeConnection` close paths in server.ts. */
export function classifyClose(code: number, reason: string): CloseKind {
  if (code === 1008) return 'invalid';
  if (code === 1011 && /^no node /.test(reason)) return 'no-node';
  if (code === 1011 && /^no running broker/.test(reason)) return 'no-broker';
  return 'transient';
}

/** A thin, framework-free WS client for one node's broker. Construct, `connect()`,
 *  receive frames via handlers, `send()` client frames, `close()` to detach. Not
 *  an EventEmitter (browser) — handlers are passed in. Single-use per connect;
 *  the React layer (useBroker) owns reconnect policy. */
export class BrokerClient {
  private ws: WebSocket | undefined;
  private closedReported = false;

  constructor(
    private readonly nodeId: string,
    private readonly handlers: BrokerClientHandlers,
  ) {}

  /** Same-origin WS URL for this node — `ws(s)://<host>/node/<id>`. In the
   *  shipped shell the page is served by `crtr web serve`, so same-origin IS the
   *  relay; in dev the Vite server proxies `/node/*` to the relay. */
  get url(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/node/${encodeURIComponent(this.nodeId)}`;
  }

  connect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      // A malformed URL is the only synchronous throw; treat as a transient
      // close so the caller's policy decides.
      this.reportClose('transient', `failed to open ws: ${String(err)}`);
      return;
    }
    this.ws = ws;
    ws.onopen = () => this.handlers.onOpen?.();
    ws.onmessage = (ev: MessageEvent) => this.onMessage(ev);
    ws.onclose = (ev: CloseEvent) =>
      this.reportClose(classifyClose(ev.code, ev.reason), ev.reason || `closed (${ev.code})`);
    // An error is always followed by a close — let the close path report; the
    // handler just prevents an unhandled error.
    ws.onerror = () => {};
  }

  private onMessage(ev: MessageEvent): void {
    // The relay sends text frames (JSON.stringify). Guard against a Blob (older
    // browsers) by ignoring non-string — the relay never sends binary.
    if (typeof ev.data !== 'string') return;
    let frame: BrokerToClient;
    try {
      frame = JSON.parse(ev.data) as BrokerToClient;
    } catch {
      // A malformed frame must never crash the client — drop it (parity with the
      // broker's own bad-JSON drop).
      return;
    }
    this.handlers.onFrame?.(frame);
  }

  /** Encode + send one client→broker frame. No-op if the socket isn't open. */
  send(frame: ClientToBroker): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      /* dead socket — onclose will drive teardown */
    }
  }

  /** Detach: close the socket. `onClose` fires once via the close path. */
  close(): void {
    const ws = this.ws;
    if (ws !== undefined && ws.readyState <= WebSocket.OPEN) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }

  private reportClose(kind: CloseKind, reason: string): void {
    if (this.closedReported) return;
    this.closedReported = true;
    this.ws = undefined;
    this.handlers.onClose?.(kind, reason);
  }
}
