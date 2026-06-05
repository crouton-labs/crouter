// Tests for the <crtr-context> bearings preamble + scoped memory:
//   1. A plain spawned node gets NO MEMORY.md; promotion seeds it (the template).
//   2. seedMemory is idempotent (never clobbers an evolved memory).
//   3. Worker bearings = shared-doc framing only (no <memory> block);
//      orchestrator bearings add the across-cycles framing + a <memory> block
//      that MERGES the applicable store indexes (content inlined, labeled by
//      scope); promotion delivers that same orchestrator context-dir framing to
//      a node that spawned base.
//   4. canvas-context-intro injects the block as its own session message at
//      session_start (before the first prompt), idempotent across resumes.
//
// Run: node --import tsx/esm --test src/core/__tests__/context-intro.test.ts

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { existsSync } from 'node:fs';
import { closeDb } from '../canvas/db.js';
import { contextDir } from '../canvas/paths.js';
import { spawnNode } from '../runtime/nodes.js';
import { promote } from '../runtime/promote.js';
import { personaDrift } from '../runtime/persona.js';
import {
  memoryPath,
  memoryDir,
  readMemory,
  seedMemory,
  hasMemory,
  MEMORY_TEMPLATE,
  userMemoryPath,
  projectMemoryPath,
} from '../runtime/memory.js';
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

test('a plain spawned node gets NO memory; promotion seeds the index + dir', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  assert.equal(hasMemory(meta.node_id), false, 'no memory before promotion');

  promote(meta.node_id);
  assert.ok(hasMemory(meta.node_id), 'MEMORY.md index exists after promotion');
  assert.ok(existsSync(memoryDir(meta.node_id)), 'memory dir created for direct writes');
  assert.ok(memoryPath(meta.node_id).endsWith('/memory/MEMORY.md'), 'index lives inside the memory dir');
  assert.equal(readMemory(meta.node_id), MEMORY_TEMPLATE);
});

test('seedMemory is idempotent — never clobbers an evolved memory', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  seedMemory(meta.node_id);
  const evolved = '# Memory\n\n## Lessons\n- never trust the cache\n';
  writeFileSync(memoryPath(meta.node_id), evolved);

  assert.equal(seedMemory(meta.node_id), false, 'returns false when one exists');
  assert.equal(readMemory(meta.node_id), evolved, 'left untouched');
});

test('worker bearings: shared-doc framing only, no orchestrator/memory framing', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  const block = buildContextIntro(meta.node_id);
  assert.match(block, new RegExp(`<crtr-context dir="${contextDir(meta.node_id)}">`));
  assert.match(block, /shared document store, not a task tracker/, 'base = shared docs, not tasks');
  assert.doesNotMatch(block, /MEMORY\.md/, 'no memory pointer for a memory-less worker');
  assert.doesNotMatch(block, /<memory>/, 'no memory block for a memory-less worker');
  assert.doesNotMatch(block, /refresh cycles/, 'no across-cycles framing for a terminal worker');
  assert.match(block, /<\/crtr-context>/);
});

test('orchestrator bearings: across-cycles framing + a <memory> block that merges the index (content inlined)', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  seedMemory(meta.node_id);
  writeFileSync(memoryPath(meta.node_id), '# Memory\n\n- [Flaky build](flaky-build.md) — first run fails\n');

  const block = buildContextIntro(meta.node_id);
  assert.match(block, /shared document store, not a task tracker/, 'still carries the base framing');
  assert.match(block, /refresh cycles/, 'orchestrator gets the across-cycles framing');
  assert.match(block, /<memory>/, 'has a memory block');
  assert.match(block, /\[node-local\]/, 'node-local store is labeled');
  assert.ok(block.includes(memoryDir(meta.node_id)), 'names the node-local memory dir (where to write)');
  assert.ok(block.includes(memoryPath(meta.node_id)), 'names the node-local index path');
  assert.match(block, /Flaky build/, 'index content IS merged in (read fresh from disk)');
  assert.match(block, /<\/crtr-context>/);
});

test('orchestrator bearings: a promoted node merges all THREE store indexes, labeled by scope', () => {
  const meta = spawnNode({ kind: 'general', cwd: '/tmp/work', parent: null });
  promote(meta.node_id); // seeds user-global + project + node-local

  const block = buildContextIntro(meta.node_id);
  for (const label of ['[user-global]', '[project]', '[node-local]']) {
    assert.ok(block.includes(label), `merges the ${label} store`);
  }
  assert.ok(block.includes(userMemoryPath()), 'names the user-global index path');
  assert.ok(block.includes(projectMemoryPath('/tmp/work')), 'names the project index path');
  assert.ok(block.includes(memoryPath(meta.node_id)), 'names the node-local index path');
  // The type→store mapping is taught by the kernel; the block points at it.
  assert.match(block, /type/, 'the block references the type that decides the store');
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

  // Restored session already carries the block → no duplicate injection.
  const pi = makeFakePi();
  registerCanvasContextIntro(pi as any);
  const entries = [{ type: 'custom_message', customType: CONTEXT_INTRO_CUSTOM_TYPE }];
  pi.handler!({ reason: 'resume' }, fakeCtx(entries));
  assert.equal(pi.sent.length, 0, 'block already in history → skip');
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
