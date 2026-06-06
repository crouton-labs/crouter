// Run with: node --import tsx/esm --test src/core/__tests__/human-cancel-guard.test.ts
//
// N2 — humanCancel on an already-canceled (but unresolved) interaction node must
// short-circuit to {canceled:false, reason:'already_resolved'} instead of falling
// through to transition('finalize'), which is illegal from status='canceled' and
// would throw. Guards the one-line hardening in queue.ts's status guard.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, setStatus } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import type { NodeMeta } from '../canvas/types.js';
import { humanCancel } from '../../commands/human/queue.js';

let home: string;

function node(id: string): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
  };
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-humancancel-'));
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

test('cancel on an already-canceled node is a no-op, never throws on the finalize', async () => {
  const id = 'canceledJob';
  createNode(node(id));
  setStatus(id, 'canceled'); // canceled but no response.json written yet

  const res = (await humanCancel.run({ job_id: id })) as Record<string, unknown>;
  assert.equal(res['canceled'], false);
  assert.equal(res['reason'], 'already_resolved');
  assert.equal(res['job_id'], id);
});
