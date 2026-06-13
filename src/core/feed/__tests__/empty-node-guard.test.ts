// Regression: a report/skeleton write for an EMPTY node id used to resolve
// reportsDir('') → `nodes/reports` and silently mint a stray non-node sibling
// under nodes/. That stray entry broke the full-tier test harness's node-dir
// counter (`expected exactly 1 new node dir, got [<id>, reports]` — the rare
// flake on CI run 27459304455). The boundary now refuses an empty node id loudly
// instead of writing garbage. This locks that in.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { push } from '../feed.js';
import { ensureNodeDirs, nodesRoot } from '../../canvas/paths.js';

test('push() rejects an empty nodeId and creates no stray nodes/reports dir', async () => {
  const home = mkdtempSync(join(tmpdir(), 'crtr-emptyguard-'));
  const orig = process.env['CRTR_HOME'];
  process.env['CRTR_HOME'] = home;
  try {
    await assert.rejects(
      () => push('', { kind: 'update', body: 'orphan report' }),
      /empty nodeId/,
    );
    assert.equal(existsSync(join(nodesRoot(), 'reports')), false, 'no stray nodes/reports dir was created');
  } finally {
    if (orig === undefined) delete process.env['CRTR_HOME'];
    else process.env['CRTR_HOME'] = orig;
    rmSync(home, { recursive: true, force: true });
  }
});

test('ensureNodeDirs() rejects an empty nodeId and creates no stray skeleton dirs', () => {
  const home = mkdtempSync(join(tmpdir(), 'crtr-emptyguard-'));
  const orig = process.env['CRTR_HOME'];
  process.env['CRTR_HOME'] = home;
  try {
    assert.throws(() => ensureNodeDirs(''), /empty nodeId/);
    assert.equal(existsSync(join(nodesRoot(), 'reports')), false, 'no stray nodes/reports dir was created');
  } finally {
    if (orig === undefined) delete process.env['CRTR_HOME'];
    else process.env['CRTR_HOME'] = orig;
    rmSync(home, { recursive: true, force: true });
  }
});
