/**
 * One-way export of crtr-generated host artifacts — the sole writer of
 * generated content to `~/.claude/skills`, `~/.claude/commands`, and
 * `~/.pi/agent/prompts`. Replaces the two host-dir writers that lived in
 * bootstrap.ts (`ensureBootSkill` + `ensureSlashCommands`), collapsing their
 * two clobber-guards into one `writeIfOurs` and their two kill-switches
 * (`CRTR_NO_BOOT_SKILL` / `CRTR_NO_MODE_CMDS`) into one `CRTR_NO_EXPORTS`.
 *
 * Triggered per-run by cli.ts (argv-gated, exactly as the old writers were) so
 * first-run provisioning is preserved. Best-effort: a provisioning fault must
 * never break an unrelated `crtr` command (the deliberate, pre-existing
 * behavior of the deleted writers).
 */

import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ensureDir, pathExists, readText } from '../fs-utils.js';
import type { RootDef } from '../command.js';
import { builtinExportPairs, type Host, type HostTarget } from './builtins.js';

const SKIP_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
]);

/** Skip provisioning for help/version invocations — never write on `-h`. */
function shouldSkipForArgv(argv: string[]): boolean {
  const sub = argv[2];
  if (sub === undefined) return true;
  return SKIP_SUBCOMMANDS.has(sub);
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

/** Render and write every built-in export artifact to every present host.
 *  Best-effort: swallows errors (debug-logged) so a provisioning fault never
 *  breaks an unrelated `crtr` command. Kill switch: `CRTR_NO_EXPORTS=1`. */
export function provisionExports(root: RootDef, argv: string[] = process.argv): void {
  try {
    if (process.env.CRTR_NO_EXPORTS === '1') return;
    if (shouldSkipForArgv(argv)) return;

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
