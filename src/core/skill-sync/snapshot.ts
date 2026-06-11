/**
 * Per-pair merge-base snapshot store + conflict-report helpers.
 *
 * All machine-local skill-sync I/O lives here. Nothing in this module is
 * committed: everything is rooted under `~/.crouter/skill-sync/` (R-U9), which
 * is the machine-local, uncommitted tier — never a scope's committed dirs.
 *
 *   snapshots/<pair-id>/body.md      merge base, frontmatter stripped (R-I3)
 *   snapshots/<pair-id>/assets/…     byte-for-byte base of every non-SKILL.md
 *                                    file, mirroring subdir structure (R-I3)
 *   snapshots/<pair-id>/meta.json    { syncedAt, crtrFrontmatter, claudeFrontmatter }
 *   conflicts/<pair-id>.md           current conflict report, if any (R-E6/OD-4)
 *
 * The snapshot is the SOLE change-detector (R-U4): the engine diffs body/assets
 * against `body.md`/`assets/`, and each frontmatter value against the recorded
 * `meta.json` value — no mtime, no fingerprint, no stamp file.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { userScopeRoot } from '../scope.js';

/**
 * The translatable values recorded for each side at last sync. These are the
 * ONLY values stored (§Resolved-here-4): owned fields are never recorded —
 * each side reads its own owned fields through, so they need no merge base.
 */
export interface SnapshotMeta {
  /** ISO 8601 timestamp of the sync that produced this base. */
  syncedAt: string;
  /** crtr-side translatable frontmatter at last sync. */
  crtrFrontmatter: {
    whenAndWhy?: string;
    shortForm?: string;
  };
  /** Claude-side translatable frontmatter at last sync. */
  claudeFrontmatter: {
    description?: string;
  };
}

/** A fully-loaded merge base for one pair. */
export interface Snapshot {
  /** Shared body, frontmatter stripped. */
  body: string;
  /** Non-SKILL.md base assets, keyed by POSIX-style relpath under `assets/`. */
  assets: Map<string, Buffer>;
  /** Recorded translatable values + sync timestamp. */
  meta: SnapshotMeta;
}

// ── Path roots ───────────────────────────────────────────────────────────────

/** `~/.crouter/skill-sync/` — the machine-local, uncommitted root (R-U9). */
export function skillSyncRoot(): string {
  return join(userScopeRoot(), 'skill-sync');
}

function snapshotsRoot(): string {
  return join(skillSyncRoot(), 'snapshots');
}

function conflictsRoot(): string {
  return join(skillSyncRoot(), 'conflicts');
}

/** `~/.crouter/skill-sync/snapshots/<id>/`. */
export function snapshotDir(id: string): string {
  return join(snapshotsRoot(), id);
}

/** `~/.crouter/skill-sync/conflicts/<id>.md`. */
export function conflictReportPath(id: string): string {
  return join(conflictsRoot(), `${id}.md`);
}

// ── Asset helpers ────────────────────────────────────────────────────────────

/** Recursively read every file under `dir`, keyed by POSIX relpath. */
function readAssetTree(dir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!existsSync(dir)) return out;
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(dir, full).split(sep).join('/');
        out.set(rel, readFileSync(full));
      }
    }
  };
  walk(dir);
  return out;
}

// ── Snapshot read / write ────────────────────────────────────────────────────

/**
 * Load the merge base for `id`, or `null` when the snapshot dir is absent
 * (no prior sync — the engine seeds on first reconcile, R-S1/R-S3).
 */
export function readSnapshot(id: string): Snapshot | null {
  const dir = snapshotDir(id);
  if (!existsSync(dir)) return null;

  const bodyPath = join(dir, 'body.md');
  const body = existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '';

  const assets = readAssetTree(join(dir, 'assets'));

  const metaPath = join(dir, 'meta.json');
  const meta: SnapshotMeta = existsSync(metaPath)
    ? (JSON.parse(readFileSync(metaPath, 'utf8')) as SnapshotMeta)
    : { syncedAt: '', crtrFrontmatter: {}, claudeFrontmatter: {} };

  return { body, assets, meta };
}

/**
 * Write the merge base for `id` byte-for-byte. The snapshot dir is rebuilt
 * from scratch so stale assets from a prior base never linger — the on-disk
 * `assets/` always mirrors exactly the passed `assets` map (R-U5/R-I3).
 */
export function writeSnapshot(id: string, snapshot: Snapshot): void {
  const dir = snapshotDir(id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'body.md'), snapshot.body, 'utf8');

  const assetsDir = join(dir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  for (const [rel, buf] of snapshot.assets) {
    const full = join(assetsDir, ...rel.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, buf);
  }

  writeFileSync(
    join(dir, 'meta.json'),
    `${JSON.stringify(snapshot.meta, null, 2)}\n`,
    'utf8',
  );
}

// ── Conflict-report helpers (R-E6 / OD-4) ────────────────────────────────────

/**
 * Write the current conflict report for `id` to `conflicts/<id>.md`. The engine
 * calls this on any true conflict (overlapping body/asset merge or both-sides
 * non-equivalent frontmatter) after deciding to write nothing for the pair.
 */
export function writeConflictReport(id: string, text: string): void {
  const path = conflictReportPath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
}

/**
 * Delete a stale `conflicts/<id>.md` once the pair reconciles cleanly or
 * becomes a no-op (OD-4). No-op if absent — never throws on a missing report.
 */
export function clearConflictReport(id: string): void {
  rmSync(conflictReportPath(id), { force: true });
}

/** True iff a conflict report currently exists for `id`. */
export function hasConflictReport(id: string): boolean {
  const path = conflictReportPath(id);
  return existsSync(path) && statSync(path).isFile();
}
