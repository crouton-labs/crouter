// transport-http.ts — the browser-side Transport. Posts a view's declarative
// SourceRequest to the local bridge server (`crtr view serve`'s /__crtr/source)
// and returns the RawResponse the bridge ran on its behalf. This is the ONE
// seam a cloud deploy swaps: point the endpoint at a real backend and the same
// browser bundle resolves sources against it, no core change.

import type { Transport } from '../core/view/transport.js';
import type { SourceRequest, RawResponse } from '../core/view/contract.js';

/** Browser Transport → POST <endpoint> {SourceRequest} → RawResponse. Never
 *  throws: a network/bridge failure becomes a transport-level RawResponse
 *  (ok:false + stderr), exactly like the local transport's spawn failures. */
export function createHttpTransport(endpoint = '/__crtr/source'): Transport {
  return {
    async send(req: SourceRequest): Promise<RawResponse> {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
        });
        if (!res.ok) {
          return { ok: false, stdout: '', stderr: `bridge ${res.status} ${res.statusText}` };
        }
        return (await res.json()) as RawResponse;
      } catch (e) {
        return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
