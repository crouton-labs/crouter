// Run with: node --import tsx/esm --test src/core/__tests__/spike-harness.test.ts
//
// HEADLESS RETARGET (foundation-spec §C.14 + §E). The throwaway-grade POC that a
// faithful integration harness for the node/canvas runtime is feasible — now on
// the BROKER path, in the FAST tier (no tmux, no hasTmux() gate). It drives the
// REAL `crtr` CLI to spawn a `--headless` node onto the REAL headless broker host,
// which boots a REAL detached broker PROCESS hosting the fake SDK engine via the
// CRTR_BROKER_ENGINE seam — proving the broker exec's with the right argv+env,
// loads the REAL `-e` canvas extensions, and that real lifecycle hooks drive real
// canvas transitions.
//
// Milestones (de-risk order):
//   1. SEAM      — piCommand substitutes CRTR_PI_BINARY only when set (pure unit).
//   2. ROUND-TRIP— real `node new --headless` → real broker boots with CRTR_NODE_ID
//                  + the -e canvas extensions intact (GO/NO-GO).
//   3. REAL HOOKS— the broker loads the real stophook: session_start captures
//                  pi_session_id + recordPid(broker pid); a `push --final` agent_end
//                  drives status=done through the stophook's clean-exit branch.
//
// (1) BUG LOCKED — harness faithfulness. A real `node new --headless` must boot a
//     real broker that loads EVERY canvas `-e` extension with none failing, the
//     REAL stophook must capture the session id on session_start, and the REAL
//     stophook agent_end clean-exit branch must transition the node to done.
//
// (2) WHY MODEL-LEVEL / HEADLESS — the broker hosts the fake engine over the SDK
//     seam (no real LLM), boots DETACHED supervised by pid (no tmux pane), and
//     every proof is a file the broker writes (fake-pi.boots.jsonl) or a canvas
//     row — nothing reads a pane. ONE real boot is inherent: the POC's whole
//     point is that a real broker PROCESS loads real extensions + fires real hooks.
//     (The fake engine models a clean exit via the broker's shutdownHandler rather
//     than a pi `session_shutdown` frame, so the clean done transition is driven
//     through the stophook's `push --final` agent_end branch — the same real
//     stophook code path that shuts a done broker down.)
//
// (3) HOW THE HEADLESS DRIVE STILL FAILS IF THE BUG REGRESSES — if the seam or an
//     extension load broke, failedExt is non-empty or extPaths drifts from
//     CANVAS_EXTENSIONS → RED; if the stophook didn't capture the session,
//     pi_session_id stays null → RED; if the clean-exit branch didn't shut the
//     broker down, status never reaches done → the finish wait times out.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createHarness, type Harness } from './helpers/harness.js';
import { piCommand } from '../runtime/placement.js';
import { CANVAS_EXTENSIONS } from '../runtime/launch.js';

let h: Harness;
let root: string;

