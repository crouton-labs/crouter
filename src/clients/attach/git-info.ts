// git-info.ts — async, non-blocking git context for the attach editor border:
// the working dir's last path segment, current branch, and a couple of status
// symbols (dirty / ahead / behind). Shells out via execFile (NEVER sync — the
// viewer must never block its input pump on a subprocess) and reports a plain
// struct the caller styles into the editor's top border.

import { execFile } from 'node:child_process';
import { basename } from 'node:path';

export interface GitInfo {
  /** Last path segment of the cwd (always present). */
  dir: string;
  /** Current branch (or short SHA when detached); undefined outside a repo. */
  branch?: string;
  /** Working tree has uncommitted changes (staged, unstaged, or untracked). */
  dirty: boolean;
  /** Commits ahead of upstream. */
  ahead: number;
  /** Commits behind upstream. */
  behind: number;
}

/** Parse `git status --porcelain=v1 --branch` into {@link GitInfo} flags. The
 *  first `## ` line carries branch + `[ahead N, behind M]`; any further line is
 *  a changed/untracked path → dirty. Exported pure for unit tests. */
export function parseGitStatus(dir: string, stdout: string): GitInfo {
  const lines = stdout.split('\n').filter((l) => l.length > 0);
  const info: GitInfo = { dir, dirty: false, ahead: 0, behind: 0 };
  for (const line of lines) {
    if (line.startsWith('## ')) {
      // `## main...origin/main [ahead 1, behind 2]`  or `## HEAD (no branch)`
      const head = line.slice(3);
      if (!head.startsWith('HEAD (no branch)')) {
        const branch = head.split(/\.\.\.| /, 1)[0];
        if (branch) info.branch = branch;
      }
      info.ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
      info.behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
    } else {
      info.dirty = true;
    }
  }
  return info;
}

/** Fetch git context for `cwd` without blocking. On any error (not a repo, git
 *  missing, timeout) the callback still fires with dir-only info so the border
 *  shows the folder name regardless. */
export function fetchGitInfo(cwd: string, cb: (info: GitInfo) => void): void {
  const dir = basename(cwd) || cwd;
  execFile(
    'git',
    ['-C', cwd, 'status', '--porcelain=v1', '--branch'],
    { timeout: 2_000, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => {
      if (err) {
        cb({ dir, dirty: false, ahead: 0, behind: 0 });
        return;
      }
      cb(parseGitStatus(dir, stdout));
    },
  );
}
