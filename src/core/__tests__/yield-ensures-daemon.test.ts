// Run with: node --import tsx/esm --test src/core/__tests__/yield-ensures-daemon.test.ts
//
// Regression: `crtr node yield` timed out into "broker gone" instead of reviving
// in the same pane (observed 2026-06-18). The yield arms intent='refresh' and
// the broker shuts down expecting the DAEMON to relaunch it — but requestYield
// never ensured the daemon was running, unlike the spawn/recycle paths. With a
// dead daemon, the broker exited and nothing revived it; the viewer redialed its
// view.sock for ~30s and reported "broker gone". This locks in that requestYield
// ensures the supervisor before arming the refresh.
import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { requestYield } from '../runtime/promote.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

function mkOrchestrator(id: string): void {
  const meta: NodeMeta = {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'orchestrator', // already an orchestrator → yield skips the promote path
    lifecycle: 'terminal',
    status: 'active', // LIVE, so transition('yield') is legal
  };
  createNode(meta);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-yield-ensure-'));
  process.env['CRTR_HOME'] = home;
});
beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

test('requestYield ensures the daemon before arming intent=refresh', () => {
  mkOrchestrator('n1');

  let ensured = 0;
  const res = requestYield('n1', {}, { ensure: () => { ensured += 1; } });

  // The supervisor that performs the refresh-revive must have been ensured...
  assert.equal(ensured, 1, 'requestYield must ensure the daemon is running');
  // ...and the yield must still arm the refresh.
  assert.equal(res.willRefresh, true);
  assert.equal(getNode('n1')?.intent, 'refresh');
});
