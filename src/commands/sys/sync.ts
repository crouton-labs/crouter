// `crtr sys sync` — explicit migration from legacy host Agent Skill bundles into
// crouter memory documents. It is NOT a bidirectional SKILL.md sync surface: the
// crouter side after a sync is a plain memory/<name>.md document.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import { parseFrontmatterGeneric, type ParsedFrontmatterGeneric } from '../../core/frontmatter.js';
import { pathExists, readJsonIfExists, readText, walkFiles, writeJson, writeText } from '../../core/fs-utils.js';
import { findProjectScopeRoot, scopeMemoryDir } from '../../core/scope.js';
import { memoryFilePath, resolveWriteTarget, serializeMemoryDoc } from '../memory/shared.js';

const LEGACY_BOOT_SKILL_MARKER_PREFIX = '<!-- crtr-boot-skill v';
const HOST_SKILL_FILE = 'SKILL.md';
const IGNORE_FILE = 'skill-import-ignore.json';

type TargetScope = 'user' | 'project';
type ImportStatus = 'imported' | 'skipped' | 'would-import' | 'ignored' | 'would-ignore';

interface SkillSourceRoot {
  label: string;
  root: string;
  defaultScope: TargetScope;
}

interface SkillCandidate {
  path: string;
  root: string;
  source: string;
  defaultScope: TargetScope;
}

interface PreparedCandidate {
  candidate: SkillCandidate;
  raw: string;
  parsed: ParsedFrontmatterGeneric;
  sourceFm: Record<string, unknown>;
  kind: 'knowledge' | 'preference';
  name: string;
  scope: TargetScope;
  target: string;
}

interface ImportResult {
  source: string;
  target: string;
  name: string;
  scope: TargetScope;
  status: ImportStatus;
  reason?: string;
}

interface IgnoreEntry {
  source: string;
  name: string;
  scope: TargetScope;
  ignoredAt: string;
}

interface IgnoreState {
  version: 1;
  ignored: IgnoreEntry[];
}

function projectDir(): string | null {
  const root = findProjectScopeRoot();
  return root ? dirname(root) : null;
}

function ignoreFilePath(): string {
  return join(homedir(), '.crouter', IGNORE_FILE);
}

function defaultSourceRoots(): SkillSourceRoot[] {
  const roots: SkillSourceRoot[] = [
    { label: 'claude-user', root: join(homedir(), '.claude', 'skills'), defaultScope: 'user' },
    { label: 'pi-user', root: join(homedir(), '.pi', 'agent', 'skills'), defaultScope: 'user' },
  ];
  const proj = projectDir();
  if (proj) {
    roots.push({ label: 'claude-project', root: join(proj, '.claude', 'skills'), defaultScope: 'project' });
    roots.push({ label: 'pi-project', root: join(proj, '.pi', 'agent', 'skills'), defaultScope: 'project' });
  }
  return roots;
}

function sourceRootsFromArg(sourceArg: string | undefined, scopeArg: string | undefined): SkillSourceRoot[] {
  if (sourceArg === undefined) return defaultSourceRoots();
  const root = resolve(sourceArg);
  if (scopeArg !== undefined && scopeArg !== 'user' && scopeArg !== 'project') {
    resolveWriteTarget(scopeArg);
  }
  return [{ label: 'source', root, defaultScope: (scopeArg as TargetScope | undefined) ?? 'user' }];
}

function collectCandidates(rootDef: SkillSourceRoot): SkillCandidate[] {
  const root = rootDef.root;
  if (!existsSync(root)) return [];
  const statRoot = resolve(root);
  const candidates: SkillCandidate[] = [];

  if (basename(statRoot) === HOST_SKILL_FILE) {
    candidates.push({ path: statRoot, root: dirname(statRoot), source: rootDef.label, defaultScope: rootDef.defaultScope });
    return candidates;
  }

  const directSkill = join(statRoot, HOST_SKILL_FILE);
  if (existsSync(directSkill)) {
    candidates.push({ path: directSkill, root: dirname(statRoot), source: rootDef.label, defaultScope: rootDef.defaultScope });
    return candidates;
  }

  for (const file of walkFiles(statRoot, (name) => name === HOST_SKILL_FILE)) {
    candidates.push({ path: file, root: statRoot, source: rootDef.label, defaultScope: rootDef.defaultScope });
  }
  return candidates;
}

