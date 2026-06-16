// `crtr sys sync` — explicit migration from legacy host Agent Skill bundles into
// crouter memory documents. It is NOT a bidirectional SKILL.md sync surface: the
// crouter side after a sync is a plain memory/<name>.md document.

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { parseFrontmatterGeneric } from '../../core/frontmatter.js';
import { pathExists, readText, writeText, walkFiles } from '../../core/fs-utils.js';
import { findProjectScopeRoot, scopeMemoryDir } from '../../core/scope.js';
import type { Scope } from '../../types.js';
import { memoryFilePath, resolveWriteTarget, serializeMemoryDoc } from '../memory/shared.js';

const LEGACY_BOOT_SKILL_MARKER_PREFIX = '<!-- crtr-boot-skill v';
const HOST_SKILL_FILE = 'SKILL.md';

type TargetScope = 'user' | 'project';

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

interface ImportResult {
  source: string;
  target: string;
  name: string;
  scope: TargetScope;
  status: 'imported' | 'skipped' | 'would-import';
  reason?: string;
}

function projectDir(): string | null {
  const root = findProjectScopeRoot();
  return root ? dirname(root) : null;
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

function convertCandidate(candidate: SkillCandidate, opts: { scope?: TargetScope; dryRun: boolean; overwrite: boolean }): ImportResult {
  const raw = readText(candidate.path);
  if (raw.includes(LEGACY_BOOT_SKILL_MARKER_PREFIX)) {
    return {
      source: candidate.path,
      target: '',
      name: '',
      scope: opts.scope ?? candidate.defaultScope,
      status: 'skipped',
      reason: 'legacy generated crtr boot skill is pruned by host exports, not imported',
    };
  }

  const parsed = parseFrontmatterGeneric(raw);
  const sourceFm = parsed.data ?? {};
  const kind = sourceFm.kind === 'preference' ? 'preference' : 'knowledge';
  const name = nameForCandidate(candidate, sourceFm);
  const scope = opts.scope ?? candidate.defaultScope;
  if (name === '') {
    return { source: candidate.path, target: '', name, scope, status: 'skipped', reason: 'could not derive memory document name' };
  }

  const memoryDir = targetMemoryDir(scope);
  const target = memoryFilePath(memoryDir, name);
  if (pathExists(target) && !opts.overwrite) {
    return { source: candidate.path, target, name, scope, status: 'skipped', reason: 'target memory doc already exists; re-run with --overwrite to replace it' };
  }

  const description = scalarString(sourceFm.description) ?? '';
  const frontmatter: Record<string, unknown> = { ...sourceFm };
  delete frontmatter.name;
  delete frontmatter.description;
  delete frontmatter.type;
  delete frontmatter.keywords;
  frontmatter.kind = kind;
  if (typeof frontmatter['when-and-why-to-read'] !== 'string' || frontmatter['when-and-why-to-read'].trim() === '') {
    frontmatter['when-and-why-to-read'] = routeFromDescription(description, kind);
  }
  if (typeof frontmatter['short-form'] !== 'string' || frontmatter['short-form'].trim() === '') {
    frontmatter['short-form'] = description.replace(/\s+/g, ' ').trim();
  }
  if (typeof frontmatter['system-prompt-visibility'] !== 'string') frontmatter['system-prompt-visibility'] = 'preview';
  if (typeof frontmatter['file-read-visibility'] !== 'string') frontmatter['file-read-visibility'] = 'none';

  if (!opts.dryRun) writeText(target, serializeMemoryDoc(frontmatter, parsed.body));
  return { source: candidate.path, target, name, scope, status: opts.dryRun ? 'would-import' : 'imported' };
}

function renderSummary(results: ImportResult[]): string {
  const imported = results.filter((r) => r.status === 'imported').length;
  const wouldImport = results.filter((r) => r.status === 'would-import').length;
  const skipped = results.filter((r) => r.status === 'skipped').length;
  const header = wouldImport > 0
    ? `crtr sys sync — dry run: ${wouldImport} would import, ${skipped} skipped`
    : `crtr sys sync — ${imported} imported, ${skipped} skipped`;
  const rows = results.map((r) => {
    const target = r.target || '—';
    const reason = r.reason ? ` (${r.reason})` : '';
    return `| ${r.status} | ${r.scope}/${r.name || '—'} | ${target} | ${r.source}${reason} |`;
  });
  return [header, '', '| status | memory doc | target | source |', '| --- | --- | --- | --- |', ...rows].join('\n');
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
    ],
    output: [
      { name: 'imported', type: 'number', required: true, constraint: 'Count of memory docs written.' },
      { name: 'skipped', type: 'number', required: true, constraint: 'Count of SKILL.md files skipped.' },
      { name: 'results', type: 'object[]', required: true, constraint: 'Each: {source,target,name,scope,status,reason?}.' },
    ],
    outputKind: 'object',
    effects: [
      'Writes memory/<name>.md in the selected crouter scope with substrate frontmatter and the SKILL.md body.',
      'Skips existing memory docs unless --overwrite is present.',
      'Skips marker-bearing generated crtr boot skills; host exports prune those legacy artifacts instead.',
      'With --dry-run: read-only; writes nothing.',
    ],
  },
  run: async (input) => {
    const sourceArg = input['source'] as string | undefined;
    const scopeArg = input['scope'] as TargetScope | undefined;
    const dryRun = (input['dryRun'] as boolean) ?? false;
    const overwrite = (input['overwrite'] as boolean) ?? false;

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

    const results = candidates.map((candidate) => convertCandidate(candidate, { scope: scopeArg, dryRun, overwrite }));
    const imported = results.filter((r) => r.status === 'imported').length;
    const wouldImport = results.filter((r) => r.status === 'would-import').length;
    const skipped = results.filter((r) => r.status === 'skipped').length;

    return { imported, wouldImport, skipped, results };
  },
  render: (result) => renderSummary(result.results as ImportResult[]),
});
