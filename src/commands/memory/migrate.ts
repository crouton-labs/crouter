// `crtr memory migrate` — the one-shot relocator that copies the OLD memory
// stores + skills into the new document substrate, transforming each doc to the
// new frontmatter schema on the way.
//
// COPY mode (the default): it only ever WRITES new files at the new locations;
// it NEVER deletes or moves a source. The single exception is node-local
// memory, which the design pins to "normalize IN PLACE" (it has no workspace to
// relocate to) — that rewrites the same file additively (kind + rungs added,
// body preserved) and is idempotent.
//
// The transform rules (design-substrate.md §10 / §9, verdicts M2/m3):
//   • old metadata.type / type → kind (skill | reference | preference).
//   • kind→default rungs (KIND_DEFAULT_RUNGS) applied unless demote/promote.
//   • FACTS DEMOTE OFF BOOT (M2): a fact (→ reference) gets
//     system-prompt-visibility: none — facts no longer auto-load at boot.
//   • IDENTITY FACTS PROMOTE (M2 exception): a who-is-the-human fact (old
//     metadata.type `user`) → system-prompt-visibility: preview, kept at boot.
//   • SKILLS: the old `description` is split best-effort into when + why.
//   • EVERY migrated doc is flagged `needs-refinement: true` (m3, lossy seed) so
//     a later human/agent pass can sharpen when/why.
//
// SKELETON SIBLING: list/read/find/write leaves are owned by another track; this
// file owns ONLY the `migrate` leaf and wires into memory.ts alongside them.

import { homedir } from 'node:os';
import { existsSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';

import { defineLeaf } from '../../core/command.js';
import { ensureDir, pathExists, readText, walkFiles } from '../../core/fs-utils.js';
import { parseFrontmatterGeneric } from '../../core/frontmatter.js';
import {
  scopeMemoryDir,
  scopeSkillsDir,
  builtinSkillsRoot,
  builtinMemoryRoot,
} from '../../core/scope.js';
import { crtrHome } from '../../core/canvas/index.js';
import { KIND_DEFAULT_RUNGS, isDocKind } from '../../core/substrate/index.js';
import type { DocKind, Rung } from '../../core/substrate/index.js';

// ---------------------------------------------------------------------------
// Classification — old type → new kind, and the demote/promote signals.
// ---------------------------------------------------------------------------

/** Old types that are behavioral guidance → `preference` (stays at boot). */
const PREFERENCE_TYPES = new Set([
  'feedback', 'directive', 'rule', 'philosophy', 'behavior', 'behavioral',
  'preference', 'correction',
]);
/** Old types that are referential / factual → `reference` (off boot by default). */
const REFERENCE_TYPES = new Set([
  'user', 'project', 'doc', 'docs', 'note', 'notes', 'fact', 'factual',
  'reference', 'memory',
]);
/** The subset of fact types that are IDENTITY-level (who the human is) — these
 *  promote back ONTO boot at `preview`. Old `metadata.type: user` is exactly
 *  the design's "who the user is" case (design §10). */
const IDENTITY_TYPES = new Set(['user']);

/** The greppable marker stamped on every migrated doc so a later refinement
 *  pass (sharpening when/why → the generated preview) is one `grep` away. */
const REFINEMENT_KEY = 'needs-refinement';

type Category =
  | 'user-memory'
  | 'project-memory'
  | 'user-skill'
  | 'project-skill'
  | 'builtin-skill'
  | 'node-local';

/** Pull the old type off a parsed frontmatter record: `metadata.type` first
 *  (the nested form), then a top-level `type` (a few docs use it). Lower-cased
 *  and trimmed; undefined when neither is present (a no-frontmatter doc). */
function extractType(fm: Record<string, unknown> | null): string | undefined {
  if (fm === null) return undefined;
  const meta = fm.metadata;
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    const t = (meta as Record<string, unknown>).type;
    if (typeof t === 'string' && t.trim() !== '') return t.trim().toLowerCase();
  }
  if (typeof fm.type === 'string' && fm.type.trim() !== '') return fm.type.trim().toLowerCase();
  return undefined;
}

/** Map an old type (+ the is-a-SKILL.md flag) to a substrate kind. Skills are
 *  always `skill`. An unknown/absent type defaults to `reference` — a fact, so
 *  it lands off boot (the safe, bloat-removing default of design §10). */
