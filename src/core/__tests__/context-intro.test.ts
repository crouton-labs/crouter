// Tests for the <crtr-context> bearings preamble:
//   1. Worker and orchestrator bearings carry the `<references>` block
//      (substrate reference docs + node-local docs as a file tree).
//      Orchestrators add the across-cycles framing; promotion delivers that
//      same orchestrator context-dir framing to a node that spawned base.
//   2. canvas-context-intro injects the block as its own session message at
//      session_start (before the first prompt), idempotent across resumes.
//
// Run: node --import tsx/esm --test src/core/__tests__/context-intro.test.ts

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeDb } from '../canvas/db.js';
import { contextDir } from '../canvas/paths.js';
import { spawnNode } from '../runtime/nodes.js';
import { promote } from '../runtime/promote.js';
import { personaDrift } from '../runtime/persona.js';
import { memoryDir } from '../runtime/memory.js';
import registerCanvasContextIntro, {
  buildContextIntro,
  renderContextMessage,
  CONTEXT_INTRO_CUSTOM_TYPE,
} from '../../pi-extensions/canvas-context-intro.js';

let home: string;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-ctxintro-'));
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
  delete process.env['CRTR_NODE_ID'];
});

test('worker bearings: base framing + <references> block, NO across-cycles framing', () => {
  // Bug-regression: review finding M1 — buildContextBearings renders the
  // <references> block (renderReferencesBlock): a kind-wrapped file tree of
  // reference docs. This test locks in that contract.
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  // Seed a node-local substrate doc so the ## References block is non-empty.
  const dir = memoryDir(meta.node_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'test-ref.md'),
    '---\nkind: reference\nwhen-and-why-to-read: When testing, this reference should be read because it is a regression fixture\nsystem-prompt-visibility: preview\n---\nTest body.\n',
  );
  const block = buildContextIntro(meta.node_id);
  assert.match(block, new RegExp(`<crtr-context dir="${contextDir(meta.node_id)}">`));
  assert.match(block, /shared document store, not a task tracker/, 'base = shared docs, not tasks');
  // Reference content renders ONLY as the <references> file-tree block.
  assert.doesNotMatch(block, /<memory>/, 'no <memory> block');
  // Per-store stanza headers (label · dir) never appear.
  assert.doesNotMatch(block, /user-global · /, 'no user-global label·dir stanza');
  assert.doesNotMatch(block, /node-local · /, 'no node-local label·dir stanza');
  // No (empty) placeholder marker.
  assert.doesNotMatch(block, /\(empty\)/, 'no (empty) placeholder');
  assert.match(block, /<references>/, '<references> block present');
  assert.match(block, /\nreferences\n/, 'tree headed by the `references` root label');
  // The node-local preview-rung doc renders as a tree entry with a `# read when:`
  // routing line (verbatim previewLine output).
  assert.match(
    block,
    /test-ref {2}# read when: When testing, this reference should be read because it is a regression fixture\./,
    'node-local preview doc renders its routing line',
  );
  // A terminal worker must NOT carry the orchestrator across-cycles framing.
  assert.doesNotMatch(block, /refresh cycles/, 'no across-cycles framing for a terminal worker');
  assert.match(block, /<\/crtr-context>/);
});

