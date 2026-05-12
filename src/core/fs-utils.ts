import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  cpSync,
  readlinkSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { platform } from 'node:os';

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeJson(path: string, data: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readJsonIfExists<T = unknown>(path: string): T | null {
  if (!existsSync(path)) return null;
  return readJson<T>(path);
}

export function readTextIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

export function pathExists(path: string): boolean {
  return existsSync(path);
}

export function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true })
    .filter((d) => d.isDirectory() || d.isSymbolicLink())
    .map((d) => d.name);
}

export function listEntries(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path);
}

export function removePath(path: string): void {
  if (!existsSync(path) && !isSymlink(path)) return;
  rmSync(path, { recursive: true, force: true });
}

export function linkOrCopy(target: string, linkPath: string, opts: { noSymlink?: boolean } = {}): 'symlink' | 'copy' {
  ensureDir(dirname(linkPath));
  removePath(linkPath);
  const isWindows = platform() === 'win32';
  if (!opts.noSymlink && !isWindows) {
    const rel = relative(dirname(linkPath), target);
    try {
      symlinkSync(rel, linkPath, isDir(target) ? 'dir' : 'file');
      return 'symlink';
    } catch {
      cpSync(target, linkPath, { recursive: true });
      return 'copy';
    }
  }
  cpSync(target, linkPath, { recursive: true });
  return 'copy';
}

export function readSymlinkTarget(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

export function walkFiles(root: string, predicate: (name: string) => boolean = () => true): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && predicate(e.name)) out.push(full);
    }
  }
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}
