/**
 * Claude-plugin endpoint resolution for skill-sync.
 *
 * The `claude-plugin` endpoint scope addresses a skill IN PLACE at the path
 * where Claude actually installs the owning plugin — `<installPath>/skills/<name>`
 * — instead of forcing a copy under `~/.claude/skills/`. The install path is read
 * from Claude's OWN registry (`~/.claude/plugins/installed_plugins.json`), keyed
 * by the marketplace-qualified plugin key (`<plugin>@<marketplace>`), gated on the
 * enable state in `~/.claude/settings.json` → `enabledPlugins`.
 *
 * This is Claude's registry, deliberately NOT crtr's plugin registry
 * (`resolver.ts` / `findPluginByName`): the two are independent installs.
 *
 * Strictness (no lenient fallback): a key that is unknown, disabled, or whose
 * recorded install path is missing on disk is a HARD error naming it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { usage } from '../errors.js';

function claudeDir(): string {
  return join(homedir(), '.claude');
}

interface InstalledEntry {
  installPath?: string;
}

/**
 * Resolve a Claude plugin's on-disk install path from its marketplace-qualified
 * key (`<plugin>@<marketplace>`, e.g. `devcore@crouton-kit`). Throws naming the
 * key when it is not installed, not enabled, or has no install path present on
 * disk.
 */
export function resolveClaudePluginInstallPath(key: string): string {
  const registryPath = join(claudeDir(), 'plugins', 'installed_plugins.json');
  if (!existsSync(registryPath)) {
    throw usage(`skill-sync: Claude plugin registry not found at ${registryPath}`);
  }

  let registry: { plugins?: Record<string, InstalledEntry[]> };
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (err) {
    throw usage(`skill-sync: invalid ${registryPath}: ${(err as Error).message}`);
  }

  const entries = registry.plugins?.[key];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw usage(
      `skill-sync: Claude plugin "${key}" is not installed ` +
        `(no entry in ${registryPath})`,
    );
  }

  if (!isClaudePluginEnabled(key)) {
    throw usage(
      `skill-sync: Claude plugin "${key}" is installed but not enabled ` +
        `(settings.json enabledPlugins)`,
    );
  }

  const install = entries.find((e) => e.installPath && existsSync(e.installPath));
  if (!install?.installPath) {
    throw usage(
      `skill-sync: Claude plugin "${key}" has no install path present on disk`,
    );
  }
  return install.installPath;
}

/** True iff `enabledPlugins[key] === true` in `~/.claude/settings.json`. A
 *  missing or unparseable settings file means "not enabled" — the caller turns
 *  that into a hard error naming the key. */
function isClaudePluginEnabled(key: string): boolean {
  const settingsPath = join(claudeDir(), 'settings.json');
  if (!existsSync(settingsPath)) return false;
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      enabledPlugins?: Record<string, boolean>;
    };
    return settings.enabledPlugins?.[key] === true;
  } catch {
    return false;
  }
}
