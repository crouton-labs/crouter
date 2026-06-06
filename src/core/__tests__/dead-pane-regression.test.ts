// Run with: node --import tsx/esm --test src/core/__tests__/dead-pane-regression.test.ts
//
// PLACEMENT-FAMILY DEAD-PANE REGRESSION GUARD.
//
// The bug (fixed this session, committed in HEAD `src/core/spawn.ts`): the
// `human` command tree opens its humanloop TUI in a tmux pane via
// `spawnAndDetach` (a `split-window` into the CURRENT window). The canvas
// runtime arms `remain-on-exit on` at the WINDOW scope on a node's vehicle /
// focus window (the F3 freeze, `runtime/tmux.ts` setRemainOnExit). A
// `split-window` pane opened into such a window INHERITS the `on`, so when the
// TUI worker (`crtr human _run`) exits 0 (clean), tmux keeps the pane around as
// a dead "[Exited]" pane instead of destroying it — a lingering dead pane.
//
// The fix: after the split, `spawnAndDetach` forces `remain-on-exit off` at PANE
// scope on the new pane (`set-option -p -t <pane> remain-on-exit off`). That
// destroys the pane on a clean exit WITHOUT touching the window's value (so a
// focus freeze still works) or the user's global config.
//
// This file drives the REAL production `spawnAndDetach` against a REAL but
// isolated tmux session — no mocks. It is ADDITIVE: it adds no harness/fixture
// capability and edits no production file. The canvas harness
// (`helpers/harness.ts`) cannot reach this path — it drives canvas nodes via
// `openNodeWindow` (new-window backstage), never the `spawnAndDetach`
// split-window/human-pane path — so the tmux drivers below are LOCAL to this
// file (candidates for harness consolidation: a `splitDetachPane` + pane-scoped
// `paneAlive`/`paneIsDead`/`waitForPaneGone` keyed on a raw %pane id).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { hasTmux } from './helpers/harness.js';
import { spawnAndDetach } from '../spawn.js';

const SKIP = !hasTmux();

// --- LOCAL tmux drivers (keyed on a raw %pane id, not a canvas node) --------
function tmux(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** Every pane in the session (across windows) with its dead flag. */
function sessionPanes(session: string): { id: string; dead: boolean }[] {
  const r = tmux(['list-panes', '-s', '-t', session, '-F', '#{pane_id} #{pane_dead}']);
  if (r.code !== 0) return [];
  return r.out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [id, dead] = l.split(' ');
      return { id: id!, dead: dead === '1' };
    });
}
function paneAlive(session: string, pane: string): boolean {
  return sessionPanes(session).some((p) => p.id === pane && !p.dead);
}
function paneExists(session: string, pane: string): boolean {
  return sessionPanes(session).some((p) => p.id === pane);
}
function paneIsDead(session: string, pane: string): boolean {
  return sessionPanes(session).find((p) => p.id === pane)?.dead ?? false;
}

