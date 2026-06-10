// Run with: node --import tsx/esm --test src/core/__tests__/review-render-pane-regression.test.ts
//
// BUG REGRESSION: `crtr human review` showed the human RAW markdown — literal
// `:::callout{...}` / `#` / `**bold**` source — instead of the termrender-
// rendered document the leaf help promises ("directive-flavored markdown
// rendered by termrender (panels, columns, trees, callouts, mermaid)").
//
// Root cause: the review surface was ONLY the read-only nvim buffer. nvim must
// show the raw source (anchored comments hang off source line/col numbers), and
// `-u NONE` treesitter/render-markdown styling never interprets ::: directives —
// so nothing anywhere rendered the doc. There was no termrender invocation in
// the entire review path (crouter `_run` review branch + humanloop
// launchReview): the managed venv binary was healthy and never asked.
//
// THE FIX (src/commands/human/queue.ts, `_run` review branch): open a live
// termrender watch pane via humanloop `display()` BESIDE the editor, record its
// pane id as `render_pane_id` on run.json (so `human cancel` can clear it), and
// kill it in a `finally` when the editor exits. The editor keeps the raw
// source; the human reads the rendered pane.
//
// This test drives the REAL `crtr human _run` worker (review mode) in a REAL
// but isolated tmux session — no mocks — and asserts:
//   (a) a second pane appears beside the editor running termrender on the file,
//   (b) that pane's content is RENDERED ANSI (box-drawing panels), not raw `:::`,
//   (c) run.json carries render_pane_id for the cancel path,
//   (d) the render pane is torn down when the editor exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { hasTmux } from '../helpers/harness.js';

const CROUTER = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const CLI_SRC = join(CROUTER, 'src', 'cli.ts');
const TSX_ESM = createRequire(import.meta.url).resolve('tsx/esm');

function tmux(args: string[]): { code: number; out: string; err: string } {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function sessionPanes(session: string): Array<{ id: string; cmd: string }> {
  const r = tmux(['list-panes', '-s', '-t', session, '-F', '#{pane_id}\t#{pane_current_command}']);
  if (r.code !== 0) return [];
  return r.out
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [id, cmd] = l.split('\t');
      return { id: id ?? '', cmd: cmd ?? '' };
    });
}

function paneContent(paneId: string): string {
  return tmux(['capture-pane', '-p', '-t', paneId]).out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await sleep(300);
  }
}

const SKIP = !hasTmux();

test(
  'review-render-pane regression: `human _run` (review) opens a live termrender pane showing RENDERED panels, not raw ::: source',
  { skip: SKIP ? 'tmux unavailable' : false, timeout: 90_000 },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crtr-review-render-'));
    const session = `crtr-revrender-${process.pid}-${Date.now().toString(36)}`;
    const mdPath = join(dir, 'doc.md');
    // A directive doc: rendered output has box-drawing panels; raw output has `:::`.
    writeFileSync(
      mdPath,
      '# Render check\n\n:::callout{type="info"}\nRENDER-MARKER body\n:::\n',
    );
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ mode: 'review', job_id: '', file: mdPath, output: join(dir, 'feedback.json') }),
    );

    try {
      // The worker runs the real `crtr human _run` from src via tsx, exactly the
      // command shape detachHumanTui bakes into the spawned pane. job_id is ''
      // so pushFinal is skipped (no canvas home needed) — the surface under
      // test is the panes, not the report fan-out.
      const workerCmd =
        `CRTR_HUMAN_DIR='${dir}' '${process.execPath}' --import '${TSX_ESM}' '${CLI_SRC}' human _run; sleep 120`;
      const created = tmux(['new-session', '-d', '-s', session, '-x', '200', '-y', '50', workerCmd]);
      assert.equal(created.code, 0, `create isolated session failed: ${created.err}`);

      // (a) a SECOND pane appears: the termrender watch pane beside the editor.
      const renderPane = await waitFor(
        () => {
          const panes = sessionPanes(session);
          if (panes.length < 2) return undefined;
          // The render pane is the one NOT hosting the editor/worker shell.
          const candidates = panes.filter((p) => !/zsh|bash|sh|node|nvim|vim/i.test(p.cmd));
          return candidates[0]?.id;
        },
        30_000,
        'termrender render pane to open',
      );

      // (b) its content is RENDERED: panel box-drawing present, raw ::: absent.
      const rendered = await waitFor(
        () => {
          const c = paneContent(renderPane);
          return c.includes('RENDER-MARKER') ? c : undefined;
        },
        30_000,
        'rendered body to paint',
      );
      assert.ok(/[┌│└]/.test(rendered), `render pane draws panels (box chars): ${rendered.slice(0, 200)}`);
      assert.ok(!rendered.includes(':::'), 'render pane does NOT show raw ::: directive source');

      // (c) run.json carries render_pane_id so `human cancel` can clear the pane.
      const rc = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as { render_pane_id?: string };
      assert.equal(rc.render_pane_id, renderPane, 'run.json records the render pane id');

      // (d) editor exit (any quit submits) tears the render pane down. The
      // editor pane is the OTHER pane (nvim runs as a child of the worker, so
      // #{pane_current_command} may report node/zsh — match on its content:
      // the read-only buffer shows the RAW ::: source).
      const editorPane = await waitFor(
        () => {
          const other = sessionPanes(session).find((p) => p.id !== renderPane);
          if (other === undefined) return undefined;
          return paneContent(other.id).includes(':::') ? other.id : undefined;
        },
        30_000,
        'editor pane showing the raw source buffer',
      );
      tmux(['send-keys', '-t', editorPane, 'Space', 's']);
      await waitFor(
        () => (existsSync(join(dir, 'feedback.json')) ? true : undefined),
        30_000,
        'feedback.json after submit',
      );
      await waitFor(
        () => (sessionPanes(session).some((p) => p.id === renderPane) ? undefined : true),
        15_000,
        'render pane to be killed after editor exit',
      );
    } finally {
      tmux(['kill-session', '-t', session]);
      // The worker may still be flushing job files as it exits; retry the rm
      // briefly so a write racing the first attempt can't fail the test.
      for (let i = 0; i < 10; i++) {
        try {
          rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await sleep(300);
        }
      }
    }
  },
);
