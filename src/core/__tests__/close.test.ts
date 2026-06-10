import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, subscribe } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { closeNode } from '../runtime/close.js';
import { readInboxSince } from '../feed/inbox.js';
import type { NodeMeta } from '../canvas/types.js';

let home: string;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

/** Wire `parent subscribes_to child` — the spawn-time edge (parent wakes on the
 *  child's pushes). The child is the publisher/down, the parent the manager/up. */
function spawnEdge(parent: string, child: string): void {
  subscribe(parent, child, true);
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-close-'));
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

test('closes the root and its exclusive descendants; spares a shared node', () => {
  // N ─▶ A ─▶ C        (A, C exclusive to the N subtree)
  // N ─▶ B ◀─ M        (B also subscribed to by external manager M)
  for (const id of ['N', 'A', 'B', 'C', 'M']) createNode(node(id));
  spawnEdge('N', 'A');
  spawnEdge('N', 'B');
  spawnEdge('A', 'C');
  spawnEdge('M', 'B'); // external manager keeps B alive

  const res = closeNode('N');

  assert.deepEqual([...res.closed].sort(), ['A', 'C', 'N']);
  assert.deepEqual(res.spared, ['B']);

  // Closed nodes → canceled + intent cleared. (Broker-host cut: nodes carry NO
  // engine pane/window/session — the viewer lives in the focuses table and is
  // torn down asynchronously when the broker socket drops, so close no longer
  // nulls a meta `pane`; viewer teardown is covered in the full-tier broker
  // lifecycle suite.)
  for (const id of ['N', 'A', 'C']) {
    const m = getNode(id)!;
    assert.equal(m.status, 'canceled', `${id} canceled`);
    assert.equal(m.intent, null, `${id} intent cleared`);
  }
  // Spared node and the unrelated manager are untouched.
  assert.equal(getNode('B')!.status, 'active');
  assert.equal(getNode('M')!.status, 'active');
});

test('kill order is leaves-first, root-last ("cascades up")', () => {
  for (const id of ['N', 'A', 'C']) createNode(node(id));
  spawnEdge('N', 'A');
  spawnEdge('A', 'C');

  const res = closeNode('N');
  assert.deepEqual(res.closed, ['C', 'A', 'N']);
});

test('appends a resume notice naming the dead children to each closed node', () => {
  for (const id of ['N', 'A', 'C']) createNode(node(id));
  spawnEdge('N', 'A');
  spawnEdge('A', 'C');

  closeNode('N');

  const nNotice = readInboxSince('N').at(-1)!;
  assert.equal(nNotice.from, null);
  assert.equal(nNotice.kind, 'message');
  assert.match(nNotice.label, /CLOSED by the user/);
  assert.match(nNotice.label, /A \(A\)/); // dead child named
  assert.deepEqual(nNotice.data?.['canceled_children'], ['A']);
  assert.equal(nNotice.data?.['cascade_root'], 'N');

  const aNotice = readInboxSince('A').at(-1)!;
  assert.match(aNotice.label, /CANCELED/);
  assert.match(aNotice.label, /C \(C\)/);

  // A leaf has no dead children — gets the short "session preserved" notice.
  const cNotice = readInboxSince('C').at(-1)!;
  assert.match(cNotice.label, /session is preserved/);
  assert.deepEqual(cNotice.data?.['canceled_children'], []);
});

test('diamond: a node reachable via two closing parents is closed', () => {
  // N ─▶ A ─▶ D
  // N ─▶ B ─▶ D   (D managed by A and B, both inside the closing set)
  for (const id of ['N', 'A', 'B', 'D']) createNode(node(id));
  spawnEdge('N', 'A');
  spawnEdge('N', 'B');
  spawnEdge('A', 'D');
  spawnEdge('B', 'D');

  const res = closeNode('N');
  assert.deepEqual([...res.closed].sort(), ['A', 'B', 'D', 'N']);
  assert.deepEqual(res.spared, []);
  assert.equal(getNode('D')!.status, 'canceled');
});

test('diamond with one external parent spares the shared node and its subtree', () => {
  // N ─▶ A ─▶ D ─▶ E ; D also managed by external M  ⇒ D, E spared
  for (const id of ['N', 'A', 'D', 'E', 'M']) createNode(node(id));
  spawnEdge('N', 'A');
  spawnEdge('A', 'D');
  spawnEdge('D', 'E');
  spawnEdge('M', 'D');

  const res = closeNode('N');
  assert.deepEqual([...res.closed].sort(), ['A', 'N']);
  assert.deepEqual(res.spared, ['D']);
  assert.equal(getNode('D')!.status, 'active');
  assert.equal(getNode('E')!.status, 'active'); // not descended into
});

test('closing a leaf node closes only itself', () => {
  createNode(node('solo'));
  const res = closeNode('solo');
  assert.deepEqual(res.closed, ['solo']);
  assert.deepEqual(res.spared, []);
  assert.equal(getNode('solo')!.status, 'canceled');
});

test('throws on an unknown node', () => {
  assert.throws(() => closeNode('ghost'), /unknown node/);
});

// NOTE (broker-host cut): the former "Step 7: closing a FOCUSED node closes its
// focus row + nulls its pane (tearDownNode)" test was DELETED. close.ts no longer
// routes through the synchronous tearDownNode — it sends the broker `shutdown`
// frame (headlessBrokerHost.teardown) and the viewer pane/focus row close on
// their own when the broker socket drops (GC'd by the daemon + focusOf prune).
// That async viewer teardown is covered by the full-tier broker-crash-teardown /
// broker-lifecycle suite, which runs a real broker; it cannot be unit-tested
// without one.