test('orchestrator bearings: across-cycles framing + node-local substrate docs ride into <references>; a non-substrate .md file is never inlined', () => {
  // Bug-regression: review finding M1 — buildContextBearings renders <references>.
  // Node-local substrate docs render as tree entries at their rung; a
  // non-substrate .md file (no frontmatter `kind`) never surfaces.
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id); // flip to orchestrator mode — the across-cycles gate
  const dir = memoryDir(meta.node_id);
  mkdirSync(dir, { recursive: true });
  // Write a non-substrate MEMORY.md file to verify it is never surfaced in the block.
  const legacyIndexPath = join(dir, 'MEMORY.md');
  writeFileSync(
    legacyIndexPath,
    '# memory index — one pointer line per memory; how-to in "Your long-term memory".\n\n- [Flaky build](flaky-build.md) — first run fails\n',
  );
  // A node-local substrate doc DOES ride into ## References at its rung.
  writeFileSync(
    join(dir, 'flaky-build.md'),
    '---\nkind: reference\nwhen-and-why-to-read: When the build flakes, this reference should be read because the first run fails\nsystem-prompt-visibility: preview\n---\nFirst run always fails; rerun once.\n',
  );

  const block = buildContextIntro(meta.node_id);
  assert.match(block, /shared document store, not a task tracker/, 'still carries the base framing');
  assert.match(block, /refresh cycles/, 'orchestrator gets the across-cycles framing');
  assert.doesNotMatch(block, /<memory>/, 'no <memory> block');
  assert.match(block, /<references>/, 'references block present');
  assert.match(
    block,
    /flaky-build {2}# read when: When the build flakes, this reference should be read because the first run fails\./,
    'node-local doc renders as a tree entry with its routing line',
  );
  // The non-substrate file never renders: no header line, no pointer line, no path.
  assert.ok(!block.includes('# memory index'), 'the index header comment is NOT inlined');
  assert.ok(!block.includes('- [Flaky build](flaky-build.md)'), 'index pointer lines are NOT inlined');
  assert.ok(!block.includes(legacyIndexPath), 'no absolute index (MEMORY.md) path');
  assert.ok(!block.includes('node-local · '), 'no label·dir stanza header');
  assert.match(block, /<\/crtr-context>/);
});

test('orchestrator bearings: no per-store stanzas or (empty) markers; a rung-none node-local doc still surfaces as a bare-name tree entry', () => {
  // Bug-regression: review findings M1 + M6 — the <references> block carries no
  // per-store `label · dir` stanzas or (empty) markers, and node-local docs are
  // NOT filtered on rung: a migrated node-local reference defaults
  // system-prompt-visibility: none and must still ride into <references> as
  // its bare name (floored to the `name` rung; never its body).
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id); // flip to orchestrator mode
  const dir = memoryDir(meta.node_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'rung-none-fact.md'),
    '---\nkind: reference\n---\nbody that must not render at the none rung\n',
  );

  const block = buildContextIntro(meta.node_id);
  // No per-store stanza headers, no (empty) markers, no MEMORY.md paths.
  assert.ok(!block.includes(`node-local · ${memoryDir(meta.node_id)}`), 'no node-local stanza header');
  assert.ok(!block.includes('user-global · '), 'no user-global stanza header');
  assert.ok(!block.includes('project · '), 'no project stanza header');
  assert.doesNotMatch(block, /\(empty\)/, 'no (empty) markers');
  assert.ok(!block.includes('MEMORY.md'), 'no MEMORY.md path in the block');
  // M6: rung-none node-local doc surfaces as a bare-name tree entry only.
  assert.match(block, /─ rung-none-fact\n/, 'rung-none node-local doc surfaces as a bare-name tree entry');
  assert.ok(!block.includes('body that must not render'), 'none rung renders the name only, not the body');
});

test('promotion guidance delivers the orchestrator context-dir framing', () => {
  // A node spawns as a base worker (no orchestrator bearings). On promotion the
  // persona injector must build the across-cycles context-dir framing it never
  // got at spawn (delivered at the next turn boundary, not returned by promote).
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id);
  const drift = personaDrift(meta.node_id);
  const guidance = drift?.guidance ?? '';
  assert.ok(drift !== null, 'promotion drifts the persona (base→orchestrator)');
  assert.match(guidance, /refresh cycles/, 'promotion guidance carries the across-cycles framing');
  assert.ok(guidance.includes(contextDir(meta.node_id)), 'and names the context dir path');
});

// Minimal fake pi that captures the `session_start` handler and records every
// pi.sendMessage call, plus a fake ctx whose sessionManager returns whatever
// entries we hand it.
interface FakePi {
  handler?: (ev: any, ctx: any) => any;
  sent: any[];
  renderers: Record<string, (m: any, o: any, t: any) => any>;
  on: (e: string, h: (ev: any, ctx: any) => any) => void;
  sendMessage: (m: any, o?: any) => void;
  registerMessageRenderer: (t: string, r: (m: any, o: any, t: any) => any) => void;
}
function makeFakePi(): FakePi {
  return {
    sent: [],
    renderers: {},
    on(e, h) { if (e === 'session_start') this.handler = h; },
    sendMessage(m) { this.sent.push(m); },
    registerMessageRenderer(t, r) { this.renderers[t] = r; },
  };
}
function fakeCtx(entries: Array<{ type: string; customType?: string }> = []) {
  return { sessionManager: { getEntries: () => entries } };
}

