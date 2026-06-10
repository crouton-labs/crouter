// Run with: node --import tsx/esm --test src/core/__tests__/human-new-window-regression.test.ts
//
// BUG REGRESSION: `crtr human ask|approve|review|notify` opened NO pane at all.
//
// spawnAndDetach's 'new-window' placement passed a tmux PANE id straight to
// `new-window -t` (`new-window -d -a -t %<pane>`). tmux REJECTS a pane id for
// new-window — it exits 1 with "can't specify pane here"; only `split-window -t`
// accepts a pane. So once a node's watched window held >= max_panes_per_window
// panes, pickPlacement (shared.ts) chose 'new-window', spawnAndDetach FAILED,
// spawnHumanJob returned {spawned:false}, and the humanloop TUI never appeared.
// Deterministic for any user whose watched window is already at the pane cap.
//
// Regression from 829c1a1 ("land prompts in the watched node's session"), which
// began routing the TUI to the watched node's pane id but never converted it to
// the session:window form new-window needs.
//
// THE FIX: spawnAndDetach resolves the target pane to its session:window
// (`paneWindowTarget`) before `new-window -t`. This drives the REAL production
// spawnAndDetach against a REAL but isolated tmux session — no mocks — mirroring
// dead-pane-regression.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { hasTmux } from '../helpers/harness.js';
import { spawnAndDetach } from '../../spawn.js';

const SKIP = !hasTmux();

function tmux(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

/** window id of a pane (across the server). '' on error. */
function windowOfPane(pane: string): string {
  return tmux(['display-message', '-p', '-t', pane, '#{window_id}']).out;
}

/** Every pane in the session, across all its windows. */
function sessionPanes(session: string): string[] {
  const r = tmux(['list-panes', '-s', '-t', session, '-F', '#{pane_id}']);
  if (r.code !== 0) return [];
  return r.out.split('\n').filter((l) => l.trim() !== '');
}

test(
  'human-new-window regression: spawnAndDetach new-window into a watched-pane SPAWNS (no longer "can\'t specify pane here")',
  { skip: SKIP ? 'tmux unavailable' : false, timeout: 60_000 },
  async () => {
    const session = `crtr-newwin-${process.pid}-${Date.now().toString(36)}`;
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

      // ====================================================================
      // CONTROL — prove the bug is REAL and the guard NON-VACUOUS: the pre-fix
      // call shape (a PANE id straight into `new-window -t`) is REJECTED by tmux.
      // ====================================================================
      const ctl = tmux(['new-window', '-d', '-a', '-t', basePane!, '-c', process.cwd(), 'sleep 100000']);
      assert.notEqual(ctl.code, 0, 'CONTROL: new-window with a PANE id must FAIL (pre-fix call shape)');
      assert.match(
        ctl.err,
        /can't specify pane here/i,
        `CONTROL: tmux rejects a pane id for new-window — got: ${ctl.err}`,
      );

      // spawnAndDetach gates on isInTmux() (Boolean(process.env.TMUX)) and shells
      // `tmux` with no -L, so point TMUX at THIS session's socket — both our
      // helpers and spawnAndDetach then drive the same server holding `session`.
      process.env['TMUX'] = `${socketPath},0,0`;
      tmuxOverridden = true;

      // ====================================================================
      // MAIN — the REAL production spawnAndDetach, 'new-window' placement,
      // pinned to the watched PANE (exactly what detachHumanTui passes when
      // pickPlacement returns 'new-window').
      // ====================================================================
      const res = spawnAndDetach({
        command: 'sleep 100000', // long-lived stand-in for `crtr human _run`
        cwd: process.cwd(),
        placement: 'new-window',
        detached: true, // don't switch the client (matches detachHumanTui)
        killAfterSeconds: 0, // no self-kill of the originating pane
        targetPane: basePane!, // a PANE id — the exact value that used to break new-window
      });

      // (a) THE FIX: it SPAWNS (pre-fix this was 'spawn-failed' / no pane).
      assert.equal(res.status, 'spawned', `spawnAndDetach should spawn a pane: ${res.message}`);
      const pane = res.paneId!;
      assert.ok(pane && pane.startsWith('%'), `spawnAndDetach returned a %pane id: ${pane}`);

      // (b) it landed in the SAME session as the watched pane (not stranded /
      //     leaked into the global current session), in a NEW window.
      assert.ok(sessionPanes(session).includes(pane), 'spawned pane lives in the watched pane\'s session');
      assert.notEqual(
        windowOfPane(pane),
        baseWindow,
        'spawned pane is in a NEW window (new-window placement), not the watched pane\'s window',
      );
    } finally {
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