async function waitUntil(
  probe: () => boolean,
  label: string,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (probe()) return;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out: ${label}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test(
  'dead-pane regression: spawnAndDetach into a remain-on-exit-ON window is DESTROYED on clean exit',
  { skip: SKIP ? 'tmux unavailable' : false, timeout: 60_000 },
  async () => {
    const session = `crtr-deadpane-${process.pid}-${Date.now().toString(36)}`;
    const origTmux = process.env['TMUX'];
    let tmuxOverridden = false;
    try {
      // --- isolated session on whatever server the current env targets -------
      const created = tmux(['new-session', '-d', '-s', session, '-c', process.cwd(), 'sleep 100000']);
      assert.equal(created.code, 0, `create isolated session failed: ${created.err}`);

      const info = tmux([
        'display-message', '-p', '-t', `${session}:`,
        '#{pane_id}\t#{window_id}\t#{socket_path}',
      ]);
      assert.equal(info.code, 0, `display-message failed: ${info.err}`);
      const [basePane, baseWindow, socketPath] = info.out.split('\t');
      assert.ok(basePane && baseWindow && socketPath, `parsed session info: ${info.out}`);

      // --- arm the BUG PRECONDITION: window default remain-on-exit ON --------
      // (mirrors the canvas runtime's F3 freeze on a node's vehicle/focus window).
      const armed = tmux(['set-window-option', '-t', baseWindow!, 'remain-on-exit', 'on']);
      assert.equal(armed.code, 0, `arm window remain-on-exit on failed: ${armed.err}`);
      assert.equal(
        tmux(['show-window-options', '-t', baseWindow!, 'remain-on-exit']).out,
        'remain-on-exit on',
        'precondition: the window into which we split has remain-on-exit ON',
      );

      // spawnAndDetach gates on isInTmux() (Boolean(process.env.TMUX)) and shells
      // `tmux` with no -L, so point TMUX at THIS session's socket — both our
      // helpers and spawnAndDetach then drive the same server holding `session`.
      process.env['TMUX'] = `${socketPath},0,0`;
      tmuxOverridden = true;

      // ====================================================================
      // MAIN — the REAL production spawnAndDetach split into the ON window.
      // ====================================================================
      const res = spawnAndDetach({
        command: 'sleep 1', // a clean-exiting (status 0) worker — stands in for `crtr human _run`
        cwd: process.cwd(),
        placement: 'split-h',
        killAfterSeconds: 0, // no self-kill of the originating pane
        targetPane: basePane!, // pin the split to our isolated window (never the user's pane)
      });
      assert.equal(res.status, 'spawned', `spawnAndDetach should spawn: ${res.message}`);
      const pane = res.paneId!;
      assert.ok(pane && pane.startsWith('%'), `spawnAndDetach returned a %pane id: ${pane}`);

      // (a) the pane landed alive in the remain-on-exit-ON window.
      assert.equal(paneAlive(session, pane), true, 'spawned pane is alive right after the split');

      // (b) THE FIX: the spawned pane carries a PANE-SCOPED remain-on-exit OFF
      //     override — the exact line under regression
      //     (`set-option -p -t <pane> remain-on-exit off`). If a refactor drops
      //     it, this fails loudly.
      assert.equal(
        tmux(['show-options', '-p', '-t', pane, 'remain-on-exit']).out,
        'remain-on-exit off',
        'FIX present: pane-scoped remain-on-exit OFF on the spawnAndDetach pane',
      );
      // (c) the override is pane-scoped only — the WINDOW value is untouched, so
      //     a real focus-freeze on this window still works.
      assert.equal(
        tmux(['show-window-options', '-t', baseWindow!, 'remain-on-exit']).out,
        'remain-on-exit on',
        'window remain-on-exit untouched (override is pane-scoped, focus freeze intact)',
      );

      // (d) THE GUARANTEE: on the worker's CLEAN exit the pane is DESTROYED,
      //     never lingering as a dead [Exited] pane.
      await waitUntil(
        () => !paneExists(session, pane),
        'spawnAndDetach pane destroyed on clean exit',
      );
      assert.equal(paneExists(session, pane), false, 'spawnAndDetach pane DESTROYED on clean exit (not lingering)');

      // ====================================================================
      // CONTROL — prove the guard is NON-VACUOUS: the SAME split WITHOUT the
      // pane-scoped override (i.e. pre-fix behavior) lingers as a dead pane.
      // ====================================================================
      const ctl = tmux([
        'split-window', '-h', '-d', '-P', '-F', '#{pane_id}',
        '-t', basePane!, '-c', process.cwd(), 'sleep 1',
      ]);
      assert.equal(ctl.code, 0, `control split failed: ${ctl.err}`);
      const ctlPane = ctl.out;
      assert.ok(ctlPane.startsWith('%'), `control pane id: ${ctlPane}`);

      // No pane-scoped override → inherits the window's remain-on-exit ON →
      // after its clean exit the pane is kept as DEAD rather than destroyed.
      await waitUntil(() => paneIsDead(session, ctlPane), 'control pane reaches dead state after clean exit');
      assert.equal(paneExists(session, ctlPane), true, 'CONTROL: un-fixed pane LINGERS (still listed) after clean exit');
      assert.equal(
        paneIsDead(session, ctlPane),
        true,
        'CONTROL: the lingering pane is DEAD — confirms remain-on-exit ON causes the exact bug the fix prevents',
      );
    } finally {
      // Tear down on the SAME server the session lives on (TMUX still points there),
      // then restore the original TMUX env.
      tmux(['kill-session', '-t', session]);
      if (tmuxOverridden) {
        if (origTmux === undefined) delete process.env['TMUX'];
        else process.env['TMUX'] = origTmux;
      }
      assert.equal(
        spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0,
        false,
        'isolated session killed — no stray',
      );
    }
  },
);
