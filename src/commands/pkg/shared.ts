import { join } from 'node:path';
import { notFound, usage } from '../../core/errors.js';
import { resolveScopeArg, pluginsDir, projectScopeRoot } from '../../core/scope.js';
import { updateConfig } from '../../core/config.js';
import { pathExists } from '../../core/fs-utils.js';
import type { Scope } from '../../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const GIT_URL_RE = /^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/;

export function isGitUrl(arg: string): boolean {
  return GIT_URL_RE.test(arg) || arg.endsWith('.git');
}

export function resolveInstallScope(scopeInput: string | undefined): Scope {
  if (scopeInput !== undefined) {
    const resolved = resolveScopeArg(scopeInput);
    if (resolved === 'all' || resolved === 'builtin') {
      throw usage('scope must be "user" or "project"');
    }
    return resolved;
  }
  // Default: project if available, else user
  return projectScopeRoot() !== null ? 'project' : 'user';
}

export async function setPluginEnabled(
  input: Record<string, unknown>,
  enabled: boolean,
): Promise<Record<string, unknown>> {
  const name = input['name'] as string;
  const scopeInput = input['scope'] as string | undefined;

  let scopes: Scope[];
  if (scopeInput !== undefined) {
    const resolved = resolveScopeArg(scopeInput);
    if (resolved === 'builtin') throw usage('cannot enable/disable plugins in builtin scope');
    scopes = resolved === 'all' ? (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null) : [resolved];
  } else {
    scopes = (['project', 'user'] as Scope[]).filter((s) => s !== 'project' || projectScopeRoot() !== null);
  }

  let actedScope: string | undefined;

  for (const scope of scopes) {
    const pDir = pluginsDir(scope);
    if (pDir === null) continue;
    const pluginDir = join(pDir, name);
    if (!pathExists(pluginDir)) continue;

    updateConfig(scope, (cfg) => {
      const entry = cfg.plugins[name];
      if (entry !== undefined) {
        entry.enabled = enabled;
      } else {
        cfg.plugins[name] = { enabled };
      }
    });
    actedScope = scope;
    break; // only act on first found scope
  }

  if (actedScope === undefined) {
    throw notFound(`plugin not found: ${name}`);
  }

  return { name, scope: actedScope, enabled };
}