function scalarString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function cleanClause(s: string): string {
  let out = s.replace(/\s+/g, ' ').trim();
  out = out.replace(/^[,;:.\s]+/, '').replace(/[,;:.\s]+$/, '');
  if (/^[A-Z][a-z]/.test(out)) out = out.charAt(0).toLowerCase() + out.slice(1);
  return out;
}

const USE_WHEN_RE =
  /\b(?:use\s+this\s+skill\s+when|use\s+this\s+when|this\s+skill\s+should\s+be\s+used\s+when|used\s+when|use\s+when)\b\s*/i;

function routeFromDescription(description: string, kind: string): string {
  const desc = description.replace(/\s+/g, ' ').trim();
  if (desc === '') return `When this migrated ${kind} applies, this ${kind} should be read.`;
  const m = desc.match(USE_WHEN_RE);
  if (m && m.index !== undefined) {
    const gist = cleanClause(desc.slice(0, m.index));
    const situation = cleanClause(desc.slice(m.index + m[0].length));
    if (situation !== '') {
      let out = `When ${situation}, this ${kind} should be read`;
      if (gist !== '') out += ` because ${gist}`;
      return `${out}.`;
    }
  }
  return `When ${cleanClause(desc)}, this ${kind} should be read.`;
}

function normalizedName(raw: string): string {
  const segments = raw
    .replace(/\\/g, '/')
    .replace(/\.md$/i, '')
    .split('/')
    .map((s) => s.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''))
    .filter(Boolean);
  return segments.join('/');
}

function nameForCandidate(candidate: SkillCandidate, fm: Record<string, unknown> | null): string {
  const fmName = scalarString(fm?.name);
  if (fmName && fmName.trim() !== '') return normalizedName(fmName);
  const relDir = relative(candidate.root, dirname(candidate.path)).split(sep).join('/');
  return normalizedName(relDir || basename(dirname(candidate.path)));
}

function targetMemoryDir(scope: TargetScope): string {
  const dir = scopeMemoryDir(scope);
  if (!dir) return resolveWriteTarget(scope).memoryDir;
  return dir;
}

