/**
 * Reconcile engine (Phase P6) — the single, per-pair, direction-agnostic
 * reconcile for bidirectional crtr ↔ Claude skill sync.
 *
 * `reconcilePair` is the ONLY reconcile routine (R-U3): there is no forward
 * path + reverse path. Body and asset reconciliation is a symmetric 3-way merge
 * (base = snapshot, ours = crtr, theirs = claude); frontmatter is the only
 * asymmetric axis and all of that asymmetry lives in the translation profile
 * (P5). The snapshot (P3) is the sole change-detector (R-U4): nothing here reads
 * mtimes, fingerprints, or a stamp file.
 *
 * Strictness (R-U6): a conflict — overlapping body/asset merge, a both-sides
 * non-equivalent frontmatter divergence, an asset deleted-on-one ∧ edited-on-the
 * other, or a first-sync divergence with no common base — writes NOTHING for the
 * pair, leaves both endpoints + the snapshot byte-untouched, and surfaces a
 * git-style conflict report. There is no "best-effort" partial write and no
 * silent side-pick.
 *
 * `--dry-run` (R-O1): every merge is computed and the would-be status returned,
 * but no endpoint file, snapshot, or conflict report is touched.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { usage } from '../errors.js';
import { parseFrontmatterGeneric } from '../frontmatter.js';
import { findPluginByName } from '../resolver.js';
import { resolveClaudePluginInstallPath } from './claude-plugins.js';
import {
  findProjectScopeRoot,
  pluginMemoryDir,
  scopeMemoryDir,
} from '../scope.js';
import { SKILLS_DIR, SKILL_ENTRY_FILE } from '../../types.js';
import type { Endpoint, Pair } from './manifest.js';
import type { TranslationProfile } from './profile.js';
import {
  clearConflictReport,
  readSnapshot,
  snapshotDir,
  writeConflictReport,
  writeSnapshot,
  type Snapshot,
  type SnapshotMeta,
} from './snapshot.js';

// ── Public surface ───────────────────────────────────────────────────────────

/** The outcome of reconciling one pair. `wrote` counts endpoint files
 *  created/updated (never deletions, never the snapshot bookkeeping). */
export interface PairResult {
  id: string;
  status: 'synced' | 'conflict' | 'noop';
  wrote: number;
}

export interface ReconcileOpts {
  dryRun: boolean;
}

/**
 * Reconcile a single enrolled pair (R-E2). Resolves both endpoints, loads (or
 * seeds) the snapshot, 3-way merges body + assets and translate-and-owns the
 * frontmatter, then either writes through cleanly to both sides or reports the
 * conflict and skips. Never throws on a *content* conflict (that is a reported
 * outcome); throws only on a structural/configuration error (an unresolvable
 * endpoint, both endpoints missing) so the caller surfaces it as a hard stop.
 */
export function reconcilePair(
  pair: Pair,
  profile: TranslationProfile,
  opts: ReconcileOpts,
): PairResult {
  const crtrDir = resolveCrtrBundleDir(pair.crtr);
  const claudeDir = resolveClaudeBundleDir(pair.claude);
  const crtr = readSide(crtrDir);
  const claude = readSide(claudeDir);
  const snapshot = readSnapshot(pair.id);

  if (snapshot === null) {
    return seed(pair, profile, opts, crtr, claude, crtrDir, claudeDir);
  }
  return reconcileWithBase(
    pair,
    profile,
    opts,
    snapshot,
    crtr,
    claude,
    crtrDir,
    claudeDir,
  );
}

// ── Endpoint resolution (§Resolved-here-6) ───────────────────────────────────

/** crtr endpoint → its bundle dir `<memoryDir>/<name>/`. */
function resolveCrtrBundleDir(ep: Endpoint): string {
  let memoryDir: string | null;
  if (ep.scope === 'plugin') {
    const plugin = findPluginByName(ep.plugin!);
    if (!plugin) {
      throw usage(`skill-sync: crtr plugin "${ep.plugin}" not installed`);
    }
    memoryDir = pluginMemoryDir(plugin);
  } else if (ep.scope === 'user' || ep.scope === 'project') {
    memoryDir = scopeMemoryDir(ep.scope);
  } else {
    throw usage(
      `skill-sync: scope "${ep.scope}" is not valid for a crtr endpoint ` +
        `(use user, project, or plugin)`,
    );
  }
  if (!memoryDir) {
    throw usage(`skill-sync: no crtr ${ep.scope} memory dir available for "${ep.name}"`);
  }
  return join(memoryDir, ep.name);
}

