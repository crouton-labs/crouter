// Bug-regression: guards the hard cut that merged the substrate's `when`/`why`
// frontmatter pair into the single `when-and-why-to-read` read-routing field.
// The CTO ruling (taste/why-field-means-why-to-read) requires the migration be
// a hard cut: an old-shape doc must FAIL at `crtr memory lint`, never be read at
// runtime. `lintSubstrateSchema` is that enforcement seam — these lock it.
//
// Run: node --import tsx/esm --test src/commands/memory/__tests__/lint-schema.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintSubstrateSchema } from '../lint.js';

const ROUTING = 'When you are X, this reference should be read because Y';

test('lint rejects a doc still carrying the retired `when` key', () => {
  const err = lintSubstrateSchema({ kind: 'reference', when: 'when X' });
  assert.ok(err !== null, 'old-shape `when` must produce a finding');
  assert.match(err, /when-and-why-to-read/, 'the message points at the new field');
});

test('lint rejects a doc still carrying the retired `why` key', () => {
  const err = lintSubstrateSchema({ kind: 'reference', why: 'because Y' });
  assert.ok(err !== null, 'old-shape `why` must produce a finding');
  assert.match(err, /when-and-why-to-read/, 'the message points at the new field');
});

test('lint rejects a substrate doc missing the merged routing field', () => {
  const err = lintSubstrateSchema({ kind: 'reference' });
  assert.ok(err !== null, 'a substrate doc must carry when-and-why-to-read');
  assert.match(err, /when-and-why-to-read/);
});

test('lint accepts the merged new-shape frontmatter', () => {
  assert.equal(lintSubstrateSchema({ kind: 'reference', 'when-and-why-to-read': ROUTING }), null);
});
