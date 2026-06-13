// model-swap.ts — the engine behind `crtr node model`: swap a node's model
// (and thus its provider) WITHOUT attaching a viewer, persisting the choice so
// it survives revives. Two paths, chosen on broker liveness:
//
//   LIVE   — the node's broker is up (recorded pi_pid alive AND view.sock
//            present): connect to view.sock, claim controller, send `set_model`,
//            await the ack. The broker's broadcastModelChanged already persists
//            the choice via persistModelChoice (model_override + launch.model), so
//            this path NEVER writes the recipe itself — it reads back the resolved
//            provider/id from the freshly-updated row.
//   DORMANT — no live broker: write the durable recipe directly (mirroring exactly
//            what persistModelChoice writes) so the next revive picks it up.
//
// This complements the in-viewer `/model` slash command for the headless case.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { getNode, updateNode, type NodeMeta } from '../canvas/index.js';
import { nodeDir } from '../canvas/paths.js';
import { isPidAlive } from '../canvas/pid.js';
import { ViewSocketClient } from '../../clients/attach/view-socket.js';
import type { BrokerToClient } from './broker-protocol.js';

/** How long to wait for the broker's `set_model` ack before giving up. The
 *  switch is local (engine method + a DB write), so this is generous slack. */
const ACK_TIMEOUT_MS = 15_000;

/** True when the node's broker engine is reachable: its recorded pid is alive
 *  AND its view.sock exists. Both are required — a dead pid with a stale socket,
 *  or a live pid mid-boot before it binds the socket, is NOT a live broker. */
export function isBrokerLive(meta: NodeMeta): boolean {
  return isPidAlive(meta.pi_pid) && existsSync(join(nodeDir(meta.node_id), 'view.sock'));
}

/** Swap a LIVE node's model over its view.sock. Connects, claims controller
 *  (hello + request_control, so an attached viewer never blocks the swap), sends
 *  `set_model`, and resolves with the broker-resolved `provider/id` on its ack —
 *  read back from the row the broker just persisted (model_changed.model carries
 *  only the bare id). Rejects with the broker's message on an `error` frame (e.g.
 *  `no model matching '<spec>' in the registry`), on connect failure, or timeout. */
export function setModelLive(nodeId: string, spec: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = new ViewSocketClient(nodeId);
    const clientId = randomUUID();
    let settled = false;
    let resolvedId: string | undefined;
    const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${ACK_TIMEOUT_MS}ms waiting for the broker to ack the model switch`))), ACK_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();

    function finish(act: () => void): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch { /* best-effort */ }
      act();
    }

    client.on('error', (err) => finish(() => reject(err)));
    client.on('close', () => finish(() => reject(new Error('broker connection closed before it acked the model switch'))));
    client.on('connect', () => {
      // Claim control unconditionally: hello admits us as controller only if none
      // is held; request_control preempts an attached viewer (idempotent when we
      // already hold it). The broker processes these in order before set_model.
      client.send({ type: 'hello', role: 'controller', client_id: clientId });
      client.send({ type: 'request_control' });
      client.send({ type: 'set_model', model: spec });
    });
    client.on('frame', (frame: BrokerToClient) => {
      if (frame.type === 'model_changed') {
        resolvedId = frame.model;
      } else if (frame.type === 'ack' && frame.for === 'set_model' && frame.ok) {
        // The broker persisted model_override (full provider/id) in
        // broadcastModelChanged BEFORE flushing these frames, so the row is
        // authoritative; fall back to the bare id, then the raw spec.
        const persisted = getNode(nodeId)?.model_override ?? undefined;
        finish(() => resolve(persisted ?? resolvedId ?? spec));
      } else if (frame.type === 'error') {
        finish(() => reject(new Error(frame.message)));
      }
    });
    client.connect();
  });
}

/** Persist a model choice into a DORMANT node's durable recipe — mirrors exactly
 *  what the broker's persistModelChoice writes on a live switch: `model_override`
 *  (so polymorphs preserve it via buildLaunchSpec) and `launch.model` (the recipe
 *  buildPiArgv replays on revive). `spec` must already be a concrete `provider/id`
 *  (normalizeModel maps tiers/aliases; a bare substring cannot resolve offline). */
export function persistDormantModel(nodeId: string, spec: string): void {
  const meta = getNode(nodeId);
  if (meta === null) return;
  const launch = meta.launch !== undefined ? { ...meta.launch, model: spec } : undefined;
  updateNode(nodeId, { model_override: spec, ...(launch !== undefined ? { launch } : {}) });
}
