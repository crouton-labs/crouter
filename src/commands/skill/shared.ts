import { usage } from '../../core/errors.js';
import type { Scope } from '../../types.js';
import { resolveScopeArg, projectScopeRoot } from '../../core/scope.js';

// ---------------------------------------------------------------------------
// Resolve scope for scaffold
// ---------------------------------------------------------------------------

export function resolveWriteScope(scopeStr: string | undefined): Scope {
  if (scopeStr !== undefined) {
    const resolved = resolveScopeArg(scopeStr);
    if (resolved === 'all') {
      throw usage('scope must be user or project, not all');
    }
    return resolved;
  }
  return projectScopeRoot() !== null ? 'project' : 'user';
}

// ---------------------------------------------------------------------------
// Valid skill types (used by author sub-branch)
// ---------------------------------------------------------------------------

export const VALID_TYPES = ['playbook', 'primer', 'reference', 'runbook', 'freeform'] as const;


