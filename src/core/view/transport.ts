// transport.ts — the transport seam between a view's declarative SourceRequests
// and whatever fulfills them.
//
// The core is transport-blind: it only ever calls ctx.resolve(source, args) /
// ctx.execute(command, args); the host threads Transport.send → source.parse.
// Implementations:
//   • transport-local.ts (BUILT) — Node-side: exec→execFile, file→readFile,
//     http→fetch. Used directly by the TUI host and by the `view serve` bridge
//     server on behalf of the browser bundle.
//   • src/web/transport-http.ts (BUILT) — browser-side: POSTs the SourceRequest
//     to the local bridge (`/__crtr/source`).
//   • cloud (SEAM ONLY, not built) — same interface; send() POSTs the request
//     to an endpoint that runs it server-side, or maps it to a real API call.
//     Wiring a different Transport is the entire cloud migration.

import type { SourceRequest, RawResponse } from './contract.js';

export interface Transport {
  send(req: SourceRequest): Promise<RawResponse>;
}
