// The agent-facing I/O contract. One JSON object on stdin; one JSON object on
// stdout (JSONL for streams); structured errors; stderr is diagnostics only and
// never carries the result. No flags, no envelope, no decoration — the stdout
// value is the next caller's stdin. See cli-design SKILL.md / reference.md.

import { CrtrError } from './errors.js';
import { ExitCode, type ExitCodeValue } from '../types.js';

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

async function readStdinRaw(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Parse the single JSON object on stdin. Empty stdin → `{}` (a leaf decides
 *  whether the empty call is meaningful, e.g. `plan new` returns the guide). */
export async function readInput(): Promise<Record<string, unknown>> {
  const raw = (await readStdinRaw()).trim();
  if (raw === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new InputError({
      error: 'invalid_json',
      message: 'stdin is not valid JSON.',
      received: raw.length > 200 ? raw.slice(0, 200) + '…' : raw,
      next: 'Send a single JSON object on stdin. See this leaf -h for the schema.',
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new InputError({
      error: 'invalid_input',
      message: 'stdin must be a single JSON object.',
      received: parsed,
      next: 'Wrap parameters in one object, e.g. {"name":"…"}. See -h.',
    });
  }
  return parsed as Record<string, unknown>;
}

export function isEmpty(input: Record<string, unknown>): boolean {
  return Object.keys(input).length === 0;
}

// ---------------------------------------------------------------------------
// typed field accessors — terse leaves, uniform errors
// ---------------------------------------------------------------------------

interface StrOpts {
  required?: boolean;
  default?: string;
  enum?: readonly string[];
  next?: string;
}

export function str(
  o: Record<string, unknown>,
  field: string,
  opts: StrOpts = {},
): string | undefined {
  const v = o[field];
  if (v === undefined || v === null) {
    if (opts.required) {
      const next =
        opts.next !== undefined
          ? opts.next
          : `Add "${field}" to the stdin object. See -h for its schema.`;
      throw new InputError({
        error: 'missing_field',
        message: `required field "${field}" is missing.`,
        field,
        next,
      });
    }
    return opts.default;
  }
  if (typeof v !== 'string') {
    const next = opts.next !== undefined ? opts.next : `Set "${field}" to a string.`;
    throw new InputError({
      error: 'invalid_field',
      message: `field "${field}" must be a string.`,
      received: v,
      field,
      next,
    });
  }
  if (opts.enum && !opts.enum.includes(v)) {
    throw new InputError({
      error: 'invalid_field',
      message: `field "${field}" must be one of: ${opts.enum.join(', ')}.`,
      received: v,
      field,
      next: `Retry with one of: ${opts.enum.join(', ')}.`,
    });
  }
  return v;
}

export function reqStr(
  o: Record<string, unknown>,
  field: string,
  opts: Omit<StrOpts, 'required'> = {},
): string {
  return str(o, field, { ...opts, required: true }) as string;
}

export function bool(
  o: Record<string, unknown>,
  field: string,
  dflt: boolean,
): boolean {
  const v = o[field];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== 'boolean') {
    throw new InputError({
      error: 'invalid_field',
      message: `field "${field}" must be a boolean.`,
      received: v,
      field,
      next: `Set "${field}" to true or false, or omit it (default ${dflt}).`,
    });
  }
  return v;
}

export function int(
  o: Record<string, unknown>,
  field: string,
  opts: { default: number; min?: number; max?: number },
): number {
  const v = o[field];
  if (v === undefined || v === null) return opts.default;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new InputError({
      error: 'invalid_field',
      message: `field "${field}" must be an integer.`,
      received: v,
      field,
      next: `Set "${field}" to an integer, or omit it (default ${opts.default}).`,
    });
  }
  if (opts.min !== undefined && v < opts.min) {
    throw new InputError({
      error: 'invalid_field',
      message: `field "${field}" must be >= ${opts.min}.`,
      received: v,
      field,
      next: `Raise "${field}" to at least ${opts.min}.`,
    });
  }
  if (opts.max !== undefined && v > opts.max) {
    throw new InputError({
      error: 'invalid_field',
      message: `field "${field}" must be <= ${opts.max}.`,
      received: v,
      field,
      next: `Lower "${field}" to at most ${opts.max}.`,
    });
  }
  return v;
}

// ---------------------------------------------------------------------------
// stdout — the result, nothing else
// ---------------------------------------------------------------------------

/** Single-shot response: one JSON object. The whole response is one value. */
export function emit(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

/** One JSONL record. Call per event in a stream; partial reads stay parseable. */
export function emitLine(obj: Record<string, unknown>): void {
  process.stdout.write(JSON.stringify(obj) + '\n');
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
    process.stdout.write(JSON.stringify(payloadOf(e), null, 2) + '\n');
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