function readIgnoreState(): IgnoreState {
  let doc: unknown;
  try {
    doc = readJsonIfExists(ignoreFilePath());
  } catch (e) {
    throw usage(`invalid JSON in ${ignoreFilePath()}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (doc === null) return { version: 1, ignored: [] };
  if (
    typeof doc !== 'object' ||
    doc === null ||
    (doc as { version?: unknown }).version !== 1 ||
    !Array.isArray((doc as { ignored?: unknown }).ignored)
  ) {
    throw usage(`malformed ${ignoreFilePath()}: expected {"version":1,"ignored":[...]}`);
  }
  const ignored: IgnoreEntry[] = [];
  for (const entry of (doc as { ignored: unknown[] }).ignored) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (
      typeof e.source === 'string' &&
      typeof e.name === 'string' &&
      (e.scope === 'user' || e.scope === 'project') &&
      typeof e.ignoredAt === 'string'
    ) {
      ignored.push({ source: resolve(e.source), name: e.name, scope: e.scope, ignoredAt: e.ignoredAt });
    }
  }
  return { version: 1, ignored };
}

function writeIgnoreState(state: IgnoreState): void {
  writeJson(ignoreFilePath(), state);
}

function isIgnored(prepared: PreparedCandidate, state: IgnoreState): boolean {
  const source = resolve(prepared.candidate.path);
  return state.ignored.some((entry) =>
    entry.source === source ||
    (entry.scope === prepared.scope && entry.name === prepared.name),
  );
}

function rememberIgnored(prepared: PreparedCandidate, state: IgnoreState): boolean {
  if (isIgnored(prepared, state)) return false;
  state.ignored.push({
    source: resolve(prepared.candidate.path),
    name: prepared.name,
    scope: prepared.scope,
    ignoredAt: new Date().toISOString(),
  });
  state.ignored.sort((a, b) => `${a.scope}/${a.name}`.localeCompare(`${b.scope}/${b.name}`));
  return true;
}

function skipResult(candidate: SkillCandidate, scope: TargetScope, reason: string): ImportResult {
  return { source: candidate.path, target: '', name: '', scope, status: 'skipped', reason };
}

function prepareCandidate(candidate: SkillCandidate, scopeOverride?: TargetScope): PreparedCandidate | ImportResult {
  const raw = readText(candidate.path);
  const scope = scopeOverride ?? candidate.defaultScope;
  if (raw.includes(LEGACY_BOOT_SKILL_MARKER_PREFIX)) {
    return skipResult(candidate, scope, 'legacy generated crtr boot skill is pruned by host exports, not imported');
  }

  const parsed = parseFrontmatterGeneric(raw);
  const sourceFm = parsed.data ?? {};
  const kind = sourceFm.kind === 'preference' ? 'preference' : 'knowledge';
  const name = nameForCandidate(candidate, sourceFm);
  if (name === '') return skipResult(candidate, scope, 'could not derive memory document name');

  const memoryDir = targetMemoryDir(scope);
  const target = memoryFilePath(memoryDir, name);
  return { candidate, raw, parsed, sourceFm, kind, name, scope, target };
}

function convertPrepared(prepared: PreparedCandidate, opts: { dryRun: boolean; overwrite: boolean }): ImportResult {
  if (pathExists(prepared.target) && !opts.overwrite) {
    return {
      source: prepared.candidate.path,
      target: prepared.target,
      name: prepared.name,
      scope: prepared.scope,
      status: 'skipped',
      reason: 'target memory doc already exists; re-run with --overwrite to replace it',
    };
  }

  const description = scalarString(prepared.sourceFm.description) ?? '';
  const frontmatter: Record<string, unknown> = { ...prepared.sourceFm };
  delete frontmatter.name;
  delete frontmatter.description;
  delete frontmatter.type;
  delete frontmatter.keywords;
  frontmatter.kind = prepared.kind;
  if (typeof frontmatter['when-and-why-to-read'] !== 'string' || frontmatter['when-and-why-to-read'].trim() === '') {
    frontmatter['when-and-why-to-read'] = routeFromDescription(description, prepared.kind);
  }
  if (typeof frontmatter['short-form'] !== 'string' || frontmatter['short-form'].trim() === '') {
    frontmatter['short-form'] = description.replace(/\s+/g, ' ').trim();
  }
  if (typeof frontmatter['system-prompt-visibility'] !== 'string') frontmatter['system-prompt-visibility'] = 'preview';
  if (typeof frontmatter['file-read-visibility'] !== 'string') frontmatter['file-read-visibility'] = 'none';

  if (!opts.dryRun) writeText(prepared.target, serializeMemoryDoc(frontmatter, prepared.parsed.body));
  return {
    source: prepared.candidate.path,
    target: prepared.target,
    name: prepared.name,
    scope: prepared.scope,
    status: opts.dryRun ? 'would-import' : 'imported',
  };
}

function ignoreResult(prepared: PreparedCandidate, reason: string, dryRun: boolean): ImportResult {
  return {
    source: prepared.candidate.path,
    target: prepared.target,
    name: prepared.name,
    scope: prepared.scope,
    status: dryRun ? 'would-ignore' : 'ignored',
    reason,
  };
}

function renderSummary(results: ImportResult[], ignoreMode: boolean): string {
  const imported = results.filter((r) => r.status === 'imported').length;
  const wouldImport = results.filter((r) => r.status === 'would-import').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const ignored = results.filter((r) => r.status === 'ignored').length;
  const wouldIgnore = results.filter((r) => r.status === 'would-ignore').length;
  let header: string;
  if (ignoreMode) header = `crtr sys sync — ${wouldIgnore > 0 ? `${wouldIgnore} would ignore` : `${ignored} ignored`}, ${skipped} skipped`;
  else if (wouldImport > 0) header = `crtr sys sync — dry run: ${wouldImport} would import, ${skipped} skipped, ${ignored} ignored`;
  else header = `crtr sys sync — ${imported} imported, ${skipped} skipped, ${ignored} ignored`;
  const rows = results.map((r) => {
    const target = r.target || '—';
    const reason = r.reason ? ` (${r.reason})` : '';
    return `| ${r.status} | ${r.scope}/${r.name || '—'} | ${target} | ${r.source}${reason} |`;
  });
  const body = rows.length === 0
    ? ['No sync candidates.']
    : ['| status | memory doc | target | source |', '| --- | --- | --- | --- |', ...rows];
  return [header, '', ...body].join('\n');
}

export const sysSyncLeaf = defineLeaf({
  name: 'sync',
  description: 'convert legacy SKILL.md bundles into crouter memory docs',
  whenToUse:
    'migrating host-native Agent Skill bundles into the crouter memory-doc model. This is a one-way import from SKILL.md to memory/<name>.md; it never exports memory docs back to SKILL.md and never treats SKILL.md as an active crouter guidance surface.',
  help: {
    name: 'sys sync',
    summary: 'one-way import: SKILL.md bundles → crouter memory docs',
    params: [
      { kind: 'flag', name: 'source', type: 'string', required: false, constraint: 'A SKILL.md file, a single skill bundle dir containing SKILL.md, or a skills root to scan recursively. Default: user/project Claude and pi skill roots that exist.' },
      { kind: 'flag', name: 'scope', type: 'enum', choices: ['user', 'project'], required: false, constraint: 'Target memory scope. Default: user for user host roots and project for project host roots; explicit value applies to every imported source.' },
      { kind: 'flag', name: 'dry-run', type: 'bool', required: false, constraint: 'Show what would be imported without writing memory docs.' },
      { kind: 'flag', name: 'overwrite', type: 'bool', required: false, constraint: 'Replace an existing target memory doc. Default: skip existing docs to avoid clobbering user-authored memory.' },
      { kind: 'flag', name: 'ignore', type: 'bool', required: false, constraint: `Permanently ignore every selected source by recording it in ~/.crouter/${IGNORE_FILE}. Honors --source/--scope; with no --source, ignores every currently discovered default host skill candidate.` },
      { kind: 'flag', name: 'include-ignored', type: 'bool', required: false, constraint: 'Include ignored candidates in the report without making sync read-only. Pair with --dry-run to audit the full candidate set without importing non-ignored skills.' },
    ],
    output: [
      { name: 'imported', type: 'number', required: true, constraint: 'Count of memory docs written.' },
      { name: 'skipped', type: 'number', required: true, constraint: 'Count of SKILL.md files skipped.' },
      { name: 'ignored', type: 'number', required: true, constraint: 'Count of selected SKILL.md files that are permanently ignored.' },
      { name: 'wouldIgnore', type: 'number', required: true, constraint: 'Count of selected SKILL.md files that would be ignored under --dry-run.' },
      { name: 'results', type: 'object[]', required: true, constraint: 'Each: {source,target,name,scope,status,reason?}; status may be imported, skipped, would-import, ignored, or would-ignore.' },
    ],
    outputKind: 'object',
    effects: [
      'Writes memory/<name>.md in the selected crouter scope with substrate frontmatter and the SKILL.md body.',
      'Skips existing memory docs unless --overwrite is present.',
      'Skips marker-bearing generated crtr boot skills; host exports prune those legacy artifacts instead.',
      `With --ignore: writes ~/.crouter/${IGNORE_FILE} and does not import the selected sources.`,
      'With --dry-run: read-only; writes nothing.',
    ],
  },
  run: async (input) => {
    const sourceArg = input['source'] as string | undefined;
    const scopeArg = input['scope'] as TargetScope | undefined;
    const dryRun = (input['dryRun'] as boolean) ?? false;
    const overwrite = (input['overwrite'] as boolean) ?? false;
    const ignoreMode = (input['ignore'] as boolean) ?? false;
    const includeIgnored = (input['includeIgnored'] as boolean) ?? false;

    const roots = sourceRootsFromArg(sourceArg, scopeArg);
    const seen = new Set<string>();
    const candidates: SkillCandidate[] = [];
    for (const root of roots) {
      for (const c of collectCandidates(root)) {
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        candidates.push(c);
      }
    }

    const ignoreState = readIgnoreState();
    const results: ImportResult[] = [];
    let changedIgnoreState = false;
    for (const candidate of candidates) {
      const prepared = prepareCandidate(candidate, scopeArg);
      if ('status' in prepared) {
        results.push(prepared);
        continue;
      }
      if (ignoreMode) {
        if (!dryRun) changedIgnoreState = rememberIgnored(prepared, ignoreState) || changedIgnoreState;
        results.push(ignoreResult(prepared, dryRun ? 'would record permanent ignore' : `recorded in ~/.crouter/${IGNORE_FILE}`, dryRun));
        continue;
      }
      if (isIgnored(prepared, ignoreState)) {
        if (includeIgnored) results.push(ignoreResult(prepared, `matched ~/.crouter/${IGNORE_FILE}`, false));
        continue;
      }
      results.push(convertPrepared(prepared, { dryRun, overwrite }));
    }
    if (changedIgnoreState) writeIgnoreState(ignoreState);

    const imported = results.filter((r) => r.status === 'imported').length;
    const wouldImport = results.filter((r) => r.status === 'would-import').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;
    const ignored = results.filter((r) => r.status === 'ignored').length;
    const wouldIgnore = results.filter((r) => r.status === 'would-ignore').length;

    return { imported, wouldImport, skipped, ignored, wouldIgnore, results, ignoreFile: ignoreFilePath(), ignoreMode };
  },
  render: (result) => renderSummary(result.results as ImportResult[], result.ignoreMode === true),
});
