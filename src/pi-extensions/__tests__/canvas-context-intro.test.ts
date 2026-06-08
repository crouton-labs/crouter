// Run with: node --import tsx/esm --test src/pi-extensions/__tests__/canvas-context-intro.test.ts
//
// BUG REGRESSION (crouter/CLAUDE.md testing policy):
//   `crtr node new --fork-from <node>` caused AGENT IDENTITY CONFUSION. A fork
//   inherits the SOURCE node's entire first-person conversation (pi COPIES it
//   into the fork's session), so on boot the forked agent impersonated the
//   source — it kept acting AS the source, even "monitoring itself" as a phantom
//   child, until it happened to check CRTR_NODE_ID. Two root causes, both fixed
//   here and pinned by these tests:
//     1. canvas-context-intro never re-asserted the node's OWN identity, so the
//        copied first-person narrative won.
//     2. the idempotency guard misfired for a fork: the copied conversation
//        already carries the SOURCE's <crtr-context> entry, so the guard treated
//        it as "already present" and SUPPRESSED the fork's own intro entirely —
//        the fork booted with the source's bearings (source id, source dir).
//   Symptom write-up: nodes/mq4ns376-da6e56c9/reports/20260608T075810-final.md.

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildContextIntro,
  registerCanvasContextIntro,
  CONTEXT_INTRO_CUSTOM_TYPE,
} from '../canvas-context-intro.js';
import { createNode } from '../../core/canvas/canvas.js';
import { closeDb } from '../../core/canvas/db.js';
import type { NodeMeta } from '../../core/canvas/types.js';

let home: string;
let origNode: string | undefined;

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

/** A session entry as `sessionManager.getEntries()` would return it — a custom
 *  message carrying a bearings block (string content). */
function introEntry(content: string): { type: string; customType: string; content: string } {
  return { type: 'custom_message', customType: CONTEXT_INTRO_CUSTOM_TYPE, content };
}

interface FakePi {
  sent: { customType: string; content: string; details?: { nodeId?: string } }[];
  on: (event: string, h: (ev: unknown, ctx: unknown) => void) => void;
  sendMessage: (m: { customType: string; content: string; details?: { nodeId?: string } }) => void;
  registerMessageRenderer: () => void;
  /** Drive session_start with a fixed entry list (what a fork/resume restores). */
  fireSessionStart: (entries: unknown[]) => void;
}

function makeFakePi(): FakePi {
  let handler: ((ev: unknown, ctx: unknown) => void) | undefined;
  return {
    sent: [],
    on(event, h) {
      if (event === 'session_start') handler = h;
    },
    sendMessage(m) {
      this.sent.push(m);
    },
    registerMessageRenderer() {
      /* display-only; irrelevant here */
    },
    fireSessionStart(entries) {
      handler?.(undefined, { sessionManager: { getEntries: () => entries } });
    },
  };
}

before(() => {
  origNode = process.env['CRTR_NODE_ID'];
});

beforeEach(() => {
  closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
  home = mkdtempSync(join(tmpdir(), 'crtr-context-intro-'));
  process.env['CRTR_HOME'] = home;
  delete process.env['CRTR_NODE_ID'];
});

after(() => {
  closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
  if (origNode === undefined) delete process.env['CRTR_NODE_ID'];
  else process.env['CRTR_NODE_ID'] = origNode;
});

test('boot intro asserts the node\'s OWN identity up front (regression: forked node impersonated source)', () => {
  createNode(node('alpha', { name: 'fix-auth', kind: 'developer' }));
  const intro = buildContextIntro('alpha');
  assert.match(intro, /<crtr-identity>/, 'opens with an explicit identity block');
  assert.match(intro, /You are node alpha/, 'names the node by its own id');
  assert.match(intro, /kind developer/, 'states the node kind');
  assert.match(
    intro,
    /INHERITED CONTEXT/,
    'disowns any earlier first-person narrative as inherited, not self',
  );
  // The identity block must come BEFORE the <crtr-context> bearings, so it is the
  // first thing the model reads — the orienting frame, not a trailing note.
  assert.ok(
    intro.indexOf('<crtr-identity>') < intro.indexOf('<crtr-context'),
    'identity assertion precedes the context bearings',
  );
});