function mapKind(rawType: string | undefined, isSkill: boolean): DocKind {
  if (isSkill) return 'skill';
  if (rawType !== undefined && PREFERENCE_TYPES.has(rawType)) return 'preference';
  return 'reference';
}

function isIdentityFact(rawType: string | undefined): boolean {
  return rawType !== undefined && IDENTITY_TYPES.has(rawType);
}

// ---------------------------------------------------------------------------
// when / why best-effort lossy seed (design §10 — refinement expected).
// ---------------------------------------------------------------------------

/** Humanize a path-derived name into a topic phrase for a generated `when`. */
function humanize(name: string): string {
  const leaf = name.split('/').pop() ?? name;
  return leaf.replace(/[-_]/g, ' ').trim();
}

/** Make a `when` clause read as "When …" with a lower-cased first word. */
function mkWhen(clause: string): string {
  const c = clause.trim().replace(/[.,;:]+$/, '');
  if (c === '') return 'When this document applies';
  return 'When ' + c.charAt(0).toLowerCase() + c.slice(1);
}

/** Find the human-facing hook for a doc: the old `description` if present, else
 *  the first markdown heading, else the first real line, else the humanized
 *  name. This becomes both `short-form` and the seed for `why`. */
function deriveDescription(
  fm: Record<string, unknown> | null,
  body: string,
  name: string,
): string {
  const fromFm = scalarStr(fm?.description) ?? scalarStr(metaField(fm, 'description'));
  if (fromFm) return fromFm.trim();
  const heading = body.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/m);
  if (heading) return heading[1].trim();
  const line = body
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l !== '' && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('<!--'));
  if (line) return line;
  return humanize(name);
}

/** Seed `when` + `why` from a one-line description. If the description already
 *  reads as "When X — Y" / "Use when X — Y" it splits there; otherwise `why`
 *  carries the description verbatim and `when` is a generated placeholder built
 *  from the doc's name (the lossy half the refinement pass sharpens). */
function seedWhenWhy(desc: string, name: string): { when: string; why: string } {
  const d = desc.trim();
  const split = d.match(/^(?:use\s+)?when\b[\s:,-]*(.+?)\s*(?:—|–|--|\s-\s)\s*(.+)$/i);
  if (split && split[2].trim() !== '') {
    return { when: mkWhen(split[1]), why: split[2].trim() };
  }
  const lead = d.match(/^(?:use\s+)?when\b[\s:,-]*(.+)$/i);
  if (lead) return { when: mkWhen(lead[1]), why: d };
  return { when: `When a task relates to ${humanize(name)}`, why: d || humanize(name) };
}

