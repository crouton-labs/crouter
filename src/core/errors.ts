import { ExitCode, type ExitCodeValue } from '../types.js';

export class CrtrError extends Error {
  code: string;
  exitCode: ExitCodeValue;
  details?: Record<string, unknown>;

  constructor(
    code: string,
    message: string,
    exitCode: ExitCodeValue = ExitCode.GENERAL,
    details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'CrtrError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function notFound(message: string, details?: Record<string, unknown>): CrtrError {
  return new CrtrError('not_found', message, ExitCode.NOT_FOUND, details);
}

export function usage(message: string, details?: Record<string, unknown>): CrtrError {
  return new CrtrError('usage', message, ExitCode.USAGE, details);
}

export function ambiguous(message: string, details?: Record<string, unknown>): CrtrError {
  return new CrtrError('ambiguous', message, ExitCode.AMBIGUOUS, details);
}

export function network(message: string, details?: Record<string, unknown>): CrtrError {
  return new CrtrError('network', message, ExitCode.NETWORK, details);
}

export function general(message: string, details?: Record<string, unknown>): CrtrError {
  return new CrtrError('error', message, ExitCode.GENERAL, details);
}
