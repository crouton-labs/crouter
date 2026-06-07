// Run with: node --import tsx/esm --test src/core/__tests__/home-session.test.ts
//
// STEP 1 of the placement/focus migration: the durable REVIVE-HOME field.
// `home_session` separates a node's revive target from its live LOCATION so a
// later step can kill the focus taint. This step only ADDS + POPULATES +
// DEFAULTS the field — no behavior change. Covers:
//   - home_session round-trips through meta.json (it IS durable identity)
//   - the birth-session decision (`resolveBirthSession`) for the child /
//     inline-root / --root cases each site sets home_session from
//   - recycle + relaunch (pane-recycle) births populate home_session
//   - a legacy meta with NO home_session defaults to tmux_session ?? nodeSession()
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode, getNode, updateNode } from '../canvas/canvas.js';
import { nodeMetaPath } from '../canvas/paths.js';
import { closeDb } from '../canvas/db.js';
import { resolveBirthSession, homeSessionOf, childBackstageOf } from '../runtime/nodes.js';
import { nodeSession } from '../runtime/nodes.js';
import { relaunchRoot } from '../runtime/reset.js';
import { recycleNode } from '../runtime/recycle.js';
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
    lifecycle: 'resident',
    status: 'active',
    ...over,
  };
}

/** Make ensureDaemon (called by recycleNode) a no-op by faking a live daemon
 *  pidfile pointing at THIS test process — so no real daemon is ever spawned. */
function fakeLiveDaemon(): void {
  writeFileSync(join(home, 'crtrd.pid'), String(process.pid), 'utf8');
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-homesession-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_ROOT_SESSION'];
  delete process.env['CRTR_NODE_SESSION'];
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
  delete process.env['CRTR_ROOT_SESSION'];
  delete process.env['CRTR_NODE_SESSION'];
});

// ---------------------------------------------------------------------------
// Persistence: home_session is DURABLE IDENTITY (meta.json), round-tripped by
// createNode / getNode / updateNode — and NOT a runtime field.
// ---------------------------------------------------------------------------

test('home_session round-trips through meta.json and the hydrated view', () => {
  createNode(node('n', { home_session: 'crtr', tmux_session: 'user-sess', window: '@1' }));

  // On disk: meta.json carries home_session (identity), NOT the runtime LOCATION.
  const raw = JSON.parse(readFileSync(nodeMetaPath('n'), 'utf8')) as Record<string, unknown>;
  assert.equal(raw['home_session'], 'crtr', 'home_session persisted to meta.json (durable identity)');
  assert.ok(!('tmux_session' in raw), 'tmux_session stays a runtime field, not in meta.json');

  // Hydrated view returns it; the live LOCATION is independent.
  const m = getNode('n');
  assert.equal(m?.home_session, 'crtr', 'getNode hydrates home_session');
  assert.equal(m?.tmux_session, 'user-sess', 'home_session is distinct from the live LOCATION');
});

test('updateNode patches home_session (the demote rewriter path) and preserves it', () => {
  createNode(node('n', { home_session: 'crtr' }));
  updateNode('n', { home_session: 'recycled-sess' });
  assert.equal(getNode('n')?.home_session, 'recycled-sess', 'home_session rewritten by updateNode');

  // An unrelated identity patch leaves home_session intact (RMW round-trip).
  updateNode('n', { description: 'a-handle' });
  assert.equal(getNode('n')?.home_session, 'recycled-sess', 'home_session survives an unrelated identity edit');
});

// ---------------------------------------------------------------------------
// The legacy / back-compat DEFAULT: a meta with no home_session reads back
// tmux_session ?? nodeSession().
// ---------------------------------------------------------------------------

test('homeSessionOf: a present home_session is returned verbatim', () => {
  createNode(node('n', { home_session: 'home-sess', tmux_session: 'live-sess' }));
  assert.equal(homeSessionOf('n'), 'home-sess', 'the stored revive-home wins over the live LOCATION');
});

test('homeSessionOf: legacy meta (no home_session) defaults to tmux_session', () => {
  createNode(node('legacy', { tmux_session: 'live-sess' }));
  assert.equal(getNode('legacy')?.home_session, undefined, 'no home_session on a legacy node');
  assert.equal(homeSessionOf('legacy'), 'live-sess', 'defaults to the last live LOCATION');
});

test('homeSessionOf: legacy meta with no LOCATION either defaults to nodeSession()', () => {
  createNode(node('legacy', { tmux_session: null }));
  assert.equal(homeSessionOf('legacy'), nodeSession(), 'falls through to the shared backstage');
});

test('homeSessionOf: the backstage default honors CRTR_NODE_SESSION', () => {
  process.env['CRTR_NODE_SESSION'] = 'my-backstage';
  createNode(node('legacy'));
  assert.equal(homeSessionOf('legacy'), 'my-backstage', 'nodeSession() default is env-overridable');
});

test('homeSessionOf: unknown node falls back to the backstage', () => {
  assert.equal(homeSessionOf('ghost'), nodeSession());
});

// ---------------------------------------------------------------------------
// childBackstageOf — the session a node's CHILDREN spawn into (their
// CRTR_ROOT_SESSION). REGRESSION for the front-door-root subtree-exile bug:
// a refreshed inline root (home_session = a USER session it adopted) was
// sourcing children's CRTR_ROOT_SESSION from home_session, so every yield
// re-pointed its entire subtree into the user's working session. A root's
// children must always flow to the shared backstage `nodeSession()`, never the
// user session, while a managed child's children inherit its backstage
// home_session. (Bug: node mq2u219p spawned all 13 children into `cli`.)
// ---------------------------------------------------------------------------

