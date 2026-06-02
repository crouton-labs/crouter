import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { usage } from '../../core/errors.js';
import type { Scope } from '../../types.js';

// ---------------------------------------------------------------------------
// Package version
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// shared.ts is one directory deeper than the original sys.ts was
// (dist/commands/sys/shared.js vs dist/commands/sys.js), so one extra '..'
const PKG_ROOT = join(__dirname, '..', '..', '..');

export function readPackageVersion(): string {
  const raw = readFileSync(join(PKG_ROOT, 'package.json'), 'utf8');
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

export function resolveScope(raw: string | undefined): Scope {
  if (raw === undefined) return 'user';
  if (raw === 'user' || raw === 'project') return raw;
  throw usage(`scope must be 'user' or 'project', got: ${raw}`);
}