/** Claude endpoint → its bundle dir `<skillsRoot>/<name>/`. The per-scope Claude
 *  skills roots: user `~/.claude/skills`, project `<proj>/.claude/skills`, and
 *  `claude-plugin` the owning plugin's actual install path
 *  `<installPath>/skills` (resolved from Claude's own registry, in place — no
 *  user-scope copy). */
function resolveClaudeBundleDir(ep: Endpoint): string {
  let skillsRoot: string;
  if (ep.scope === 'user') {
    skillsRoot = join(homedir(), '.claude', SKILLS_DIR);
  } else if (ep.scope === 'project') {
    const projScopeRoot = findProjectScopeRoot();
    if (!projScopeRoot) {
      throw usage(`skill-sync: no project scope for Claude endpoint "${ep.name}"`);
    }
    // `<proj>/.crouter` → the project dir is its parent; Claude skills sit at
    // `<proj>/.claude/skills`.
    skillsRoot = join(dirname(projScopeRoot), '.claude', SKILLS_DIR);
  } else if (ep.scope === 'claude-plugin') {
    skillsRoot = join(resolveClaudePluginInstallPath(ep.plugin!), SKILLS_DIR);
  } else {
    throw usage(
      `skill-sync: scope "${ep.scope}" is not valid for a Claude endpoint ` +
        `(use user, project, or claude-plugin)`,
    );
  }
  return join(skillsRoot, ep.name);
}

// ── Reading one side of a pair ───────────────────────────────────────────────

interface Side {
  exists: boolean;
  /** Raw inner YAML of the frontmatter block (no fences, no trailing newline);
   *  empty when the SKILL.md has no frontmatter. */
  rawFrontmatter: string;
  frontmatter: Record<string, unknown> | null;
  /** Body with the frontmatter block stripped. */
  body: string;
  /** Sibling/subdir assets, keyed by POSIX relpath under the bundle dir. */
  assets: Map<string, Buffer>;
}

const EMPTY_SIDE: Side = {
  exists: false,
  rawFrontmatter: '',
  frontmatter: null,
  body: '',
  assets: new Map(),
};

function readSide(bundleDir: string): Side {
  const skillPath = join(bundleDir, SKILL_ENTRY_FILE);
  if (!existsSync(skillPath)) return { ...EMPTY_SIDE, assets: new Map() };
  const parsed = parseFrontmatterGeneric(readFileSync(skillPath, 'utf8'));
  return {
    exists: true,
    rawFrontmatter: parsed.raw,
    frontmatter: parsed.data,
    body: parsed.body,
    assets: readBundleAssets(bundleDir),
  };
}

/** Every file under `bundleDir` EXCEPT the top-level SKILL.md, keyed by POSIX
 *  relpath. Mirrors the snapshot store's asset-map key shape. */
function readBundleAssets(bundleDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (cur: string): void => {
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const rel = relative(bundleDir, full).split(sep).join('/');
        if (rel === SKILL_ENTRY_FILE) continue; // the doc, not an asset
        out.set(rel, readFileSync(full));
      }
    }
  };
  walk(bundleDir);
  return out;
}

// ── Frontmatter field access ─────────────────────────────────────────────────

const CRTR_WHENWHY = 'when-and-why-to-read';
const CRTR_SHORTFORM = 'short-form';
const CLAUDE_DESC = 'description';

interface CrtrFm {
  whenAndWhy?: string;
  shortForm?: string;
}

function strField(rec: Record<string, unknown> | null, key: string): string | undefined {
  if (!rec) return undefined;
  const v = rec[key];
  if (v === undefined || v === null) return undefined;
  return typeof v === 'string' ? v : String(v);
}

function readCrtrFm(side: Side): CrtrFm {
  return {
    whenAndWhy: strField(side.frontmatter, CRTR_WHENWHY),
    shortForm: strField(side.frontmatter, CRTR_SHORTFORM),
  };
}

