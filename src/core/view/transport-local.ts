// transport-local.ts — the BUILT local transport: fulfills SourceRequests on
// this machine. exec→execFile (cwd = the view's cwd unless the request says
// otherwise), file→readFile, http→fetch.
//
// Never throws. Transport-level failure (binary missing, file unreadable,
// network down) ⇒ { ok:false, stderr }. A spawned process exiting non-zero is
// transport-level SUCCESS (ok:true + exitCode) — classifying that is the
// source's parse() job.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import type { SourceRequest, RawResponse } from './contract.js';
import type { Transport } from './transport.js';

const MAX_BUFFER = 10 * 1024 * 1024;

export interface LocalTransportOptions {
  /** Working directory for `exec` requests that don't carry their own cwd.
   *  Defaults to process.cwd(). */
  cwd?: string;
}

export function createLocalTransport(opts: LocalTransportOptions = {}): Transport {
  const baseCwd = opts.cwd ?? process.cwd();
  return {
    async send(req: SourceRequest): Promise<RawResponse> {
      switch (req.kind) {
        case 'exec': return sendExec(req, baseCwd);
        case 'file': return sendFile(req);
        case 'http': return sendHttp(req);
      }
    },
  };
}

function sendExec(req: Extract<SourceRequest, { kind: 'exec' }>, baseCwd: string): Promise<RawResponse> {
  return new Promise((resolve) => {
    const child = execFile(
      req.bin,
      req.args,
      { cwd: req.cwd ?? baseCwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (!err) { resolve({ ok: true, exitCode: 0, stdout, stderr }); return; }
        const code = (err as NodeJS.ErrnoException).code;
        if (typeof code === 'number') {
          // Ran but exited non-zero: transport-level success; parse() classifies.
          resolve({ ok: true, exitCode: code, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        if ((err as { signal?: string }).signal) {
          // Killed by signal: it ran; surface as a non-zero exit.
          resolve({ ok: true, exitCode: 1, stdout: stdout ?? '', stderr: stderr ?? '' });
          return;
        }
        // Spawn-level failure (ENOENT/EACCES/maxBuffer): transport failure.
        const msg = code === 'ENOENT' ? `${req.bin}: command not found` : err.message;
        resolve({ ok: false, stdout: stdout ?? '', stderr: msg });
      },
    );
    if (req.stdin != null && child.stdin) {
      child.stdin.write(req.stdin);
      child.stdin.end();
    }
  });
}

async function sendFile(req: Extract<SourceRequest, { kind: 'file' }>): Promise<RawResponse> {
  try {
    const text = await readFile(req.path, 'utf8');
    return { ok: true, stdout: text, stderr: '' };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

async function sendHttp(req: Extract<SourceRequest, { kind: 'http' }>): Promise<RawResponse> {
  try {
    const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
    const body = await res.text();
    return { ok: true, status: res.status, stdout: body, stderr: res.ok ? '' : res.statusText };
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}
