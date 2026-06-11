// Unit coverage for the pure git-status parser that feeds the attach editor's
// border (cwd · branch · status symbols). The shell-out is non-blocking and
// untestable in a unit, but the porcelain-v1 --branch parse is pure and the
// part that can silently mis-read state, so it is locked in here.
// See src/clients/attach/git-info.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGitStatus } from '../git-info.js';

test('clean tree on a tracked branch', () => {
  const info = parseGitStatus('repo', '## main...origin/main\n');
  assert.deepEqual(info, { dir: 'repo', branch: 'main', dirty: false, ahead: 0, behind: 0 });
});

test('dirty tree with ahead/behind counts', () => {
  const info = parseGitStatus(
    'repo',
    '## feature...origin/feature [ahead 2, behind 3]\n M src/a.ts\n?? new.ts\n',
  );
  assert.equal(info.branch, 'feature');
  assert.equal(info.dirty, true);
  assert.equal(info.ahead, 2);
  assert.equal(info.behind, 3);
});

test('untracked-only branch (no upstream) is still dirty, no counts', () => {
  const info = parseGitStatus('repo', '## main\n?? scratch.md\n');
  assert.equal(info.branch, 'main');
  assert.equal(info.dirty, true);
  assert.equal(info.ahead, 0);
  assert.equal(info.behind, 0);
});

test('detached HEAD reports no branch', () => {
  const info = parseGitStatus('repo', '## HEAD (no branch)\n');
  assert.equal(info.branch, undefined);
  assert.equal(info.dirty, false);
});
