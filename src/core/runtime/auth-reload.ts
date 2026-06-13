// auth-reload.ts — fan a live credential reload to a node's broker over its
// view.sock, the headless sibling of the viewer's own `reload_auth` frame.
//
// Every broker reads the SAME shared `~/.pi/agent/auth.json`. When the user
// `/login`s (anywhere), the broker that performed it self-reloads — but every
// OTHER live broker keeps its stale in-memory credentials until told. The
// daemon watches auth.json's mtime and fans this RPC to each live broker so the
// whole canvas follows one account switch with no per-broker re-login.
//
// Mirrors setModelLive's connect→claim-controller→send→await-ack shape: the
// broker's `reload_auth` handler is controller-only (notController guard), so we
// must request_control first. request_control preempts an attached viewer and is
// idempotent when already held; the reload is an instant local op
// (authStorage.reload() + modelRegistry.refresh()), so a momentary controller
// blip on each broker is acceptable.

import { randomUUID } from 'node:crypto';

import { ViewSocketClient } from '../../clients/attach/view-socket.js';
import type { BrokerToClient } from './broker-protocol.js';

/** How long to wait for the broker's `reload_auth` ack before giving up. The
 *  reload is a local file read + registry refresh, so this is generous slack. */
const ACK_TIMEOUT_MS = 15_000;

/** Reload a LIVE node's credentials over its view.sock. Connects, claims
 *  controller (hello + request_control, so an attached viewer never blocks the
 *  reload), sends `reload_auth`, and resolves on its ack. Rejects on the broker's
 *  `error` frame, connect failure, a premature close, or timeout — the caller
 *  (the daemon fan) isolates each broker so one failure never aborts the rest. */
export function reloadAuthLive(nodeId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const client = new ViewSocketClient(nodeId);
    const clientId = randomUUID();
    let settled = false;
    const timer = setTimeout(
      () =>
        finish(() =>
          reject(new Error(`timed out after ${ACK_TIMEOUT_MS}ms waiting for the broker to ack the auth reload`)),
        ),
      ACK_TIMEOUT_MS,
    );
    if (typeof timer.unref === 'function') timer.unref();

    function finish(act: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        /* best-effort */
      }
      act();
    }

    client.on('error', (err) => finish(() => reject(err)));
    client.on('close', () =>
      finish(() => reject(new Error('broker connection closed before it acked the auth reload'))),
    );
    client.on('connect', () => {
      // Claim control unconditionally: hello admits us as controller only if none
      // is held; request_control preempts an attached viewer (idempotent when we
      // already hold it). The broker processes these in order before reload_auth.
      client.send({ type: 'hello', role: 'controller', client_id: clientId });
      client.send({ type: 'request_control' });
      client.send({ type: 'reload_auth' });
    });
    client.on('frame', (frame: BrokerToClient) => {
      if (frame.type === 'ack' && frame.for === 'reload_auth' && frame.ok) {
        finish(() => resolve());
      } else if (frame.type === 'error') {
        finish(() => reject(new Error(frame.message)));
      }
    });
    client.connect();
  });
}
