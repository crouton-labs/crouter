// Run: node --import tsx/esm --test src/core/__tests__/persona-compose.test.ts
//
// The static system-prompt composer (core/personas/resolve.ts) varies the
// runtime protocol on TWO axes beyond kind×mode:
//   • lifecycle (terminal | resident) — the "how you end" contract.
//   • spine position (hasManager) — whether the push-up family is taught AT ALL.
// These assert the four corners, especially the resident+no-manager root that
// must never hear about `push` (final OR update).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolve } from '../personas/index.js';

// The lifecycle fragment is identified by its signature contract phrase, not by
// the raw "push final" substring — the resident fragment legitimately NAMES
// `push final` only to forbid it. The kind body is now lifecycle-neutral, so the
// only finish contract in the prompt is whichever fragment composed.
const TERMINAL_CONTRACT = /owe a final result and you reap when done/i;
const RESIDENT_CONTRACT = /never forced to submit a final result/i;
const PUSH_UP = /crtr push (update|urgent)/i;

test('terminal + has-manager (the default child worker): terminal finish + push up', () => {
  const p = resolve('general', 'base', { lifecycle: 'terminal', hasManager: true });
  assert.match(p.systemPrompt, TERMINAL_CONTRACT, 'a terminal node owes a final and finishes via push final');
  assert.doesNotMatch(p.systemPrompt, RESIDENT_CONTRACT);
  assert.match(p.systemPrompt, PUSH_UP, 'a managed node reports up via push update/urgent');
  assert.equal(p.lifecycle, 'terminal');
});

test('resident + no-manager (the user-facing root): resident finish, and NO push-up family at all', () => {
  const p = resolve('general', 'base', { lifecycle: 'resident', hasManager: false });
  assert.match(p.systemPrompt, RESIDENT_CONTRACT, 'a resident root is never forced to submit');
  assert.doesNotMatch(p.systemPrompt, TERMINAL_CONTRACT, 'it does not get the terminal finish contract');
  assert.doesNotMatch(p.systemPrompt, PUSH_UP, 'a top-of-spine root has nobody to push up to');
  assert.match(p.systemPrompt, /top of your spine/i, 'oriented as top-of-spine');
  assert.match(p.systemPrompt, /dormant/i, 'told it goes dormant and wakes');
});

test('resident + has-manager (interactable sub-orchestrator): resident finish, but still push up', () => {
  const p = resolve('general', 'base', { lifecycle: 'resident', hasManager: true });
  assert.match(p.systemPrompt, RESIDENT_CONTRACT, 'resident is never forced to submit a final');
  assert.doesNotMatch(p.systemPrompt, TERMINAL_CONTRACT);
  assert.match(p.systemPrompt, PUSH_UP, 'still reports progress up to its manager');
});

test('terminal + no-manager (a terminal root): terminal finish, but no push up', () => {
  const p = resolve('general', 'base', { lifecycle: 'terminal', hasManager: false });
  assert.match(p.systemPrompt, TERMINAL_CONTRACT, 'terminal still finishes via push final (self-completes)');
  assert.doesNotMatch(p.systemPrompt, PUSH_UP, 'nobody subscribes, so no report-up family');
});

test('the lifecycle-neutral base survives in every corner (delegate + human ask)', () => {
  for (const hasManager of [true, false]) {
    for (const lifecycle of ['terminal', 'resident'] as const) {
      const p = resolve('general', 'base', { lifecycle, hasManager });
      assert.match(p.systemPrompt, /crtr node new/, `delegate verb present (${lifecycle}/${hasManager})`);
      assert.match(p.systemPrompt, /crtr human ask/, `human-ask present (${lifecycle}/${hasManager})`);
    }
  }
});