function readClaudeDesc(side: Side): string | undefined {
  return strField(side.frontmatter, CLAUDE_DESC);
}

function sameStr(a: string | undefined, b: string | undefined): boolean {
  return (a ?? undefined) === (b ?? undefined);
}

function sameCrtrFm(a: CrtrFm, b: CrtrFm): boolean {
  return sameStr(a.whenAndWhy, b.whenAndWhy) && sameStr(a.shortForm, b.shortForm);
}

// ── Frontmatter resolution (R-E4 / OD-1) ─────────────────────────────────────

interface FrontmatterResolution {
  /** Resolved crtr translatable values to write (undefined → field removed). */
  crtr: CrtrFm;
  /** Resolved Claude description to write. */
  claudeDesc: string | undefined;
  /** Set when the two sides diverged non-equivalently — engine must conflict. */
  conflict?: string;
}

/**
 * 3-way the single translatable concept (description ↔ when-and-why/short-form)
 * against the recorded `meta.json` base (R-E4). Owned fields are never touched
 * here — each side reads them through, so they appear in neither input nor
 * output (R-X2). Equivalence (OD-1) is round-trip equality through the canonical
 * Claude side.
 */
function resolveFrontmatter(
  profile: TranslationProfile,
  meta: SnapshotMeta,
  crtrCur: CrtrFm,
  claudeCur: string | undefined,
): FrontmatterResolution {
  const baseCrtr: CrtrFm = {
    whenAndWhy: meta.crtrFrontmatter.whenAndWhy,
    shortForm: meta.crtrFrontmatter.shortForm,
  };
  const baseClaude = meta.claudeFrontmatter.description;

  const crtrChanged = !sameCrtrFm(crtrCur, baseCrtr);
  const claudeChanged = !sameStr(claudeCur, baseClaude);

  if (!crtrChanged && !claudeChanged) {
    return { crtr: crtrCur, claudeDesc: claudeCur };
  }
  if (crtrChanged && !claudeChanged) {
    // crtr is the sole edit → translate it onto the Claude side.
    return { crtr: crtrCur, claudeDesc: translateCrtrToClaude(profile, crtrCur) };
  }
  if (!crtrChanged && claudeChanged) {
    // Claude is the sole edit → translate it onto the crtr side.
    return { crtr: translateClaudeToCrtr(profile, claudeCur), claudeDesc: claudeCur };
  }

  // Both sides changed — equivalent iff each translated to the canonical Claude
  // side yields a byte-identical string (§Resolved-here-5 / OD-1).
  const crtrAsClaude = translateCrtrToClaude(profile, crtrCur);
  const claudeAsClaude = translateCrtrToClaude(
    profile,
    translateClaudeToCrtr(profile, claudeCur),
  );
  if (crtrAsClaude === claudeAsClaude) {
    // Equivalent → no real divergence; keep each side's current value (EC-8).
    return { crtr: crtrCur, claudeDesc: claudeCur };
  }
  return {
    crtr: crtrCur,
    claudeDesc: claudeCur,
    conflict:
      `frontmatter "${CLAUDE_DESC}" / "${CRTR_WHENWHY}" changed on both sides to ` +
      `non-equivalent values:\n` +
      `  crtr  when-and-why-to-read: ${JSON.stringify(crtrCur.whenAndWhy ?? '')}\n` +
      `  crtr  short-form:           ${JSON.stringify(crtrCur.shortForm ?? '')}\n` +
      `  claude description:         ${JSON.stringify(claudeCur ?? '')}`,
  };
}

function translateCrtrToClaude(profile: TranslationProfile, fm: CrtrFm): string {
  return profile.crtrToClaude.description(fm.whenAndWhy ?? '', fm.shortForm);
}

function translateClaudeToCrtr(profile: TranslationProfile, desc: string | undefined): CrtrFm {
  const { whenAndWhy, shortForm } = profile.claudeToCrtr.description(desc ?? '');
  return { whenAndWhy, shortForm };
}

// ── Seeding (first sync — no snapshot) ───────────────────────────────────────

