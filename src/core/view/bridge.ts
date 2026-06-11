// bridge.ts — the server side of the local web transport (Node only).
//
// `crtr view serve` runs the portable core CLIENT-SIDE in the browser; its
// sources resolve over an HTTP Transport that POSTs each SourceRequest here.
// This helper decodes that POST body and runs it through any Transport (the
// local exec/file/http one today) — the single endpoint a cloud deploy
// replaces. Kept transport-agnostic + framework-free so it is trivially
// testable and tear-out-able.

import type { Transport } from './transport.js';
import type { SourceRequest, RawResponse } from './contract.js';

export interface BridgeResult {
  status: number;
  body: string; // JSON-encoded RawResponse
}

function bad(stderr: string): BridgeResult {
  const raw: RawResponse = { ok: false, stdout: '', stderr };
  return { status: 400, body: JSON.stringify(raw) };
}

/** Decode a POST body as a SourceRequest and run it through `transport`,
 *  returning the HTTP status + JSON-encoded RawResponse the bridge should send
 *  back. Never throws — a malformed body or a transport failure both come back
 *  as a RawResponse with ok:false. */
export async function runSourceRequest(transport: Transport, rawBody: string): Promise<BridgeResult> {
  let req: SourceRequest;
  try {
    req = JSON.parse(rawBody) as SourceRequest;
  } catch {
    return bad('bridge: request body is not valid JSON');
  }
  const kind = (req as { kind?: unknown }).kind;
  if (!req || typeof req !== 'object' || (kind !== 'exec' && kind !== 'file' && kind !== 'http')) {
    return bad(`bridge: request body is not a SourceRequest (kind must be exec|file|http, got ${JSON.stringify(kind)})`);
  }
  const raw = await transport.send(req);
  return { status: 200, body: JSON.stringify(raw) };
}
