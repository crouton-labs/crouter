// The agent-facing I/O contract. Flags and positional args on input; stdout is
// agent-ready markdown/XML the caller acts on directly (the result rendered FOR
// the model, not data it parses); structured errors; stderr is diagnostics only
// and never carries the result. The raw JSON object is available behind the
// `--json` global for tooling. See the cli-design reference.

import { CrtrError } from './errors.js';
import { ExitCode, type ExitCodeValue } from '../types.js';
import { renderError } from './render.js';

// ---------------------------------------------------------------------------
// output mode — prose (default) vs raw JSON (--json global, for tooling)
// ---------------------------------------------------------------------------

let jsonOutput = false;
/** Set by the dispatcher when `--json` is present anywhere in argv. */
export function setJsonOutput(v: boolean): void {
  jsonOutput = v;
}
/** True when the caller asked for raw JSON instead of rendered prose. */
export function isJsonOutput(): boolean {
  return jsonOutput;
}

/** Structured error payload. `error` is a stable code the agent branches on;
 *  `next` is the recovery road sign. */
export interface ErrorPayload {
  error: string;
  message: string;
  received?: unknown;
  field?: string;
  next: string;
}

/** A command-level failure: surfaces as the JSON response on stdout. */
export class InputError extends CrtrError {
  payload: ErrorPayload;
  constructor(payload: ErrorPayload, exitCode: ExitCodeValue = ExitCode.USAGE) {
    super(payload.error, payload.message, exitCode, { ...payload });
    this.name = 'InputError';
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

/** Read raw stdin to EOF. Returns empty string when stdin is a TTY (no pipe).
 *  Called by the argv parser for leaves declaring a `stdin` parameter. */
export async function readStdinRaw(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// stdout — the result, nothing else
// ---------------------------------------------------------------------------

/** Raw-JSON mirror of a single-shot response (the `--json` escape hatch). The
 *  default path renders the result as prose instead — see render.ts. */
export function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** One JSONL record. Call per event in a stream; partial reads stay parseable. */
export function emitLine(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Write to stdout and resolve true ONLY once the bytes are confirmed flushed to
 * a connected reader. Resolves false if the consumer is gone (EPIPE) or the
 * write fails. This is the reliable "the caller actually received it" signal:
 * use it to gate side effects that must only happen on genuine delivery (e.g.
 * acking a collected result). A killed process never resolves at all — also
 * safe, since the gated side effect then never runs.
 */
export function writeStdout(s: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const onErr = (e: NodeJS.ErrnoException): void => {
      if (e.code === 'EPIPE') finish(false);
    };
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      process.stdout.off('error', onErr);
      resolve(ok);
    };
    process.stdout.on('error', onErr);
    try {
      process.stdout.write(s, (err) => finish(err === null || err === undefined));
    } catch {
      finish(false);
    }
  });
}

// ---------------------------------------------------------------------------
// stderr — diagnostics the agent MAY capture, never the result
// ---------------------------------------------------------------------------

export function diag(message: string): void {
  process.stderr.write(message + '\n');
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

function payloadOf(e: CrtrError): ErrorPayload {
  if (e instanceof InputError) return e.payload;
  const d = (e.details !== undefined ? e.details : {}) as Partial<ErrorPayload>;
  const next =
    d.next !== undefined
      ? d.next
      : 'Inspect the error and adjust the call. See -h for the schema.';
  return {
    error: e.code,
    message: e.message,
    received: d.received,
    field: d.field,
    next,
  };
}

/** Terminal error handler. Command-level failures (bad input, not-found,
 *  ambiguous) surface as the JSON response on stdout so the caller parses one
 *  contract. Runtime/internal failures go to stderr as `{error:"internal"}` —
 *  raw traces never reach the agent. Exits non-zero either way. */
export function handle(e: unknown): never {
  if (e instanceof CrtrError) {
    const payload = payloadOf(e);
    const out = jsonOutput
      ? JSON.stringify(payload, null, 2)
      : renderError(payload);
    process.stdout.write(out + '\n');
    process.exit(e.exitCode);
  }
  const err = e as Error;
  const message =
    err !== null && err !== undefined && typeof err.message === 'string'
      ? err.message
      : String(e);
  process.stderr.write(
    JSON.stringify(
      {
        error: 'internal',
        message,
        next: 'This is a crtr bug, not a bad call. Retry; if it persists, report it.',
      },
      null,
      2,
    ) + '\n',
  );
  process.exit(ExitCode.GENERAL);
}