function seed(
  pair: Pair,
  profile: TranslationProfile,
  opts: ReconcileOpts,
  crtr: Side,
  claude: Side,
  crtrDir: string,
  claudeDir: string,
): PairResult {
  if (crtr.exists && claude.exists) {
    const sharedIdentical =
      crtr.body === claude.body && assetsEqual(crtr.assets, claude.assets);
    if (sharedIdentical) {
      // R-S1 — endpoints already identical; seed the base, no merge, no-op.
      const meta = buildMeta(readCrtrFm(crtr), readClaudeDesc(claude));
      if (!opts.dryRun) {
        writeSnapshot(pair.id, { body: crtr.body, assets: crtr.assets, meta });
        clearConflictReport(pair.id);
      }
      return { id: pair.id, status: 'noop', wrote: 0 };
    }
    // R-S2 — divergent with no common ancestor → initial conflict, no write.
    if (!opts.dryRun) {
      writeConflictReport(
        pair.id,
        buildReport(pair.id, [
          'first sync: both endpoints exist but their shared content differs, ' +
            'and there is no snapshot base to merge against. Reconcile the two ' +
            'sides by hand (make them identical) and re-run.',
        ]),
      );
    }
    return { id: pair.id, status: 'conflict', wrote: 0 };
  }

  if (!crtr.exists && !claude.exists) {
    throw usage(
      `skill-sync: pair "${pair.id}" has no skill on either side ` +
        `(crtr ${join(crtrDir, SKILL_ENTRY_FILE)} / claude ${join(claudeDir, SKILL_ENTRY_FILE)})`,
    );
  }

  // R-S3 — one-sided bootstrap: materialize the existing side onto the other,
  // translating the new side's frontmatter, and seed the base.
  const crtrIsSource = crtr.exists;
  const source = crtrIsSource ? crtr : claude;

  let crtrFm: CrtrFm;
  let claudeDesc: string | undefined;
  if (crtrIsSource) {
    crtrFm = readCrtrFm(source);
    claudeDesc = translateCrtrToClaude(profile, crtrFm);
  } else {
    claudeDesc = readClaudeDesc(source);
    crtrFm = translateClaudeToCrtr(profile, claudeDesc);
  }

  const desired: Desired = {
    body: source.body,
    assets: source.assets,
    crtrFmInner: frontmatterInner(crtr, crtrFm, true, pair.crtr),
    claudeFmInner: frontmatterInner(claude, claudeDesc, false, pair.claude),
    meta: buildMeta(crtrFm, claudeDesc),
  };

  const wrote = applyAndSnapshot(pair, opts, desired, crtrDir, claudeDir, null);
  return { id: pair.id, status: 'synced', wrote };
}

// ── Reconcile against an existing base ───────────────────────────────────────

