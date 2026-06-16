/**
 * One-way export of crtr-generated host artifacts — the sole writer of
 * generated slash-command templates to `~/.claude/commands` and
 * `~/.pi/agent/prompts`.
 *
 * crouter no longer exports Agent Skills / SKILL.md bundles. The export pass
 * still prunes old marker-bearing `crtr-skills` bundles so hosts stop surfacing
 * pi/Claude native skills after the memory cutover. Markerless files are
 * user-owned and never removed.
 *
 * Triggered per-run by cli.ts (argv-gated, exactly as the old writers were) so
 * first-run provisioning is preserved. Best-effort: a provisioning fault must
 * never break an unrelated `crtr` command (the deliberate, pre-existing
 * behavior of the deleted writers).
 */

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureDir, pathExists, readText, removePath } from '../fs-utils.js';
import type { RootDef } from '../command.js';
import { builtinExportPairs, legacyExportArtifacts, type Host, type HostTarget } from './builtins.js';

const SKIP_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
]);

/** Skip provisioning side effects entirely for help/version invocations. */
function shouldSkipAllForArgv(argv: string[]): boolean {
  const sub = argv[2];
  return sub !== undefined && SKIP_SUBCOMMANDS.has(sub);
}

/** Skip slash-command writes for bare front-door boot; pruning still runs. */
function shouldSkipWritesForArgv(argv: string[]): boolean {
  return argv[2] === undefined;
}

/** Whether a host runtime is in use (its root dir exists). crtr writes into a
 *  host's dirs only when present and never creates `~/.claude` or `~/.pi`. */
function hostRootExists(host: Host): boolean {
  if (host === 'claude') return pathExists(join(homedir(), '.claude'));
  return pathExists(join(homedir(), '.pi', 'agent'));
}

/** Resolve the on-disk path for one target from its layout. */
function targetPath(target: HostTarget, name: string): string {
  const dir = target.dir();
  return target.layout === 'bundle'
    ? join(dir, name, 'SKILL.md')
    : join(dir, `${name}.md`);
}

/** Write `content` to `path` unless a user-customized file is already there.
 *  Rolls forward our own (marker-bearing) versions; skips if identical. Creates
 *  only the leaf dir, never the host root. The single generalization of
 *  bootstrap.ts's two clobber-guards. */
export function writeIfOurs(path: string, content: string, markerPrefix: string): void {
  if (pathExists(path)) {
    const existing = readText(path);
    if (!existing.includes(markerPrefix)) return; // user-owned → never clobber
    if (existing === content) return; // already current
  }
  ensureDir(dirname(path));
  writeFileSync(path, content, 'utf8');
}

/** Remove a legacy artifact only when its marker proves crtr generated it. */
function removeIfOurs(path: string, target: HostTarget, markerPrefix: string): void {
  if (!pathExists(path)) return;
  const existing = readText(path);
  if (!existing.includes(markerPrefix)) return;
  removePath(target.layout === 'bundle' ? dirname(path) : path);
}

/** Render and write every built-in export artifact to every present host, while
 *  pruning legacy generated artifacts that should no longer be surfaced.
 *  Best-effort: swallows errors (debug-logged) so a provisioning fault never
 *  breaks an unrelated `crtr` command. Kill switch: `CRTR_NO_EXPORTS=1`. */
export function provisionExports(root: RootDef, argv: string[] = process.argv): void {
  try {
    if (process.env.CRTR_NO_EXPORTS === '1') return;
    if (shouldSkipAllForArgv(argv)) return;

    for (const artifact of legacyExportArtifacts()) {
      for (const target of artifact.targets) {
        if (!hostRootExists(target.host)) continue;
        removeIfOurs(targetPath(target, artifact.name), target, artifact.markerPrefix);
      }
    }

    if (shouldSkipWritesForArgv(argv)) return;

    for (const pair of builtinExportPairs(root)) {
      const content = pair.render();
      for (const target of pair.targets) {
        if (!hostRootExists(target.host)) continue;
        writeIfOurs(targetPath(target, pair.name), content, pair.markerPrefix);
      }
    }
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: exports error: ${msg}\n`);
    }
  }
}
