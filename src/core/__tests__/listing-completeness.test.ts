// Completeness guard for the assembled parent-level listings.
// Run with: node --import tsx/esm --test src/core/__tests__/listing-completeness.test.ts
//
// Each non-hidden child surfaced in a branch's `help.listing` must carry a real
// self-description: both `description` and `whenToUse` non-empty. The listing is
// assembled by defineBranch from the child defs, so a blank attribute here means
// a child def forgot to declare its description/whenToUse. Walks the whole live
// command tree (buildRoot) so every shipped subtree is covered.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRoot } from '../../build-root.js';
import type { BranchDef } from '../command.js';

test('every non-hidden listing child declares description + whenToUse', () => {
  const root = buildRoot();
  const missing: string[] = [];

  const walk = (branch: BranchDef, path: string): void => {
    for (const child of branch.help.listing ?? []) {
      if (child.tier === 'hidden') continue;
      if (child.description.trim() === '' || child.whenToUse.trim() === '') {
        missing.push(`${path} ${child.name}: empty description/whenToUse`);
      }
    }
    for (const child of branch.children) {
      if (child.kind === 'branch') walk(child, `${path} ${child.name}`);
    }
  };

  for (const subtree of root.subtrees) walk(subtree, subtree.name);

  assert.deepEqual(
    missing,
    [],
    `listing children missing self-description:\n${missing.join('\n')}`,
  );
});