function reconcileWithBase(
  pair: Pair,
  profile: TranslationProfile,
  opts: ReconcileOpts,
  snapshot: Snapshot,
  crtr: Side,
  claude: Side,
  crtrDir: string,
  claudeDir: string,
): PairResult {
  // Whole-bundle presence first: a side whose SKILL.md vanished since the base
  // is a deletion. Propagate it iff the surviving side is unchanged vs base;
  // otherwise it is a delete ∧ edit conflict.
  if (!crtr.exists || !claude.exists) {
    return reconcileDeletion(pair, opts, snapshot, crtr, claude, crtrDir, claudeDir);
  }

  const conflicts: string[] = [];

  // Body — both sides present, base is the snapshot body.
  const bodyRes = mergeContent(
    'SKILL.md (body)',
    Buffer.from(snapshot.body, 'utf8'),
    Buffer.from(crtr.body, 'utf8'),
    Buffer.from(claude.body, 'utf8'),
  );
  let mergedBody = snapshot.body;
  if (bodyRes.kind === 'conflict') conflicts.push(bodyRes.detail);
  else if (bodyRes.kind === 'present') mergedBody = bodyRes.content.toString('utf8');

  // Assets — base-union, per-file 3-way.
  const mergedAssets = new Map<string, Buffer>();
  for (const rel of unionKeys(snapshot.assets, crtr.assets, claude.assets)) {
    const res = mergeSlot(
      rel,
      snapshot.assets.get(rel),
      crtr.assets.get(rel),
      claude.assets.get(rel),
    );
    if (res.kind === 'present') mergedAssets.set(rel, res.content);
    else if (res.kind === 'conflict') conflicts.push(res.detail);
    // 'absent' → deleted on both / clean delete → omit from the merged set.
  }

  // Frontmatter — the single translatable concept, 3-way vs meta.json.
  const fm = resolveFrontmatter(profile, snapshot.meta, readCrtrFm(crtr), readClaudeDesc(claude));
  if (fm.conflict) conflicts.push(fm.conflict);

  if (conflicts.length > 0) {
    if (!opts.dryRun) writeConflictReport(pair.id, buildReport(pair.id, conflicts));
    return { id: pair.id, status: 'conflict', wrote: 0 };
  }

  const desired: Desired = {
    body: mergedBody,
    assets: mergedAssets,
    crtrFmInner: frontmatterInner(crtr, fm.crtr, true, pair.crtr),
    claudeFmInner: frontmatterInner(claude, fm.claudeDesc, false, pair.claude),
    meta: buildMeta(fm.crtr, fm.claudeDesc),
  };

  // Decide synced vs no-op by comparing the desired end-state to what is already
  // on both endpoints AND the snapshot (R-S4 idempotency).
  const counts = applyEndpoints(opts.dryRun, desired, crtrDir, claudeDir, /*write*/ !opts.dryRun);
  const snapDiffers = snapshotDiffers(snapshot, desired);
  const changed = counts.writes > 0 || counts.deletions > 0 || snapDiffers;

  if (!changed) {
    if (!opts.dryRun) clearConflictReport(pair.id); // OD-4 — clear any stale report
    return { id: pair.id, status: 'noop', wrote: 0 };
  }

  if (!opts.dryRun) {
    writeSnapshot(pair.id, { body: desired.body, assets: desired.assets, meta: desired.meta });
    clearConflictReport(pair.id); // OD-4
  }
  // `wrote` counts ACTUAL endpoint files written — 0 under --dry-run, even
  // though `counts.writes` above carries the would-be total used for the
  // synced/noop decision (contract: `sys sync -h` promises 0 under --dry-run).
  return { id: pair.id, status: 'synced', wrote: opts.dryRun ? 0 : counts.writes };
}

/** Handle the case where at least one side's SKILL.md is gone in a 3-way. */
function reconcileDeletion(
  pair: Pair,
  opts: ReconcileOpts,
  snapshot: Snapshot,
  crtr: Side,
  claude: Side,
  crtrDir: string,
  claudeDir: string,
): PairResult {
  // Both gone → the skill was removed everywhere; clear the base, no-op.
  if (!crtr.exists && !claude.exists) {
    if (!opts.dryRun) {
      rmSync(snapshotDir(pair.id), { recursive: true, force: true });
      clearConflictReport(pair.id);
    }
    return { id: pair.id, status: 'noop', wrote: 0 };
  }

  const surviving = crtr.exists ? crtr : claude;
  const survivingUnchanged =
    surviving.body === snapshot.body && assetsEqual(surviving.assets, snapshot.assets);
  const survivingDir = crtr.exists ? crtrDir : claudeDir;
  const deletedLabel = crtr.exists ? 'claude' : 'crtr';

  if (survivingUnchanged) {
    // Clean deletion → remove the surviving bundle and the base.
    if (!opts.dryRun) {
      rmSync(survivingDir, { recursive: true, force: true });
      rmSync(snapshotDir(pair.id), { recursive: true, force: true });
      clearConflictReport(pair.id);
    }
    return { id: pair.id, status: 'synced', wrote: 0 };
  }

  // delete ∧ edit → conflict, no write.
  if (!opts.dryRun) {
    writeConflictReport(
      pair.id,
      buildReport(pair.id, [
        `the skill was deleted on the ${deletedLabel} side but edited on the other ` +
          `side since the last sync. Resolve by hand (restore or finish the deletion) ` +
          `and re-run.`,
      ]),
    );
  }
  return { id: pair.id, status: 'conflict', wrote: 0 };
}

// ── Desired end-state + write-through ────────────────────────────────────────

