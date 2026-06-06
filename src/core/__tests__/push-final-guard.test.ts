// Run with: node --import tsx/esm --test src/core/__tests__/push-final-guard.test.ts
//
// N1 — a 2nd `crtr push final` in one turn is an illegal finalize-from-done that
// transition() throws on. The push leaf must surface that as a CLEAN user-facing
// InputError ('already_finalized'), NOT let the raw Error fall through to the
// `internal` "crtr bug" path. Verifies the guard fires before push() runs.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, setStatus } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import type { NodeMeta } from '../canvas/types.js';
import { registerPush } from '../../commands/push.js';
import { InputError } from '../io.js';
import type { LeafDef } from '../command.js';

let home: string;
const prevNodeId = process.env['CRTR_NODE_ID'];

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

/** The `final` tier leaf, fished out of the push branch. */
function finalLeaf(): LeafDef {
  const leaf = registerPush().children.find((c) => c.name === 'final');
  assert.ok(leaf !== undefined && leaf.kind === 'leaf', 'push final leaf exists');
  return leaf as LeafDef;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-pushfinal-'));
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
  if (prevNodeId === undefined) delete process.env['CRTR_NODE_ID'];
  else process.env['CRTR_NODE_ID'] = prevNodeId;
});

test('push final on an already-done node throws a clean InputError, not a raw transition error', async () => {
  const id = 'doneNode';
  createNode(node(id));
  setStatus(id, 'done'); // simulate the first push final already finalized it
  process.env['CRTR_NODE_ID'] = id;

  await assert.rejects(
    () => finalLeaf().run({ body: 'second final result' }),
    (e: unknown) => {
      assert.ok(e instanceof InputError, 'a clean command-level error (renders on stdout)');
      assert.equal(e.payload.error, 'already_finalized');
      assert.match(e.payload.message, /already done/);
      return true;
    },
  );
});

test('push final on a dead node is also caught cleanly', async () => {
  const id = 'deadNode';
  createNode(node(id));
  setStatus(id, 'dead');
  process.env['CRTR_NODE_ID'] = id;

  await assert.rejects(
    () => finalLeaf().run({ body: 'x' }),
    (e: unknown) => e instanceof InputError && e.payload.error === 'already_finalized',
  );
});
