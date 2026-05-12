import { spawn, spawnSync } from 'node:child_process';
import { network } from './errors.js';

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export function gitSync(args: string[], cwd?: string): GitResult {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' });
  const status = typeof res.status === 'number' ? res.status : 1;
  const stdout = typeof res.stdout === 'string' ? res.stdout : '';
  const stderr = typeof res.stderr === 'string' ? res.stderr : '';
  return { status, stdout, stderr };
}

export async function gitAsync(args: string[], cwd?: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (status) => {
      const code = typeof status === 'number' ? status : 1;
      resolve({ status: code, stdout, stderr });
    });
    child.on('error', (e) => resolve({ status: 1, stdout: '', stderr: String(e) }));
  });
}

export function clone(
  url: string,
  dest: string,
  opts: { ref?: string; depth?: number } = {}
): GitResult {
  const args = ['clone'];
  if (opts.depth) args.push('--depth', String(opts.depth));
  if (opts.ref) args.push('--branch', opts.ref);
  args.push(url, dest);
  const res = gitSync(args);
  if (res.status !== 0) {
    throw network(`git clone failed: ${url}\n${res.stderr.trim()}`);
  }
  return res;
}

export function pull(cwd: string): GitResult {
  return gitSync(['pull', '--ff-only'], cwd);
}

export function fetch(cwd: string, ref?: string): GitResult {
  const args = ['fetch', 'origin'];
  if (ref) args.push(ref);
  return gitSync(args, cwd);
}

export function lsRemote(url: string): GitResult {
  return gitSync(['ls-remote', url]);
}

export function currentSha(cwd: string): string | null {
  const res = gitSync(['rev-parse', 'HEAD'], cwd);
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

export function remoteSha(cwd: string, ref: string): string | null {
  const res = gitSync(['rev-parse', `origin/${ref}`], cwd);
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

export function isGitRepo(cwd: string): boolean {
  const res = gitSync(['rev-parse', '--is-inside-work-tree'], cwd);
  return res.status === 0 && res.stdout.trim() === 'true';
}

export function deriveNameFromUrl(url: string): string {
  const trimmed = url.replace(/\.git\/?$/, '').replace(/\/$/, '');
  const last = trimmed.split('/').pop();
  if (!last) return url;
  return last;
}