interface Desired {
  body: string;
  assets: Map<string, Buffer>;
  /** crtr SKILL.md frontmatter inner YAML (no fences/trailing newline). */
  crtrFmInner: string;
  /** Claude SKILL.md frontmatter inner YAML. */
  claudeFmInner: string;
  meta: SnapshotMeta;
}

interface EndpointCounts {
  writes: number;
  deletions: number;
}

/** Apply the desired state to both endpoints (when `write`), counting files
 *  written and deleted across both sides. With `write=false` it only computes
 *  the counts (the dry-run path) and touches nothing. */
function applyEndpoints(
  _dryRun: boolean,
  desired: Desired,
  crtrDir: string,
  claudeDir: string,
  write: boolean,
): EndpointCounts {
  const a = applyEndpoint(crtrDir, desired.crtrFmInner, desired.body, desired.assets, write);
  const b = applyEndpoint(claudeDir, desired.claudeFmInner, desired.body, desired.assets, write);
  return { writes: a.writes + b.writes, deletions: a.deletions + b.deletions };
}

function applyEndpoint(
  bundleDir: string,
  fmInner: string,
  body: string,
  assets: Map<string, Buffer>,
  write: boolean,
): EndpointCounts {
  let writes = 0;
  let deletions = 0;

  // SKILL.md
  const skillPath = join(bundleDir, SKILL_ENTRY_FILE);
  const desiredSkill = renderSkill(fmInner, body);
  const curSkill = existsSync(skillPath) ? readFileSync(skillPath, 'utf8') : null;
  if (curSkill !== desiredSkill) {
    writes++;
    if (write) {
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(skillPath, desiredSkill, 'utf8');
    }
  }

  // Assets: remove on-disk strays not in the desired set, then write the rest.
  const curAssets = existsSync(bundleDir) ? readBundleAssets(bundleDir) : new Map<string, Buffer>();
  for (const rel of curAssets.keys()) {
    if (!assets.has(rel)) {
      deletions++;
      if (write) rmSync(join(bundleDir, ...rel.split('/')), { force: true });
    }
  }
  for (const [rel, buf] of assets) {
    const cur = curAssets.get(rel);
    if (!cur || !cur.equals(buf)) {
      writes++;
      if (write) {
        const full = join(bundleDir, ...rel.split('/'));
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, buf);
      }
    }
  }
  return { writes, deletions };
}

/** Seed/materialize helper: apply both endpoints and the snapshot, returning the
 *  endpoint files written. `_priorSnapshot` is unused today but documents that
 *  callers pass null on a fresh seed. */
function applyAndSnapshot(
  pair: Pair,
  opts: ReconcileOpts,
  desired: Desired,
  crtrDir: string,
  claudeDir: string,
  _priorSnapshot: Snapshot | null,
): number {
  const counts = applyEndpoints(opts.dryRun, desired, crtrDir, claudeDir, !opts.dryRun);
  if (!opts.dryRun) {
    writeSnapshot(pair.id, { body: desired.body, assets: desired.assets, meta: desired.meta });
    clearConflictReport(pair.id);
  }
  // Actual writes only — 0 under --dry-run (see reconcileWithBase note).
  return opts.dryRun ? 0 : counts.writes;
}

/** A SKILL.md document = its frontmatter block + shared body. */
function renderSkill(fmInner: string, body: string): string {
  if (fmInner === '') return body;
  return `---\n${fmInner}\n---\n${body}`;
}

/**
 * The inner YAML for a side's SKILL.md frontmatter. A side is reserialized ONLY
 * when its translatable value actually changes (or it is being materialized);
 * otherwise its original raw frontmatter block is preserved byte-for-byte so a
 * re-run never normalizes hand-authored formatting into a phantom diff (R-S4).
 */
function frontmatterInner(
  side: Side,
  resolved: CrtrFm | string | undefined,
  isCrtr: boolean,
  ep: Endpoint,
): string {
  if (isCrtr) {
    const target = resolved as CrtrFm;
    if (side.exists && sameCrtrFm(target, readCrtrFm(side))) {
      return side.rawFrontmatter; // unchanged → verbatim
    }
    return buildCrtrFrontmatter(side, target);
  }
  const desc = resolved as string | undefined;
  if (side.exists && sameStr(desc, readClaudeDesc(side))) {
    return side.rawFrontmatter; // unchanged → verbatim
  }
  return buildClaudeFrontmatter(side, desc, ep);
}

