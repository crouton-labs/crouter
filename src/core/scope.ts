import { homedir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { CRTR_DIR_NAME } from '../types.js';
import type { Scope } from '../types.js';
import { usage } from './errors.js';

let cachedProjectRoot: string | null | undefined;

export function userScopeRoot(): string {
  return join(homedir(), CRTR_DIR_NAME);
}

export function findProjectScopeRoot(startDir: string = process.cwd()): string | null {
  if (cachedProjectRoot !== undefined) return cachedProjectRoot;
  const userRoot = userScopeRoot();
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, CRTR_DIR_NAME);
    if (candidate !== userRoot && existsSync(candidate)) {
      try {
        if (statSync(candidate).isDirectory()) {
          cachedProjectRoot = candidate;
          return candidate;
        }
      } catch {
        /* fall through */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      cachedProjectRoot = null;
      return null;
    }
    dir = parent;
  }
}

export function projectScopeRoot(startDir?: string): string | null {
  return findProjectScopeRoot(startDir);
}

export function scopeRoot(scope: Scope): string | null {
  return scope === 'user' ? userScopeRoot() : projectScopeRoot();
}

export function requireScopeRoot(scope: Scope): string {
  const root = scopeRoot(scope);
  if (!root) {
    throw usage(
      `no ${scope} scope available — run \`crtr init\` here or use --scope user`,
    );
  }
  return root;
}

export function ensureProjectScopeRoot(startDir: string = process.cwd()): string {
  const found = findProjectScopeRoot(startDir);
  if (found) return found;
  // Initialize new project scope at startDir
  const root = join(resolve(startDir), CRTR_DIR_NAME);
  cachedProjectRoot = root;
  return root;
}

export function pluginsDir(scope: Scope): string | null {
  const root = scopeRoot(scope);
  return root ? join(root, 'plugins') : null;
}

export function marketplacesDir(scope: Scope): string | null {
  const root = scopeRoot(scope);
  return root ? join(root, 'marketplaces') : null;
}

export function resolveScopeArg(scopeArg: string | undefined): Scope | 'all' {
  if (scopeArg === undefined) return 'all';
  const value = scopeArg.toLowerCase();
  if (value === 'user' || value === 'project' || value === 'all') return value;
  throw usage(`invalid --scope: ${scopeArg} (expected user|project|all)`);
}

export function listScopes(scopeArg: string | undefined): Scope[] {
  const v = resolveScopeArg(scopeArg);
  if (v === 'all') {
    const out: Scope[] = [];
    if (projectScopeRoot()) out.push('project');
    out.push('user');
    return out;
  }
  return [v];
}

export function resetScopeCache(): void {
  cachedProjectRoot = undefined;
}
