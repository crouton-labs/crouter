// Run: node --import tsx/esm --test src/core/__tests__/persona-subkind.test.ts
//
// Scoped persona sub-personas: a kind has specialist reviewer personas at
// `<kind>/reviewers/<name>/PERSONA.md`, enumerated by `subPersonasFor(kind)` and
// rendered into that kind's composed prompt (and nowhere else) by `resolve`.
// Visibility = membership (the sub-persona's `availableTo`, default = its
// top-level ancestor kind): only `plan` sees the `plan/reviewers/*` menu; the
// `reviewers/` grouping dir is transparent so the kind string keeps it; the
// sub-personas never pollute the global `availableKinds()` list; and a
// sub-persona itself boots as a real composed persona with the terminal finish
// contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolve } from '../personas/resolve.js';
import { subPersonasFor, availableKinds } from '../personas/loader.js';

const PLAN_REVIEWER_KINDS = [
  'plan/reviewers/architecture-fit',
  'plan/reviewers/code-smells',
  'plan/reviewers/pattern-consistency',
  'plan/reviewers/requirements-coverage',
  'plan/reviewers/security',
];

const MENU_HEADER = 'Sub-personas you may spawn';

test('subPersonasFor("plan") returns the five reviewers sorted, each with a non-empty whenToUse', () => {
  const subs = subPersonasFor('plan');
  assert.deepEqual(
    subs.map((s) => s.kind),
    PLAN_REVIEWER_KINDS,
    'the five plan reviewer kind strings in sorted order — the transparent reviewers/ dir keeps the full kind path',
  );
  for (const s of subs) {
    assert.ok(s.whenToUse.length > 0, `${s.kind} carries a non-empty whenToUse`);
  }
});

test('availability is membership: a kind with no available sub-personas yields []', () => {
  assert.deepEqual(subPersonasFor('explore'), [], 'no sub-persona is availableTo explore');
  assert.deepEqual(
    subPersonasFor('plan/reviewers/security'),
    [],
    'the five reviewers default availableTo:[plan] — none are available to a reviewer kind',
  );
});

test('availableKinds() contains no plan/reviewers/* — sub-personas never pollute the global list', () => {
  const kinds = availableKinds();
  for (const k of PLAN_REVIEWER_KINDS) {
    assert.ok(!kinds.includes(k), `${k} must not appear in availableKinds()`);
  }
  assert.ok(!kinds.some((k) => k.includes('reviewers')), 'no kind contains "reviewers"');
});

test('resolve(plan, orchestrator) renders the menu with all five reviewer strings', () => {
  const p = resolve('plan', 'orchestrator', { lifecycle: 'terminal', hasManager: true });
  assert.match(p.systemPrompt, new RegExp(MENU_HEADER), 'the menu header is present');
  for (const k of PLAN_REVIEWER_KINDS) {
    assert.ok(p.systemPrompt.includes(k), `menu lists ${k}`);
  }
});

test('resolve(plan, base) ALSO renders the menu (render-for-both decision)', () => {
  const p = resolve('plan', 'base', { lifecycle: 'terminal', hasManager: true });
  assert.match(p.systemPrompt, new RegExp(MENU_HEADER), 'a base plan node sees the roster too');
  for (const k of PLAN_REVIEWER_KINDS) {
    assert.ok(p.systemPrompt.includes(k), `menu lists ${k}`);
  }
});

test('resolve(general, orchestrator) does NOT render the menu (visibility = membership)', () => {
  const p = resolve('general', 'orchestrator', { lifecycle: 'terminal', hasManager: true });
  assert.doesNotMatch(p.systemPrompt, new RegExp(MENU_HEADER), 'general owns no roster, so no menu');
});

test('a reviewer sub-kind boots as a real composed persona with the terminal finish contract and no menu', () => {
  const p = resolve('plan/reviewers/security', 'base', { lifecycle: 'terminal', hasManager: true });
  assert.ok(
    p.systemPrompt.includes('concrete exploit path'),
    'the security-reviewer lens expertise is present',
  );
  assert.match(
    p.systemPrompt,
    /owe a final result and you reap when done/i,
    'the terminal finish contract composed in — it boots as a real persona',
  );
  assert.doesNotMatch(
    p.systemPrompt,
    new RegExp(MENU_HEADER),
    'a sub-kind owns no roster of its own — it renders no menu',
  );
});