test('a FORK\'s intro names the source and disowns it (regression: fork acted AS the source)', () => {
  // The source node whose conversation pi copied into the fork.
  createNode(node('src7', { name: 'looking-pi-crouter', description: 'monitor-telemetry' }));
  // The fork: fork_from provenance persisted at spawn.
  createNode(node('fork9', { fork_from: 'src7' }));

  const intro = buildContextIntro('fork9');
  assert.match(intro, /You are node fork9/, 'the fork is told its OWN id');
  assert.match(intro, /You are a FORK of src7/, 'names the fork source explicitly');
  assert.match(intro, /You are NOT src7/, '"you are NOT the source" flag is present');
  // Carries the source's human label so the agent recognizes the copied persona.
  assert.match(intro, /looking-pi-crouter/, 'surfaces the source label');
  // It must NOT tell the fork it is the source node.
  assert.ok(!/You are node src7/.test(intro), 'fork is never told it is the source node');

  // A non-fork sibling gets the identity assertion but NO fork callout.
  createNode(node('plain2'));
  const plain = buildContextIntro('plain2');
  assert.match(plain, /You are node plain2/);
  assert.ok(!/FORK of/.test(plain), 'a fresh (non-fork) node carries no fork callout');
});

test('session_start INJECTS the fork\'s own bearings despite the inherited source block (the misfiring-idempotency bug)', () => {
  createNode(node('srcA'));
  createNode(node('forkB', { fork_from: 'srcA' }));

  // A fork boots with the SOURCE's whole conversation copied in — including the
  // source's <crtr-context> intro entry (which names srcA, not forkB).
  const inheritedSourceBlock = introEntry(buildContextIntro('srcA'));

  process.env['CRTR_NODE_ID'] = 'forkB';
  const pi = makeFakePi();
  registerCanvasContextIntro(pi as never);
  pi.fireSessionStart([inheritedSourceBlock]);

  // The fix: the inherited block belongs to srcA, so it must NOT suppress
  // forkB's own intro. forkB's bearings (with its identity assertion) ARE sent.
  assert.equal(pi.sent.length, 1, 'fork injects its OWN bearings over the inherited source block');
  assert.equal(pi.sent[0].customType, CONTEXT_INTRO_CUSTOM_TYPE);
  assert.match(pi.sent[0].content, /You are node forkB/, 'injected bearings name the fork, not the source');
  assert.match(pi.sent[0].content, /You are a FORK of srcA/, 'injected bearings carry the fork callout');
  // The exact, machine-readable resume discriminator rides along (not sent to
  // the LLM): it names THIS node, so a later resume tells our block apart from
  // any inherited one without depending on prose.
  assert.equal(pi.sent[0].details?.nodeId, 'forkB', 'injected block carries the exact node-id stamp');
});

test('resume idempotency uses the EXACT details stamp, independent of block text (regression hardening)', () => {
  createNode(node('stampD'));

  // A restored block that carries OUR exact stamp but whose TEXT does not mention
  // our id. The old content-substring-only guard would re-inject (and accumulate)
  // here; the exact `details.nodeId` match skips correctly.
  const stampedNoIdInText = {
    type: 'custom_message',
    customType: CONTEXT_INTRO_CUSTOM_TYPE,
    content: '<crtr-context dir="/elsewhere">bearings with no id in the text</crtr-context>',
    details: { nodeId: 'stampD' },
  };

  process.env['CRTR_NODE_ID'] = 'stampD';
  const pi = makeFakePi();
  registerCanvasContextIntro(pi as never);
  pi.fireSessionStart([stampedNoIdInText]);

  assert.equal(pi.sent.length, 0, 'exact details-stamp match skips re-injection even when the text omits the id');
});

test('session_start stays IDEMPOTENT on a genuine resume (our own bearings already present)', () => {
  createNode(node('resumeC'));

  // A `--session` relaunch restores OUR conversation — our own bearings (naming
  // resumeC) are already in history.
  const ownBlock = introEntry(buildContextIntro('resumeC'));

  process.env['CRTR_NODE_ID'] = 'resumeC';
  const pi = makeFakePi();
  registerCanvasContextIntro(pi as never);
  pi.fireSessionStart([ownBlock]);

  assert.equal(pi.sent.length, 0, 'our own bearings already present → no duplicate injection');
});