before(async () => {
  h = await createHarness({ headless: true, sessionPrefix: 'crtr-spike' });
  root = h.spawnRoot('spike acting-root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

// ===========================================================================
// MILESTONE 1 — the CRTR_PI_BINARY seam (pure unit; no boot, no tmux).
// ===========================================================================
test('M1 seam: piCommand exec\'s `pi` when CRTR_PI_BINARY is unset, substitutes when set', () => {
  const saved = process.env['CRTR_PI_BINARY'];
  try {
    delete process.env['CRTR_PI_BINARY'];
    const unset = piCommand(['-e', '/abs/ext.ts', '-n', 'label']);
    assert.equal(unset, "pi '-e' '/abs/ext.ts' '-n' 'label'", 'unset → identical to exec pi');
    assert.ok(unset.startsWith('pi '), 'unset → leads with the literal pi binary');

    process.env['CRTR_PI_BINARY'] = '/tmp/fake-pi';
    const set = piCommand(['-e', '/abs/ext.ts']);
    assert.ok(set.startsWith('/tmp/fake-pi '), 'set → leads with the substituted binary');
    assert.ok(!set.startsWith('pi '), 'set → no longer the literal pi');
    assert.equal(set, "/tmp/fake-pi '-e' '/abs/ext.ts'", 'argv still shell-quoted after the substitution');

    // A multi-word launcher is spliced verbatim (argv stays quoted).
    process.env['CRTR_PI_BINARY'] = 'node --import tsx/esm host.ts';
    assert.equal(
      piCommand(['-n', 'x']),
      "node --import tsx/esm host.ts '-n' 'x'",
      'multi-word binary spliced ahead of the quoted argv',
    );

    // An explicit binary arg still overrides the env.
    assert.ok(
      piCommand(['-n', 'x'], 'pi').startsWith('pi '),
      'explicit binary arg wins over the env seam',
    );
  } finally {
    if (saved === undefined) delete process.env['CRTR_PI_BINARY'];
    else process.env['CRTR_PI_BINARY'] = saved;
  }
});

// ===========================================================================
// MILESTONES 2 + 3 — real `node new --headless` → real broker → real hooks.
// THE GO/NO-GO. One spawned broker drives both milestones (one real boot).
// ===========================================================================
test('M2+M3 round-trip: real `node new --headless` boots the broker via the seam, real hooks drive status=done', async () => {
  const id = await h.spawnHeadlessChild(root, 'spike task');

  // ---- MILESTONE 2: the round-trip reached the real broker -----------------
  const boot = await h.awaitBoot(id);
  const env = boot.env as Record<string, string | null>;
  assert.equal(env['CRTR_NODE_ID'], id, 'CRTR_NODE_ID is the CHILD id, intact');
  assert.equal(env['CRTR_HOME'], h.home, 'CRTR_HOME isolated value intact');
  assert.ok(env['CRTR_KIND'], 'CRTR_KIND present');
  assert.ok(env['CRTR_MODE'], 'CRTR_MODE present');
  assert.ok(env['CRTR_LIFECYCLE'], 'CRTR_LIFECYCLE present');
  assert.equal(env['CRTR_FRONT_DOOR'], '1', 'CRTR_FRONT_DOOR overlay present (broker host)');

  // argv from buildPiArgv arrived: every canvas -e extension + the kickoff. Assert
  // against the live CANVAS_EXTENSIONS count so this never drifts again.
  assert.equal(
    boot.extPaths.length,
    CANVAS_EXTENSIONS.length,
    `all ${CANVAS_EXTENSIONS.length} canvas -e extension paths in argv`,
  );
  assert.ok(
    boot.loaded.some((p: string) => p.includes('canvas-stophook')),
    'real stophook module loaded by the broker',
  );
  assert.ok(
    boot.loaded.some((p: string) => p.includes('canvas-inbox-watcher')),
    'real inbox-watcher module loaded by the broker',
  );
  assert.equal(boot.failedExt.length, 0, `no extension failed to load: ${JSON.stringify(boot.failedExt)}`);
  assert.equal(boot.resuming, false, 'fresh start (no --session)');
  assert.equal(boot.prompt, 'spike task', 'kickoff prompt is the last positional');

  // The REAL stophook session_start handler ran inside the broker and wrote shared
  // canvas state (proves the hook chain, not just the boot).
  const afterBoot = h.node(id)!;
  assert.equal(afterBoot.pi_session_id, (boot as { sessionId?: string }).sessionId, 'stophook captured pi_session_id');
  assert.equal(afterBoot.status, 'active', 'child active after boot');

  // ---- MILESTONE 3: a clean finish drives a real transition to done --------
  // push --final flips status=done; the broker's agent_end runs the REAL stophook
  // clean-exit branch (status already done → ctx.shutdown → broker disposes/exits).
  await h.finish(id, 'spike done');
  assert.equal(h.status(id), 'done', 'real stophook agent_end resolved the node to done');
});
