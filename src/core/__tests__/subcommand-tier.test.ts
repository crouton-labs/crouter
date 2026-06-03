// Tests for the subcommand visibility tier (hidden | normal | common | important)
// and the "[+N subcommands]" affordance.
// Run with: node --import tsx/esm --test src/core/__tests__/subcommand-tier.test.ts
//
// Contract:
//  - renderRoot promotes a subtree's `important` children (name + shortform
//    desc) and `common` children (bare qualified path) into that command's
//    block, then names how many other non-hidden subcommands stay behind
//    `crtr <name> -h`.
//  - `hidden` children never appear (not even in the subtree's own -h) and are
//    not counted in any "[+N]" remainder.
//  - renderBranch drops hidden children and flags branch children that own
//    subcommands with "[+N subcommands]".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defineRoot, defineBranch, defineLeaf } from '../command.js';
import { renderRoot, renderBranch } from '../help.js';

const leaf = (name: string) =>
  defineLeaf({
    name,
    help: { name, summary: name, output: [], outputKind: 'object', effects: ['None. Read-only.'] },
    run: async () => ({}),
  });

// A nested branch so we can assert the "[+N subcommands]" depth flag.
const inspect = defineBranch({
  name: 'inspect',
  help: {
    name: 'thing inspect',
    summary: 'inspect',
    children: [
      { name: 'list', desc: 'list', useWhen: 'x' },
      { name: 'show', desc: 'show', useWhen: 'x' },
    ],
  },
  children: [leaf('list'), leaf('show')],
});

const thing = defineBranch({
  name: 'thing',
  rootEntry: { concept: 'a thing', desc: 'things', useWhen: 'doing things' },
  help: {
    name: 'thing',
    summary: 'do things',
    children: [
      { name: 'make', desc: 'make a thing', useWhen: 'x', tier: 'important' },
      { name: 'promote', desc: 'promote a thing', useWhen: 'x', tier: 'common' },
      { name: 'inspect', desc: 'inspect things', useWhen: 'x' },
      { name: 'secret', desc: 'secret op', useWhen: 'x', tier: 'hidden' },
      { name: 'plain', desc: 'plain op', useWhen: 'x' },
    ],
  },
  children: [leaf('make'), leaf('promote'), inspect, leaf('secret'), leaf('plain')],
});

const root = defineRoot({ tagline: 'test runtime', globals: [], subtrees: [thing] });

describe('renderRoot: subcommand promotion', () => {
  const out = renderRoot(root.help);

  test('important child surfaces with its shortform desc', () => {
    assert.match(out, /\n {2}thing make {2,}make a thing\n/);
  });

  test('common child surfaces as a bare qualified path (no desc)', () => {
    assert.match(out, /\n {2}thing promote\n/);
    assert.doesNotMatch(out, /thing promote {2,}promote a thing/);
  });

  test('hidden child is never promoted and not counted', () => {
    assert.doesNotMatch(out, /secret/);
    // 5 children, 1 hidden => 4 listable, 2 promoted => 2 remaining.
    assert.match(out, /\[\+2 other subcommands — `crtr thing -h`\]/);
  });
});

describe('renderRoot: commands with no promotions', () => {
  test('still advertise their subcommand count', () => {
    const bare = defineBranch({
      name: 'bare',
      rootEntry: { concept: 'bare', desc: 'bare', useWhen: 'x' },
      help: { name: 'bare', summary: 'bare', children: [{ name: 'one', desc: 'one', useWhen: 'x' }] },
      children: [leaf('one')],
    });
    const r = defineRoot({ tagline: 't', globals: [], subtrees: [bare] });
    const out = renderRoot(r.help);
    assert.match(out, /\[\+1 subcommand — `crtr bare -h`\]/); // singular, no "other"
  });
});

describe('renderBranch: hidden filter + depth flag', () => {
  const out = renderBranch(thing.help);

  test('hidden child is dropped from the branch listing', () => {
    assert.doesNotMatch(out, /secret/);
  });

  test('all non-hidden children are listed', () => {
    for (const n of ['make', 'promote', 'inspect', 'plain']) {
      assert.match(out, new RegExp(`\\n {2}${n} `));
    }
  });

  test('a branch child flags how many subcommands it owns', () => {
    assert.match(out, /inspect .* \[\+2 subcommands\]/);
  });

  test('leaf children carry no subcommand flag', () => {
    assert.doesNotMatch(out, /make .* \[\+\d+ subcommands\]/);
  });
});