/** Reconstruct the crtr frontmatter record with the resolved translatable
 *  fields set, preserving every existing (owned/other) field. A freshly
 *  materialized bundle defaults `kind: knowledge` — the valid substrate kind a
 *  crtr-side doc must carry (the merged skill+reference kind). */
function buildCrtrFrontmatter(side: Side, fm: CrtrFm): string {
  const rec: Record<string, unknown> = side.frontmatter ? { ...side.frontmatter } : {};
  if (!side.exists && rec.kind === undefined) rec.kind = 'knowledge';
  setOrDelete(rec, CRTR_WHENWHY, fm.whenAndWhy);
  setOrDelete(rec, CRTR_SHORTFORM, fm.shortForm);
  return serializeInner(rec);
}

/** Reconstruct the Claude frontmatter record with the resolved description set,
 *  preserving every existing (owned/other) field. A freshly materialized bundle
 *  carries `name: <ep.name>`. */
function buildClaudeFrontmatter(side: Side, desc: string | undefined, ep: Endpoint): string {
  const rec: Record<string, unknown> = side.frontmatter ? { ...side.frontmatter } : {};
  if (!side.exists && rec.name === undefined) rec.name = ep.name;
  setOrDelete(rec, CLAUDE_DESC, desc);
  return serializeInner(rec);
}

function setOrDelete(rec: Record<string, unknown>, key: string, value: string | undefined): void {
  if (value === undefined) delete rec[key];
  else rec[key] = value;
}

/** Serialize a frontmatter record to inner YAML (no trailing newline). */
function serializeInner(rec: Record<string, unknown>): string {
  if (Object.keys(rec).length === 0) return '';
  return stringifyYaml(rec).replace(/\n$/, '');
}

function buildMeta(crtr: CrtrFm, claudeDesc: string | undefined): SnapshotMeta {
  const crtrFrontmatter: SnapshotMeta['crtrFrontmatter'] = {};
  if (crtr.whenAndWhy !== undefined) crtrFrontmatter.whenAndWhy = crtr.whenAndWhy;
  if (crtr.shortForm !== undefined) crtrFrontmatter.shortForm = crtr.shortForm;
  const claudeFrontmatter: SnapshotMeta['claudeFrontmatter'] = {};
  if (claudeDesc !== undefined) claudeFrontmatter.description = claudeDesc;
  return { syncedAt: new Date().toISOString(), crtrFrontmatter, claudeFrontmatter };
}

/** True iff the desired shared content or translatable values differ from the
 *  snapshot base (syncedAt is bookkeeping and intentionally ignored). */
function snapshotDiffers(snapshot: Snapshot, desired: Desired): boolean {
  if (snapshot.body !== desired.body) return true;
  if (!assetsEqual(snapshot.assets, desired.assets)) return true;
  const m = snapshot.meta;
  if (!sameStr(m.crtrFrontmatter.whenAndWhy, desired.meta.crtrFrontmatter.whenAndWhy)) return true;
  if (!sameStr(m.crtrFrontmatter.shortForm, desired.meta.crtrFrontmatter.shortForm)) return true;
  if (!sameStr(m.claudeFrontmatter.description, desired.meta.claudeFrontmatter.description)) return true;
  return false;
}

// ── 3-way file merge primitives ──────────────────────────────────────────────

type SlotResult =
  | { kind: 'present'; content: Buffer }
  | { kind: 'absent' }
  | { kind: 'conflict'; detail: string };

/** File-level 3-way for one asset relpath, resolving presence by the base-union
 *  rule (add-both / delete-both / delete ∧ edit → conflict) then content. */