function scalarStr(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function metaField(fm: Record<string, unknown> | null, key: string): unknown {
  const meta = fm?.metadata;
  if (meta !== null && typeof meta === 'object' && !Array.isArray(meta)) {
    return (meta as Record<string, unknown>)[key];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The transform — one source doc → one migrated doc (frontmatter + body).
// ---------------------------------------------------------------------------

interface Transformed {
  kind: DocKind;
  when: string;
  why: string;
  shortForm: string;
  sys: Rung;
  file: Rung;
  demoted: boolean;
  promoted: boolean;
  content: string;
}

function transform(
  fm: Record<string, unknown> | null,
  body: string,
  name: string,
  isSkill: boolean,
): Transformed {
  const rawType = isSkill ? 'skill' : extractType(fm);
  const kind = mapKind(rawType, isSkill);
  const def = KIND_DEFAULT_RUNGS[kind];
  const desc = deriveDescription(fm, body, name);
  const { when, why } = seedWhenWhy(desc, name);

  let sys: Rung = def.systemPrompt;
  let demoted = false;
  let promoted = false;
  if (kind === 'reference') {
    if (isIdentityFact(rawType)) {
      sys = 'preview'; // identity fact promoted back ONTO boot (design §10)
      promoted = true;
    } else {
      sys = 'none'; // fact demoted off boot — the M2 behavior change
      demoted = true;
    }
  }
  const file: Rung = def.fileRead;

  const content = serialize({ kind, when, why, shortForm: desc, sys, file, body });
  return { kind, when, why, shortForm: desc, sys, file, demoted, promoted, content };
}

/** Serialize a migrated doc: new substrate frontmatter (via the `yaml`
 *  serializer — the same library `parseFrontmatterGeneric` reads with, so it
 *  round-trips, and unlike `serializeFrontmatter` it is not pinned to the legacy
 *  SkillFrontmatter shape) followed by the body VERBATIM. */
function serialize(d: {
  kind: DocKind;
  when: string;
  why: string;
  shortForm: string;
  sys: Rung;
  file: Rung;
  body: string;
}): string {
  const fm: Record<string, unknown> = {
    kind: d.kind,
    when: d.when,
    why: d.why,
  };
  if (d.shortForm.trim() !== '') fm['short-form'] = d.shortForm;
  fm['system-prompt-visibility'] = d.sys;
  fm['file-read-visibility'] = d.file;
  fm[REFINEMENT_KEY] = true;

  const yamlBlock = stringifyYaml(fm); // ends with a newline
  const sep = d.body.startsWith('\n') ? '' : '\n';
  const out = `---\n${yamlBlock}---\n${sep}${d.body}`;
  return out.endsWith('\n') ? out : out + '\n';
}

// ---------------------------------------------------------------------------
// Source → target reconstruction.
// ---------------------------------------------------------------------------

function safeIsDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Reverse the project-memory key (`mangleCwd` = every `/` → `-`) back to a real
 *  on-disk directory. The mangle is lossy (a literal `-` in a path segment is
 *  indistinguishable from a separator), so we DFS the filesystem: at each step
 *  consume one-or-more `-`-joined tokens that form a directory that EXISTS,
 *  backtracking when a branch dead-ends. Returns null when no path on disk
 *  matches (the project dir was deleted) — that store is then skipped. */
function unmangleToDir(key: string): string | null {
  const parts = key.split('-');
  const startIdx = parts[0] === '' ? 1 : 0; // leading '-' from an absolute path

  const search = (idx: number, base: string): string | null => {
    if (idx >= parts.length) return safeIsDir(base) ? base : null;
    for (let end = idx; end < parts.length; end++) {
      const seg = parts.slice(idx, end + 1).join('-');
      if (seg === '') continue;
      const cand = join(base, seg);
      if (safeIsDir(cand)) {
        const r = search(end + 1, cand);
        if (r !== null) return r;
      }
    }
    return null;
  };
  return search(startIdx, sep);
}

interface PlanItem {
  category: Category;
  name: string;
  srcPath: string;
  targetPath: string;
  kind: DocKind;
  rawType: string | undefined;
  sys: Rung;
  file: Rung;
  demoted: boolean;
  promoted: boolean;
  inPlace: boolean;
  /** Target already exists → skipped in COPY mode (never clobber). */
  skipExists: boolean;
  /** node-local already normalized (has a valid kind) → skipped (idempotent). */
  skipNormalized: boolean;
  content: string;
}

interface SourceScan {
  category: Category;
  srcRoot: string;
  targetRoot: string | null;
  /** Set when a project key could not be mapped back to a real directory. */
  unresolvedKey?: string;
}

/** Enumerate `*.md` docs under a memory dir (recursive; topical subdirs ok),
 *  excluding the legacy `MEMORY.md` index. Returns [name, absPath] pairs. */
function memoryDocsIn(dir: string): Array<{ name: string; path: string }> {
  if (!pathExists(dir)) return [];
  const out: Array<{ name: string; path: string }> = [];
  for (const file of walkFiles(dir, (n) => n.endsWith('.md') && n !== 'MEMORY.md')) {
    const name = relative(dir, file).replace(/\.md$/i, '').split(sep).join('/');
    if (name !== '') out.push({ name, path: file });
  }
  return out;
}

/** Enumerate SKILL.md files under a skills base; name = path between the base
 *  and `/SKILL.md` (e.g. `crouter-development/plugins`). */
function skillDocsIn(base: string): Array<{ name: string; path: string }> {
  if (!pathExists(base)) return [];
  const out: Array<{ name: string; path: string }> = [];
  for (const file of walkFiles(base, (n) => n === 'SKILL.md')) {
    const name = relative(base, dirname(file)).split(sep).join('/');
    if (name !== '') out.push({ name, path: file });
  }
  return out;
}

function makeItem(
  category: Category,
  name: string,
  srcPath: string,
  targetPath: string,
  isSkill: boolean,
  inPlace: boolean,
): PlanItem {
  const { data, body } = parseFrontmatterGeneric(readText(srcPath));
  const t = transform(data, body, name, isSkill);
  const alreadyNormalized = inPlace && isDocKind(data?.kind);
  return {
    category,
    name,
    srcPath,
    targetPath,
    kind: t.kind,
    rawType: isSkill ? 'skill' : extractType(data),
    sys: t.sys,
    file: t.file,
    demoted: t.demoted,
    promoted: t.promoted,
    inPlace,
    skipExists: !inPlace && pathExists(targetPath),
    skipNormalized: alreadyNormalized,
    content: t.content,
  };
}

function buildPlan(): { items: PlanItem[]; sources: SourceScan[] } {
  const home = crtrHome();
  const items: PlanItem[] = [];
  const sources: SourceScan[] = [];

  // A) user-global memory  ~/.crouter/canvas/memory → ~/.crouter/memory
  {
    const srcRoot = join(home, 'memory');
    const targetRoot = scopeMemoryDir('user');
    sources.push({ category: 'user-memory', srcRoot, targetRoot });
    if (targetRoot !== null) {
      for (const d of memoryDocsIn(srcRoot)) {
        items.push(makeItem('user-memory', d.name, d.path, join(targetRoot, ...d.name.split('/')) + '.md', false, false));
      }
    }
  }

  // B) project memory (per key) ~/.crouter/canvas/projects/<key>/memory →
  //    <realDir>/.crouter/memory
  {
    const projectsRoot = join(home, 'projects');
    if (safeIsDir(projectsRoot)) {
      for (const key of readdirSync(projectsRoot)) {
        const srcRoot = join(projectsRoot, key, 'memory');
        if (!safeIsDir(srcRoot)) continue;
        const realDir = unmangleToDir(key);
        if (realDir === null) {
          sources.push({ category: 'project-memory', srcRoot, targetRoot: null, unresolvedKey: key });
          continue;
        }
        const targetRoot = join(realDir, '.crouter', 'memory');
        sources.push({ category: 'project-memory', srcRoot, targetRoot });
        for (const d of memoryDocsIn(srcRoot)) {
          items.push(makeItem('project-memory', d.name, d.path, join(targetRoot, ...d.name.split('/')) + '.md', false, false));
        }
      }
    }
  }

  // C) user scope skills  ~/.crouter/skills → ~/.crouter/memory  (kind: skill)
  {
    const base = scopeSkillsDir('user');
    const targetRoot = scopeMemoryDir('user');
    if (base !== null && targetRoot !== null) {
      sources.push({ category: 'user-skill', srcRoot: base, targetRoot });
      for (const d of skillDocsIn(base)) {
        items.push(makeItem('user-skill', d.name, d.path, join(targetRoot, ...d.name.split('/')) + '.md', true, false));
      }
    }
  }

  // D) project scope skills (cwd scope) <proj>/.crouter/skills →
  //    <proj>/.crouter/memory
  {
    const base = scopeSkillsDir('project');
    const targetRoot = scopeMemoryDir('project');
    if (base !== null && targetRoot !== null) {
      sources.push({ category: 'project-skill', srcRoot: base, targetRoot });
      for (const d of skillDocsIn(base)) {
        items.push(makeItem('project-skill', d.name, d.path, join(targetRoot, ...d.name.split('/')) + '.md', true, false));
      }
    }
  }

  // E) builtin skills  <pkg>/builtin-skills/skills → <pkg>/builtin-memory
  {
    const base = join(builtinSkillsRoot(), 'skills');
    const targetRoot = builtinMemoryRoot();
    sources.push({ category: 'builtin-skill', srcRoot: base, targetRoot });
    for (const d of skillDocsIn(base)) {
      items.push(makeItem('builtin-skill', d.name, d.path, join(targetRoot, ...d.name.split('/')) + '.md', true, false));
    }
  }

  // F) node-local memory  ~/.crouter/canvas/nodes/<id>/context/memory →
  //    NORMALIZE IN PLACE (the one transform-in-place; design §10)
  {
    const nodesRoot = join(home, 'nodes');
    if (safeIsDir(nodesRoot)) {
      sources.push({ category: 'node-local', srcRoot: nodesRoot, targetRoot: nodesRoot });
      for (const id of readdirSync(nodesRoot)) {
        const memDir = join(nodesRoot, id, 'context', 'memory');
        if (!safeIsDir(memDir)) continue;
        for (const d of memoryDocsIn(memDir)) {
          items.push(makeItem('node-local', `${id}/${d.name}`, d.path, d.path, false, true));
        }
      }
    }
  }

  return { items, sources };
}

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

interface CatStat {
  category: Category;
  found: number;
  wrote: number;
  skippedExists: number;
  skippedNormalized: number;
  byKind: Record<DocKind, number>;
  demoted: number;
  promoted: number;
}

function emptyByKind(): Record<DocKind, number> {
  return { skill: 0, reference: 0, preference: 0 };
}

function tallyCategory(items: PlanItem[], category: Category): CatStat {
  const stat: CatStat = {
    category, found: 0, wrote: 0, skippedExists: 0, skippedNormalized: 0,
    byKind: emptyByKind(), demoted: 0, promoted: 0,
  };
  for (const it of items.filter((i) => i.category === category)) {
    stat.found++;
    stat.byKind[it.kind]++;
    if (it.demoted) stat.demoted++;
    if (it.promoted) stat.promoted++;
    if (it.skipExists) stat.skippedExists++;
    else if (it.skipNormalized) stat.skippedNormalized++;
    else stat.wrote++;
  }
  return stat;
}

const CATEGORIES: Category[] = [
  'user-memory', 'project-memory', 'user-skill', 'project-skill', 'builtin-skill', 'node-local',
];

// ---------------------------------------------------------------------------
// The leaf.
// ---------------------------------------------------------------------------

export const migrateLeaf = defineLeaf({
  name: 'migrate',
  description: 'copy old memory + skills into the new substrate (one-shot)',
  whenToUse:
    'you are cutting over the legacy three-scope memory stores and the skills tree into the new document substrate. COPY mode by default — it only writes new files at the new locations and never deletes or moves a source (node-local memory is the one exception: it is normalized in place, additively). Run `--dry-run` first to see exactly what would move (counts per source, per kind, demotions, promotions) without touching disk. A one-time operation, not part of a normal workflow.',
  help: {
    name: 'memory migrate',
    summary:
      'relocate + transform legacy memory stores and skills into the substrate; COPY mode (writes new, never deletes)',
    guide:
      'Sources → targets: user-global memory (~/.crouter/canvas/memory) → ~/.crouter/memory; project memory (~/.crouter/canvas/projects/<key>/memory) → <real-project-dir>/.crouter/memory; user skills (~/.crouter/skills) → ~/.crouter/memory as kind:skill; project skills (<proj>/.crouter/skills) → <proj>/.crouter/memory as kind:skill; builtin skills (<pkg>/builtin-skills) → <pkg>/builtin-memory as kind:skill; node-local memory → normalized IN PLACE. Each doc is transformed: old metadata.type → kind, kind-default rungs applied, FACTS demoted off boot (system-prompt-visibility:none) except identity facts which promote to preview, skill descriptions split into when/why, and every migrated doc flagged needs-refinement:true. Run --dry-run first.',
    params: [
      {
        kind: 'flag',
        name: 'dry-run',
        type: 'bool',
        required: false,
        constraint:
          'Report what WOULD migrate — counts per source, per kind, demotions, promotions, and per-target skips — without writing a single file. Always safe; run this first.',
      },
    ],
    output: [
      { name: 'mode', type: 'string', required: true, constraint: 'copy or dry-run.' },
      { name: 'totals', type: 'object', required: true, constraint: 'Aggregate counts: found, wrote, skipped, demoted, promoted, and per-kind.' },
      { name: 'sources', type: 'array', required: true, constraint: 'One row per scanned source: category, source dir, target dir, and its counts.' },
      { name: 'unresolved', type: 'array', required: true, constraint: 'Project keys whose real directory could not be found on disk (those stores were skipped).' },
      { name: 'old_untouched', type: 'boolean', required: true, constraint: 'True: every copy source is left intact; node-local is the only in-place (additive) transform.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next command — verify with `crtr memory list`, or re-run without --dry-run.' },
    ],
    outputKind: 'object',
    effects: [
      'COPY mode: creates memory/<name>.md docs at the new substrate locations (user, each project, builtin). Never deletes or moves a source.',
      'Normalizes node-local memory docs IN PLACE (adds kind + rungs, preserves body) — idempotent.',
      '--dry-run: no writes of any kind.',
    ],
  },
  run: async (input) => {
    const dryRun = input.dryRun === true;
    const { items, sources } = buildPlan();

    if (!dryRun) {
      for (const it of items) {
        if (it.skipExists || it.skipNormalized) continue;
        ensureDir(dirname(it.targetPath));
        writeFileSync(it.targetPath, it.content, 'utf8');
      }
    }

    const catStats = CATEGORIES.map((c) => tallyCategory(items, c));
    const totals = {
      found: items.length,
      wrote: catStats.reduce((a, s) => a + s.wrote, 0),
      skipped: catStats.reduce((a, s) => a + s.skippedExists + s.skippedNormalized, 0),
      demoted: catStats.reduce((a, s) => a + s.demoted, 0),
      promoted: catStats.reduce((a, s) => a + s.promoted, 0),
      byKind: catStats.reduce(
        (acc, s) => {
          acc.skill += s.byKind.skill;
          acc.reference += s.byKind.reference;
          acc.preference += s.byKind.preference;
          return acc;
        },
        emptyByKind(),
      ),
    };

    const sourceRows = sources.map((s) => {
      const stat = tallyCategory(items.filter((i) => i.srcPath.startsWith(s.srcRoot)), s.category);
      return {
        category: s.category,
        source: s.srcRoot,
        target: s.targetRoot ?? '(unresolved)',
        ...(s.unresolvedKey !== undefined ? { unresolved_key: s.unresolvedKey } : {}),
        found: stat.found,
        wrote: dryRun ? 0 : stat.wrote,
        would_write: stat.wrote,
        skipped_exists: stat.skippedExists,
        skipped_normalized: stat.skippedNormalized,
        by_kind: stat.byKind,
        demoted: stat.demoted,
        promoted: stat.promoted,
      };
    });

    const unresolved = sources
      .filter((s) => s.unresolvedKey !== undefined)
      .map((s) => s.unresolvedKey as string);

    return {
      mode: dryRun ? 'dry-run' : 'copy',
      totals,
      sources: sourceRows,
      unresolved,
      old_untouched: true,
      follow_up: dryRun
        ? 'Looks right? Re-run without --dry-run to write. Then verify with `crtr memory list`.'
        : 'Migration written. Verify the new docs with `crtr memory list` and sharpen the seeded when/why on the `needs-refinement: true` docs.',
    };
  },
  render: (result) => renderMigrate(result),
});

// ---------------------------------------------------------------------------
// Bespoke render — a compact, scannable migration report.
// ---------------------------------------------------------------------------

function renderMigrate(result: Record<string, unknown>): string {
  const mode = String(result.mode);
  const totals = result.totals as {
    found: number; wrote: number; skipped: number; demoted: number; promoted: number;
    byKind: Record<string, number>;
  };
  const sources = result.sources as Array<Record<string, unknown>>;
  const unresolved = (result.unresolved as string[]) ?? [];
  const lines: string[] = [];

  const verb = mode === 'dry-run' ? 'WOULD migrate' : 'migrated';
  lines.push(`<migration mode="${mode}">`);
  lines.push(
    `Totals: ${totals.found} docs found, ${verb} ${mode === 'dry-run' ? totalWould(sources) : totals.wrote}, ` +
      `skipped ${totals.skipped} (already present / already normalized).`,
  );
  lines.push(
    `By kind: skill ${totals.byKind.skill}, reference ${totals.byKind.reference}, preference ${totals.byKind.preference}.`,
  );
  lines.push(`Facts demoted off boot: ${totals.demoted}. Identity facts promoted to boot-preview: ${totals.promoted}.`);
  lines.push(`All migrated docs flagged \`${REFINEMENT_KEY}: true\`.`);
  lines.push('');
  for (const s of sources) {
    const bk = s.by_kind as Record<string, number>;
    lines.push(`  [${s.category}] ${s.found} docs  ${s.source}`);
    lines.push(`      → ${s.target}`);
    lines.push(
      `      kinds: skill ${bk.skill}, ref ${bk.reference}, pref ${bk.preference}` +
        ` · demote ${s.demoted} · promote ${s.promoted}` +
        ` · would-write ${s.would_write} · skip(exists ${s.skipped_exists}, normalized ${s.skipped_normalized})`,
    );
  }
  if (unresolved.length > 0) {
    lines.push('');
    lines.push(`  UNRESOLVED project keys (dir gone, skipped): ${unresolved.join(', ')}`);
  }
  lines.push('');
  lines.push(`old_untouched: ${result.old_untouched} (copy sources intact; node-local normalized in place, additive)`);
  lines.push(`</migration>`);
  lines.push('');
  lines.push(String(result.follow_up));
  return lines.join('\n');
}

function totalWould(sources: Array<Record<string, unknown>>): number {
  return sources.reduce((a, s) => a + (s.would_write as number), 0);
}
