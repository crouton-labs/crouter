// Core per-cwd workspace primitives for plan/spec and related artifacts.
// No commander, no spawn, no output helpers — pure data logic only.
// Old registerArtifactCommand (commander-based) is removed; callers ported to JSON I/O.

import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { renameSync, writeFileSync, statSync } from 'node:fs';
import { CRTR_DIR_NAME } from '../types.js';
import { ensureDir, listDirs, pathExists, readText, removePath, walkFiles } from './fs-utils.js';
import { notFound, usage } from './errors.js';

export type ArtifactKind = 'plans' | 'specs';

export function mangleCwd(cwd: string = process.cwd()): string {
  return cwd.replace(/\//g, '-');
}

export function workspaceRoot(cwd?: string): string {
  return join(homedir(), CRTR_DIR_NAME, 'workspaces', mangleCwd(cwd));
}

export function artifactsRoot(kind: ArtifactKind, cwd?: string): string {
  return join(workspaceRoot(cwd), kind);
}

/** Per-cwd interactions root, mirroring artifactsRoot construction.
 *  `~/.crouter/workspaces/<mangled-cwd>/interactions/`. */
export function interactionsRoot(cwd?: string): string {
  return join(workspaceRoot(cwd), 'interactions');
}

/** Directory for one interaction. `id` is sanitized like an artifact name. */
export function interactionDir(id: string, cwd?: string): string {
  return join(interactionsRoot(cwd), sanitizeName(id));
}

export function sanitizeName(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') throw usage('name must not be empty');
  if (trimmed.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw usage(`name must not contain "." or ".." segments: ${raw}`);
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw usage(`name must not be absolute: ${raw}`);
  }
  return trimmed;
}

export function artifactPath(kind: ArtifactKind, name: string, cwd?: string): string {
  return join(artifactsRoot(kind, cwd), `${sanitizeName(name)}.md`);
}

/** Lines above this threshold trigger an oversize advisory in follow_up. */
export const OVERSIZE_WARN_LINES = 200;

export interface SaveArtifactResult {
  path: string;
  oversize: boolean;
  lineCount: number;
}

/**
 * Atomically write an artifact. Prepends a minimal frontmatter block when
 * `meta` is non-empty so readers can extract structured fields without
 * parsing the full body. Returns the written path and oversize status.
 */
export function saveArtifact(
  kind: ArtifactKind,
  name: string,
  body: string,
  meta: Record<string, string> = {},
): SaveArtifactResult {
  const filePath = artifactPath(kind, name);
  ensureDir(dirname(filePath));

  const metaKeys = Object.keys(meta);
  let content: string;
  if (metaKeys.length > 0) {
    const fm = '---\n' + metaKeys.map((k) => `${k}: ${meta[k]}`).join('\n') + '\n---\n';
    content = fm + body;
  } else {
    content = body;
  }

  const finalContent = content.endsWith('\n') ? content : content + '\n';
  writeFileSync(filePath, finalContent, 'utf8');

  const lineCount = finalContent.split('\n').length - 1;
  return { path: filePath, oversize: lineCount > OVERSIZE_WARN_LINES, lineCount };
}

const FRONTMATTER_BLOCK_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

function parseArtifactFrontmatter(source: string): { fields: Record<string, string>; body: string } {
  const match = source.match(FRONTMATTER_BLOCK_RE);
  if (!match) return { fields: {}, body: source };
  const raw = match[1];
  const body = source.slice(match[0].length);
  const fields: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const k = line.slice(0, colon).trim();
    const v = line.slice(colon + 1).trim();
    if (k !== '') fields[k] = v;
  }
  return { fields, body };
}

export interface ArtifactRecord {
  name: string;
  path: string;
  body: string;
  /** Present only in plan artifacts; null if not set. */
  spec: string | null;
}

export function readArtifact(kind: ArtifactKind, name: string): ArtifactRecord {
  const filePath = artifactPath(kind, name);
  if (!pathExists(filePath)) {
    throw notFound(`${kind.slice(0, -1)} not found: ${name} (looked at ${filePath})`);
  }
  const raw = readText(filePath);
  const { fields, body } = parseArtifactFrontmatter(raw);
  const specField = fields['spec'];
  return {
    name,
    path: filePath,
    body,
    spec: specField !== undefined ? specField : null,
  };
}

export interface ArtifactListItem {
  name: string;
  path: string;
  updated_at: string;
}

const LEGACY_WORKSPACE_DIR_RE = /^-[A-Za-z0-9].*/;

export function migrateLegacyWorkspaceDirs(): void {
  const dataHome = join(homedir(), CRTR_DIR_NAME);
  const workspaceHome = join(dataHome, 'workspaces');
  if (!pathExists(dataHome)) return;
  ensureDir(workspaceHome);
  for (const entry of listDirs(dataHome)) {
    if (entry === 'workspaces' || !LEGACY_WORKSPACE_DIR_RE.test(entry)) continue;
    const source = join(dataHome, entry);
    const target = join(workspaceHome, entry);
    if (pathExists(target)) {
      removePath(source);
      continue;
    }
    try {
      renameSync(source, target);
    } catch {
      // Leave the source in place only if the rename truly failed.
      // The next startup will retry the same hard-cut move.
    }
  }
}

export function listArtifacts(kind: ArtifactKind): ArtifactListItem[] {
  const root = artifactsRoot(kind);
  if (!pathExists(root)) return [];
  const files = walkFiles(root, (n) => n.endsWith('.md'));
  const items: ArtifactListItem[] = files.map((abs) => {
    const name = abs.substring(root.length + 1).replace(/\.md$/, '');
    let updated_at = '';
    try {
      updated_at = statSync(abs).mtime.toISOString();
    } catch {
      updated_at = new Date(0).toISOString();
    }
    return { name, path: abs, updated_at };
  });
  // Sort ascending by name (stable key for pagination cursor).
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return items;
}
