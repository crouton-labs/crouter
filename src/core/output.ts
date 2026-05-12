import { CrtrError } from './errors.js';
import { ExitCode, SCHEMA_VERSION } from '../types.js';

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function shouldColor(stream: NodeJS.WriteStream): boolean {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream.isTTY);
}

function paint(stream: NodeJS.WriteStream, code: string, text: string): string {
  return shouldColor(stream) ? `${code}${text}${ANSI.reset}` : text;
}

export const stdoutColor = {
  dim: (s: string) => paint(process.stdout, ANSI.dim, s),
  bold: (s: string) => paint(process.stdout, ANSI.bold, s),
  red: (s: string) => paint(process.stdout, ANSI.red, s),
  green: (s: string) => paint(process.stdout, ANSI.green, s),
  yellow: (s: string) => paint(process.stdout, ANSI.yellow, s),
  blue: (s: string) => paint(process.stdout, ANSI.blue, s),
  cyan: (s: string) => paint(process.stdout, ANSI.cyan, s),
  gray: (s: string) => paint(process.stdout, ANSI.gray, s),
};

export const stderrColor = {
  dim: (s: string) => paint(process.stderr, ANSI.dim, s),
  bold: (s: string) => paint(process.stderr, ANSI.bold, s),
  red: (s: string) => paint(process.stderr, ANSI.red, s),
  green: (s: string) => paint(process.stderr, ANSI.green, s),
  yellow: (s: string) => paint(process.stderr, ANSI.yellow, s),
  blue: (s: string) => paint(process.stderr, ANSI.blue, s),
  cyan: (s: string) => paint(process.stderr, ANSI.cyan, s),
  gray: (s: string) => paint(process.stderr, ANSI.gray, s),
};

export function out(line: string): void {
  process.stdout.write(line.endsWith('\n') ? line : line + '\n');
}

export function err(line: string): void {
  process.stderr.write(line.endsWith('\n') ? line : line + '\n');
}

export function hint(line: string): void {
  err(stderrColor.dim(`# ${line}`));
}

export function warn(line: string): void {
  err(stderrColor.yellow(`crtr: ${line}`));
}

export function info(line: string): void {
  err(stderrColor.gray(`crtr: ${line}`));
}

export function jsonOut(obj: unknown): void {
  const enriched = typeof obj === 'object' && obj !== null && !Array.isArray(obj)
    ? { schema_version: SCHEMA_VERSION, ...(obj as Record<string, unknown>) }
    : { schema_version: SCHEMA_VERSION, data: obj };
  process.stdout.write(JSON.stringify(enriched, null, 2) + '\n');
}

export function jsonError(error: CrtrError | Error): void {
  const e = error instanceof CrtrError ? error : new CrtrError('error', error.message, ExitCode.GENERAL);
  process.stdout.write(
    JSON.stringify(
      {
        schema_version: SCHEMA_VERSION,
        error: true,
        code: e.code,
        message: e.message,
        ...(e.details ?? {}),
      },
      null,
      2
    ) + '\n'
  );
}

export function isTTY(): boolean {
  return Boolean(process.stdout.isTTY);
}

export function isJsonRequested(opts: { json?: boolean } | undefined): boolean {
  return Boolean(opts?.json);
}

export function handleError(error: unknown, opts: { json?: boolean } = {}): never {
  if (error instanceof CrtrError) {
    if (opts.json) {
      jsonError(error);
    } else {
      err(stderrColor.red(`crtr: ${error.message}`));
    }
    process.exit(error.exitCode);
  }
  const e = error as Error;
  if (opts.json) {
    jsonError(e);
  } else {
    err(stderrColor.red(`crtr: ${e.message ?? String(e)}`));
  }
  process.exit(ExitCode.GENERAL);
}
