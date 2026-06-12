// command-client.ts — the shell's write path (design §6). Buttons become
// sanctioned `crtr` subprocesses run by the bridge: the browser POSTs an `exec`
// SourceRequest to /__crtr/source; the bridge runs `crtr …` in the server's cwd;
// that subprocess is the sanctioned writer (reviveNode / spawn). The browser NEVER
// touches an engine. Graph mutations only (revive/spawn/msg/close) — in-conversation
// driving (prompt/steer/abort) rides broker frames over the WS relay, not this.

import type { RawResponse, SourceRequest } from '../../../core/view/contract.js';

/** Run `crtr <args>` through the bridge, optionally feeding `stdin`. Returns the
 *  RawResponse the bridge ran on our behalf (never throws — a transport failure
 *  comes back as ok:false). */
export async function crtrCommand(args: string[], stdin?: string): Promise<RawResponse> {
  const req: SourceRequest = { kind: 'exec', bin: 'crtr', args, ...(stdin !== undefined ? { stdin } : {}) };
  try {
    const res = await fetch('/__crtr/source', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) return { ok: false, stdout: '', stderr: `bridge ${res.status} ${res.statusText}` };
    return (await res.json()) as RawResponse;
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** Wake a dormant node: `crtr canvas revive <id>` → headless broker (design §6).
 *  Wired into ConversationPane's onWake seam. */
export function reviveNode(nodeId: string): Promise<RawResponse> {
  return crtrCommand(['canvas', 'revive', nodeId]);
}

/** Spawn a node: `crtr node new --kind K --name N`, prompt on stdin (design §6). */
export function spawnNode(opts: { kind: string; name?: string; prompt: string }): Promise<RawResponse> {
  const args = ['node', 'new', '--kind', opts.kind];
  if (opts.name && opts.name.trim() !== '') args.push('--name', opts.name.trim());
  return crtrCommand(args, opts.prompt);
}
