// Run with: node --import tsx/esm --test src/core/__tests__/full/broker-navigate-tree-rewelcome.test.ts
//
// FULL TIER (real-boot-bound): tmux-free, but it boots a REAL broker process,
// so it lives in full/ (CI), not the fast local loop.
//
// BUG-REGRESSION (real, observed 2026-06-11 in `crtr attach`): double-Esc (or
// /tree) opened the session-tree picker, but SELECTING an entry visibly did
// nothing — the viewer stayed on the old transcript instead of traveling back
// to the chosen point in time.
//
// 3-PART HEADER:
//  (1) BUG IT LOCKS — the broker's `navigate_tree` handler called
//      session.navigateTree() (which rewinds IN-PLACE: same session file, new
//      leaf, NO relayed AgentSessionEvent) and then only acked. Unlike the
//      session-replacing ops (new_session/switch_session/fork → runReplacement
//      → reWelcomeAll), it never re-snapshotted the viewers, so every attached
//      client kept rendering the abandoned branch. The navigated-to user
//      message's `editorText` (pi parity: the tree navigator restores it to the
//      editor) was dropped on the floor too.
//  (2) WHY BROKER/SOCKET-LEVEL, NOT PANE — the regression is pure frame-plumbing
//      on view.sock: a controller `navigate_tree` in, a re-`welcome` fan-out +
//      ack.detail out. No tmux pane or TUI is involved, so the lock holds
//      headlessly (createHeadlessHarness + the fake engine, whose navigateTree
//      pops the last accrued turn and returns `rewound-to:<targetId>`).
//  (3) HOW IT FAILS ON REGRESSION — pre-fix, NO second welcome ever arrives
//      (the re-welcome waits time out) and the navigate_tree ack carries no
//      detail; the rewound-history assert (the turn token gone from the new
//      snapshot) also goes red if the re-welcome serves a stale snapshot.

import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createHeadlessHarness, type Harness } from '../helpers/harness.js';
import { createAttachKit, frameHas, tok } from '../helpers/broker-clients.js';
import type { WelcomeFrame } from '../../runtime/broker-protocol.js';

let h: Harness;
let id: string;

const kit = createAttachKit(() => h);
const { attachUntil } = kit;

before(async () => {
  h = await createHeadlessHarness({ sessionPrefix: 'crtr-brknav' });
  const root = h.spawnRoot('navigate-tree-rewelcome suite root');
  id = await h.spawnHeadlessChild(root, 'headless worker — navigate-tree rewelcome gate');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

afterEach(() => {
  kit.closeAll();
});

const welcomes = (frames: unknown[]): WelcomeFrame[] =>
  frames.filter((f): f is WelcomeFrame => (f as { type: string }).type === 'welcome');

test('navigate_tree re-welcomes every viewer onto the rewound transcript and acks the editor text', async () => {
  const c = await attachUntil(
    id,
    'controller',
    'nav-ctrl',
    (a) => a.welcome.role === 'controller',
    'nav-ctrl admitted controller',
  );

  // Accrue one observable turn so the rewind has something to drop.
  const token = tok('NAV-TURN');
  c.send({ type: 'prompt', text: token });
  await c.waitFrame((f) => f.type === 'agent_end' && frameHas(f, token), 'turn relayed before navigate');

  // The observer attaches AFTER the turn so its first welcome deterministically
  // holds the token (the pre-navigate baseline) — same accrual trick as G3.
  const o = await attachUntil(
    id,
    'observer',
    'nav-obs',
    (a) => frameHas(a.welcome, token),
    'observer welcome holds the pre-navigate turn',
  );

  c.send({ type: 'navigate_tree', targetId: 'entry-x' });

  // The ack carries the navigated-to user message's text in detail (the viewer
  // restores it to the editor). Pre-fix: ack had no detail.
  const ack = await c.waitFrame(
    (f) => f.type === 'ack' && f.for === 'navigate_tree',
    'navigate_tree ack',
  );
  assert.ok(ack.type === 'ack' && ack.ok, 'navigate_tree acked ok');
  assert.equal(
    ack.type === 'ack' ? ack.detail : undefined,
    'rewound-to:entry-x',
    'ack.detail carries the rewound-to editor text',
  );

  // BOTH viewers get re-welcomed onto the rewound history. Pre-fix: no second
  // welcome ever arrives (navigate_tree only acked).
  await h.waitFor(() => (welcomes(c.frames).length >= 2 ? true : null), {
    label: 'controller re-welcomed after navigate_tree',
  });
  await h.waitFor(() => (welcomes(o.frames).length >= 2 ? true : null), {
    label: 'observer re-welcomed after navigate_tree',
  });

  // The re-welcome serves the REWOUND transcript: the fake's navigateTree popped
  // the last accrued turn, so the token present in the observer's first welcome
  // must be gone from its second.
  const [first, second] = welcomes(o.frames);
  assert.ok(frameHas(first, token), 'pre-navigate welcome holds the turn');
  assert.ok(!frameHas(second, token), 're-welcome serves the rewound transcript (turn dropped)');
  assert.equal(
    second.snapshot.messages.length,
    first.snapshot.messages.length - 1,
    're-welcome history is exactly one turn shorter',
  );
});
