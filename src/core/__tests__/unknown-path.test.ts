// Regression tests for unknown-subcommand error recovery hints.
// Run with: node --import tsx/esm --test src/core/__tests__/unknown-path.test.ts
//
// The `next` road sign must name a command that actually exists: the FULL path
// to the deepest matched node, not just its local name. A prior bug emitted
// `crtr inspect -h` (dropping the `pkg` parent) when `crtr pkg inspect bogus` was
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

const inspectBranch = defineBranch({
  name: 'inspect',
  description: 'inspect',
  whenToUse: 'x',
  help: { name: 'inspect', summary: 'inspect' },
  children: [leaf],
});

const pkgBranch = defineBranch({
  name: 'pkg',
  description: 'pkg',
  whenToUse: 'x',
  help: { name: 'pkg', summary: 'pkg' },
  rootEntry: { concept: 'pkg', desc: 'pkg', useWhen: 'x' },
  children: [inspectBranch],
});

const root = defineRoot({
  tagline: 'test runtime',
  globals: [],
  subtrees: [pkgBranch],
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

  test('one-level unknown points at `crtr pkg -h`', () => {
    assert.match(nextHint('pkg', 'bogus'), /Run `crtr pkg -h`/);
  });

  test('two-level unknown points at `crtr pkg inspect -h`, not `crtr inspect -h`', () => {
    const hint = nextHint('pkg', 'inspect', 'bogus');
    assert.match(hint, /Run `crtr pkg inspect -h`/);
    assert.doesNotMatch(hint, /Run `crtr inspect -h`/);
  });

  test('valid children of the matched node are listed', () => {
    assert.match(nextHint('pkg', 'inspect', 'bogus'), /Valid children: search\./);
  });
});
