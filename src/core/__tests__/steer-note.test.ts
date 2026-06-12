// Run: node --import tsx/esm --test src/core/__tests__/steer-note.test.ts
//
// Context-size steering text (canvas-stophook `steerNote`) is keyed on MODE
// first, then LIFECYCLE — NOT on lifecycle alone. The key regression this
// guards: a TERMINAL/ORCHESTRATOR must get roadmap-checkpoint-and-yield
// guidance (it has a roadmap), never the worker "push final" text.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { steerNote } from '../../pi-extensions/canvas-stophook.js';

test('an orchestrator (terminal) is steered to checkpoint roadmap + yield, never push final', () => {
  const msg = steerNote(150_000, 'terminal', 'orchestrator');
  assert.match(msg, /roadmap\.md/, 'points at the roadmap to checkpoint');
  assert.match(msg, /node yield/, 'steers it to yield');
  assert.doesNotMatch(msg, /push final/, 'an orchestrator never finishes with push final');
});

test('an orchestrator (resident) gets the same roadmap/yield steering as a terminal orchestrator', () => {
  const t = steerNote(150_000, 'terminal', 'orchestrator');
  const r = steerNote(150_000, 'resident', 'orchestrator');
  assert.equal(r, t, 'mode drives the message, not lifecycle');
});

test('a terminal BASE worker is steered to yield-or-finish, never at a bare promote', () => {
  const msg = steerNote(170_000, 'terminal', 'base');
  assert.match(msg, /node yield/, 'a base worker is told to yield to continue (which auto-promotes under the hood)');
  assert.match(msg, /push final/, 'and to finish with push final when close');
  assert.doesNotMatch(msg, /node promote/, 'never the heavy "become an orchestrator" framing that bred yield-avoidance');
  assert.doesNotMatch(msg, /roadmap\.md/, 'a base worker has no roadmap.md to checkpoint');
});

test('a resident BASE root is steered to yield-or-wrap-up, never at a bare promote or roadmap', () => {
  const msg = steerNote(150_000, 'resident', 'base');
  assert.match(msg, /node yield/, 'a root growing into a job is told to yield (which auto-promotes)');
  assert.doesNotMatch(msg, /node promote/, 'never the heavy "become an orchestrator" framing');
  assert.doesNotMatch(msg, /roadmap\.md/, 'a root has no roadmap.md to point at');
  assert.doesNotMatch(msg, /push final/, 'a resident node never finishes with push final');
});

test('below the first band there is no nudge boundary issue — pushy escalation kicks in at 185k', () => {
  // Sanity: the orchestrator branch escalates (pushy) at/after 185k.
  const firm = steerNote(150_000, 'terminal', 'orchestrator');
  const pushy = steerNote(185_000, 'terminal', 'orchestrator');
  assert.notEqual(firm, pushy, 'the 185k band reads differently from the 150k band');
  assert.match(pushy, /overflow/i, 'the pushy band warns about overflow');
});