test('childBackstageOf: a managed child uses its backstage home_session', () => {
  // A child's home_session is ALWAYS the backstage it was born into; its live
  // tmux_session may be a user session (focus taint) but must NOT leak to kids.
  createNode(node('child', { parent: 'p', home_session: 'crtr', tmux_session: 'user-sess' }));
  assert.equal(childBackstageOf('child'), 'crtr', 'children inherit the backstage, not the tainted LOCATION');
});

test('childBackstageOf: a front-door ROOT routes children to the backstage, NOT its adopted user session', () => {
  // The bug: an inline root adopts the user's session as home_session ('cli').
  // Sourcing children's CRTR_ROOT_SESSION from home_session exiled the whole
  // subtree into 'cli' on every refresh-yield. A root (parent === null) must
  // route children to nodeSession() instead.
  createNode(node('root', { parent: null, home_session: 'cli', tmux_session: 'cli' }));
  assert.equal(childBackstageOf('root'), nodeSession(), "a root's children flow to the backstage");
  assert.notEqual(childBackstageOf('root'), 'cli', 'NEVER the user session the root pane adopted');
});

test('childBackstageOf: a root honors CRTR_NODE_SESSION for the backstage', () => {
  process.env['CRTR_NODE_SESSION'] = 'my-backstage';
  createNode(node('root', { parent: null, home_session: 'cli' }));
  assert.equal(childBackstageOf('root'), 'my-backstage', 'the backstage default is env-overridable');
});

test('childBackstageOf: unknown node falls back to the backstage', () => {
  assert.equal(childBackstageOf('ghost'), nodeSession());
});

// ---------------------------------------------------------------------------
// The birth-session decision each site sets home_session from. Pure, so the
// child / inline-root / --root births are testable without a live tmux (the
// real spawnChild/bootRoot are tmux + pi + process.exit coupled).
// ---------------------------------------------------------------------------

test('birth: a managed child homes to the shared backstage (nodeSession), never a user session', () => {
  // No CRTR_ROOT_SESSION inherited, not adopting the caller.
  assert.equal(
    resolveBirthSession({ adoptCaller: false, here: { session: 'user-sess' }, rootSession: undefined }),
    nodeSession(),
    'a child ignores the caller session and homes to crtr',
  );
});

test('birth: a managed child inherits CRTR_ROOT_SESSION as its backstage', () => {
  assert.equal(
    resolveBirthSession({ adoptCaller: false, here: null, rootSession: 'crtr-subtree' }),
    'crtr-subtree',
    'the inherited root session is the child backstage',
  );
});

test('birth: an independent --root inside tmux homes to the caller current session', () => {
  assert.equal(
    resolveBirthSession({ adoptCaller: true, here: { session: 'user-sess' }, rootSession: 'crtr' }),
    'user-sess',
    'a --root adopts the caller session where the spawner is working',
  );
});

test('birth: a --root NOT inside tmux falls back to the backstage', () => {
  assert.equal(
    resolveBirthSession({ adoptCaller: true, here: null, rootSession: undefined }),
    nodeSession(),
    'no caller session → the backstage',
  );
});

test('birth: the inline front door (bootRoot) homes to its adopted session', () => {
  // bootRoot adopts the caller session when inside tmux, else nodeSession().
  assert.equal(
    resolveBirthSession({ adoptCaller: true, here: { session: 'term-sess' }, rootSession: undefined }),
    'term-sess',
    'inline root adopts the terminal it took over',
  );
  assert.equal(
    resolveBirthSession({ adoptCaller: true, here: null, rootSession: undefined }),
    nodeSession(),
    'inline root with no tmux homes to the backstage',
  );
});

// ---------------------------------------------------------------------------
// Pane-recycle births populate home_session. relaunchRoot (option C) is fully
// unit-testable (injected respawn, no tmux); recycleNode runs to completion with
// no tmux (respawn dispatch just fails) once the daemon spawn is neutralized.
// ---------------------------------------------------------------------------

test('relaunch birth: the fresh root homes to the recycled pane session', () => {
  createNode(node('root', { parent: null, lifecycle: 'resident', tmux_session: 'crtr', window: '@7' }));

  // No live tmux → paneLocation(pane) is null → loc falls back to the old root's
  // tmux_session ('crtr'); home_session must adopt it.
  const res = relaunchRoot('root', 'test-pane', { relaunchRootInPane: () => {} });
  assert.ok(res !== null, 'relaunchRoot minted a fresh root');
  assert.equal(getNode(res!.newNodeId)?.home_session, 'crtr', 'fresh root homes to the recycled pane session');
});

test('recycle birth: the recycled root populates home_session (backstage when no pane location)', async () => {
  createNode(node('M', { parent: null, lifecycle: 'resident', tmux_session: 'crtr', window: '@3' }));
  fakeLiveDaemon(); // createNode ensured the home dir; now neutralize ensureDaemon

  // No live tmux → paneLocation('%0') is null → home_session defaults to the
  // backstage. The respawn dispatch fails (no tmux), but the fresh root is still
  // born — and must carry a populated home_session.
  const res = await recycleNode('M', '%0');
  assert.ok(res.newRoot !== null, 'recycle minted a fresh root');
  assert.equal(getNode(res.newRoot!)?.home_session, nodeSession(), 'recycled root homes to the backstage');
});