function mergeSlot(
  rel: string,
  base: Buffer | undefined,
  ours: Buffer | undefined,
  theirs: Buffer | undefined,
): SlotResult {
  if (base) {
    if (!ours && !theirs) return { kind: 'absent' }; // deleted both sides
    if (!ours) {
      // deleted on crtr
      if (theirs!.equals(base)) return { kind: 'absent' }; // untouched other → delete both
      return { kind: 'conflict', detail: `asset ${rel}: deleted on crtr, edited on claude` };
    }
    if (!theirs) {
      // deleted on claude
      if (ours.equals(base)) return { kind: 'absent' };
      return { kind: 'conflict', detail: `asset ${rel}: deleted on claude, edited on crtr` };
    }
    return mergeContent(`asset ${rel}`, base, ours, theirs);
  }
  // Not in base.
  if (!ours && !theirs) return { kind: 'absent' };
  if (ours && !theirs) return { kind: 'present', content: ours }; // added on crtr
  if (!ours && theirs) return { kind: 'present', content: theirs }; // added on claude
  if (ours!.equals(theirs!)) return { kind: 'present', content: ours! }; // added identically
  // Both added divergently → merge against an empty base.
  return mergeContent(`asset ${rel}`, Buffer.alloc(0), ours!, theirs!);
}

/** Content 3-way for a slot present on all three of base/ours/theirs. Text →
 *  `git merge-file`; binary (NUL in first 8 KB, §Resolved-here-3) → whole-file
 *  identity 3-way, never line-merged (OD-2). */
function mergeContent(label: string, base: Buffer, ours: Buffer, theirs: Buffer): SlotResult {
  if (base.equals(ours) && base.equals(theirs)) return { kind: 'present', content: ours };
  if (base.equals(ours)) return { kind: 'present', content: theirs }; // only theirs changed
  if (base.equals(theirs)) return { kind: 'present', content: ours }; // only ours changed
  if (ours.equals(theirs)) return { kind: 'present', content: ours }; // both → same value

  if (isBinary(base) || isBinary(ours) || isBinary(theirs)) {
    return { kind: 'conflict', detail: `${label}: binary content changed on both sides` };
  }
  const { merged, conflicts } = mergeFile3(base, ours, theirs);
  if (conflicts) {
    return { kind: 'conflict', detail: `${label}:\n${merged.toString('utf8')}` };
  }
  return { kind: 'present', content: merged };
}

/** An asset is binary iff a NUL byte appears in its first 8 KB (§Resolved-here-3). */
function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Synthetic 3-way text merge via `git merge-file -p` (§Resolved-here-2). The
 * three inputs are written to a private temp dir; stdout carries the merged
 * result (with git-style conflict markers when overlapping), and the exit
 * status is the conflict count (0 = clean; ≥128 / 255 / null = a real failure,
 * which throws — never a silent best-effort).
 */
function mergeFile3(base: Buffer, ours: Buffer, theirs: Buffer): { merged: Buffer; conflicts: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'crtr-skill-sync-'));
  try {
    const oursPath = join(dir, 'ours');
    const basePath = join(dir, 'base');
    const theirsPath = join(dir, 'theirs');
    writeFileSync(oursPath, ours);
    writeFileSync(basePath, base);
    writeFileSync(theirsPath, theirs);
    const res = spawnSync(
      'git',
      ['merge-file', '-p', '-L', 'crtr', '-L', 'base', '-L', 'claude', oursPath, basePath, theirsPath],
      { maxBuffer: 1 << 28 },
    );
    const status = res.status;
    if (res.error || status === null || status < 0 || status >= 128) {
      throw usage(
        `skill-sync: git merge-file failed (${res.error?.message ?? `status ${status}`})`,
      );
    }
    return { merged: res.stdout, conflicts: status > 0 };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── Small utilities ──────────────────────────────────────────────────────────

function assetsEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false;
  for (const [rel, buf] of a) {
    const other = b.get(rel);
    if (!other || !other.equals(buf)) return false;
  }
  return true;
}

function unionKeys(...maps: Map<string, Buffer>[]): Set<string> {
  const out = new Set<string>();
  for (const m of maps) for (const k of m.keys()) out.add(k);
  return out;
}

/** Assemble a human-readable conflict report (R-E6 / R-X1). */
function buildReport(id: string, entries: string[]): string {
  const lines = [`# skill-sync conflict: ${id}`, ''];
  lines.push(
    'This pair was NOT written. Resolve the conflicts below by editing the ' +
      'endpoints, then re-run `crtr sys sync`.',
    '',
  );
  for (const e of entries) {
    lines.push('---', '', e, '');
  }
  return lines.join('\n');
}