test('session_start injects the block as the first message of an empty session', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  process.env['CRTR_NODE_ID'] = meta.node_id;

  const pi = makeFakePi();
  registerCanvasContextIntro(pi as any);
  assert.ok(pi.handler, 'session_start handler registered');

  // Empty session → inject the block as its own custom message (no delivery
  // options → it precedes the first prompt).
  pi.handler!({ reason: 'startup' }, fakeCtx());
  assert.equal(pi.sent.length, 1, 'one message injected');
  assert.equal(pi.sent[0].customType, CONTEXT_INTRO_CUSTOM_TYPE);
  assert.equal(pi.sent[0].display, true);
  assert.match(pi.sent[0].content, /<crtr-context dir=/);
});

test('session_start is idempotent across resume (skips if already in history)', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  process.env['CRTR_NODE_ID'] = meta.node_id;

  // Restored session already carries OUR block (which names this node id) → no
  // duplicate injection. The content matters: the guard is fork-aware and only
  // skips when the present bearings name THIS node (a fork inherits the
  // SOURCE's bearings, which name a different node — see canvas-context-intro
  // tests), so a realistic resume entry must carry the real block content.
  const pi = makeFakePi();
  registerCanvasContextIntro(pi as any);
  const entries = [
    { type: 'custom_message', customType: CONTEXT_INTRO_CUSTOM_TYPE, content: buildContextIntro(meta.node_id) },
  ];
  pi.handler!({ reason: 'resume' }, fakeCtx(entries));
  assert.equal(pi.sent.length, 0, 'our own block already in history → skip');
});

test('session_start is inert when CRTR_NODE_ID is absent', () => {
  delete process.env['CRTR_NODE_ID'];
  const pi = makeFakePi();
  registerCanvasContextIntro(pi as any);
  pi.handler!({ reason: 'startup' }, fakeCtx());
  assert.equal(pi.sent.length, 0);
});

test('renderer registered for the customType; collapsed hides body, ctrl+o expand reveals it', () => {
  const pi = makeFakePi();
  registerCanvasContextIntro(pi as any);

  const renderer = pi.renderers[CONTEXT_INTRO_CUSTOM_TYPE];
  assert.ok(renderer, 'message renderer registered for crtr-context');

  const body = '<crtr-context dir="/x">\nshared document store\n</crtr-context>';
  const message = { customType: CONTEXT_INTRO_CUSTOM_TYPE, content: body };
  const theme = {}; // no fg → plain text, easy to assert

  // Collapsed (default): a single stub line, NONE of the body.
  const collapsed = renderContextMessage(message, { expanded: false }, theme).render(80);
  assert.equal(collapsed.length, 1, 'collapsed is one line');
  assert.match(collapsed[0]!, /ctrl\+o to expand/);
  assert.ok(!collapsed.join('\n').includes('shared document store'), 'body hidden when collapsed');

  // Expanded (Ctrl+O): label + full body.
  const expanded = renderContextMessage(message, { expanded: true }, theme).render(80);
  const joined = expanded.join('\n');
  assert.ok(joined.includes('shared document store'), 'body shown when expanded');
  assert.ok(joined.includes(`[${CONTEXT_INTRO_CUSTOM_TYPE}]`), 'expanded shows the label');
});

test('renderer never emits a line wider than the terminal (truncates the collapsed stub)', () => {
  // Regression: a fixed-width stub crashed pi's TUI at narrow widths
  // ("Rendered line 1 exceeds terminal width"). Every emitted line — collapsed
  // or expanded — must fit within the width handed to render().
  const body = Array.from({ length: 6 }, () => 'x'.repeat(200)).join('\n');
  const message = { customType: CONTEXT_INTRO_CUSTOM_TYPE, content: body };
  const theme = {}; // no fg → plain text, so .length == visible width

  for (const w of [1, 2, 5, 10, 20, 42, 80]) {
    for (const expanded of [false, true]) {
      const lines = renderContextMessage(message, { expanded }, theme).render(w);
      for (const line of lines) {
        assert.ok(
          [...line].length <= w,
          `width=${w} expanded=${expanded}: line ${[...line].length} cols exceeds ${w}: ${JSON.stringify(line)}`,
        );
      }
    }
  }
});
