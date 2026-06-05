// Regression tests for unknown-subcommand error recovery hints.
// Run with: node --import tsx/esm --test src/core/__tests__/unknown-path.test.ts
//
// The `next` road sign must name a command that actually exists: the FULL path
// to the deepest matched node, not just its local name. A prior bug emitted
// `crtr find -h` (dropping the `skill` parent) when `crtr skill find bogus` was
// invoked, sending the caller to a nonexistent top-level command.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defineRoot, defineBranch, defineLeaf, walk, unknownPathError } from '../command.js';

const leaf = defineLeaf({
  name: 'search',
  description: 'search',
  whenToUse: 'x',
  help: { name: 'search', summary: 'search', output: [], outputKind: 'object', effects: ['None. Read-only.'] },
  run: async () => ({}),
});

const findBranch = defineBranch({
  name: 'find',
  description: 'find',
  whenToUse: 'x',
  help: { name: 'find', summary: 'find' },
  children: [leaf],
});

const skillBranch = defineBranch({
  name: 'skill',
  description: 'skill',
  whenToUse: 'x',
  help: { name: 'skill', summary: 'skill' },
  rootEntry: { concept: 'skill', desc: 'skill', useWhen: 'x' },
  children: [findBranch],
});

const root = defineRoot({
  tagline: 'test runtime',
  globals: [],
  subtrees: [skillBranch],
});

function nextHint(...tokens: string[]): string {
  const { node, path, remaining } = walk(root, tokens);
  const err = unknownPathError(node, path, remaining[0]);
  return (err.details as { next: string }).next;
}

describe('unknown-path error: recovery hint names the full valid path', () => {
  test('root-level unknown points at `crtr -h`', () => {
    assert.match(nextHint('bogus'), /Run `crtr -h`/);
  });

  test('one-level unknown points at `crtr skill -h`', () => {
    assert.match(nextHint('skill', 'bogus'), /Run `crtr skill -h`/);
  });

  test('two-level unknown points at `crtr skill find -h`, not `crtr find -h`', () => {
    const hint = nextHint('skill', 'find', 'bogus');
    assert.match(hint, /Run `crtr skill find -h`/);
    assert.doesNotMatch(hint, /Run `crtr find -h`/);
  });

  test('valid children of the matched node are listed', () => {
    assert.match(nextHint('skill', 'find', 'bogus'), /Valid children: search\./);
  });
});
