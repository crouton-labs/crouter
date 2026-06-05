// Tests for the subcommand visibility tier (hidden | normal | common | important)
// and the parent-level listing affordance.
// Run with: node --import tsx/esm --test src/core/__tests__/subcommand-tier.test.ts
//
// Contract:
//  - Each child def (defineLeaf/defineBranch) owns its own description /
//    whenToUse / tier; defineBranch assembles `help.listing` from those defs —
//    the parent never copies a child's self-description (principle 16).
//  - renderRoot promotes a subtree's `important` children (name + shortform
//    desc) and `common` children (bare qualified path) into that command's
//    block, then names how many other non-hidden subcommands stay behind
//    `crtr <name> -h`.
//  - `hidden` children never appear (not even in the subtree's own -h) and are
//    not counted in any "[+N]" remainder.
//  - renderBranch renders one self-closing <subcommand> per non-hidden child
//    and adds a `subcommands="N"` attribute when a branch child owns children.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { defineRoot, defineBranch, defineLeaf } from '../command.js';
import { renderRoot, renderBranch } from '../help.js';
import type { SubTier } from '../help.js';

const leaf = (
  name: string,
  opts: { description?: string; whenToUse?: string; tier?: SubTier } = {},
) =>
  defineLeaf({
    name,
    description: opts.description,
    whenToUse: opts.whenToUse,
    tier: opts.tier,
    help: { name, summary: name, output: [], outputKind: 'object', effects: ['None. Read-only.'] },
    run: async () => ({}),
  });

// A nested branch so we can assert the `subcommands="N"` depth flag. Its own
// parent-level self-description (description/whenToUse) lives on the def, as a
// sibling of `name`.
const inspect = defineBranch({
  name: 'inspect',
  description: 'inspect things',
  whenToUse: 'x',
  help: { name: 'thing inspect', summary: 'inspect' },
  children: [
    leaf('list', { description: 'list', whenToUse: 'x' }),
    leaf('show', { description: 'show', whenToUse: 'x' }),
  ],
});

const thing = defineBranch({
  name: 'thing',
  rootEntry: { concept: 'a thing', desc: 'things', useWhen: 'doing things' },
  help: { name: 'thing', summary: 'do things' },
  children: [
    leaf('make', { description: 'make a thing', whenToUse: 'x', tier: 'important' }),
    leaf('promote', { description: 'promote a thing', whenToUse: 'x', tier: 'common' }),
    inspect,
    leaf('secret', { description: 'secret op', whenToUse: 'x', tier: 'hidden' }),
    leaf('plain', { description: 'plain op', whenToUse: 'x' }),
  ],
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
      help: { name: 'bare', summary: 'bare' },
      children: [leaf('one', { description: 'one', whenToUse: 'x' })],
    });
    const r = defineRoot({ tagline: 't', globals: [], subtrees: [bare] });
    const out = renderRoot(r.help);
    assert.match(out, /\[\+1 subcommand — `crtr bare -h`\]/); // singular, no "other"
  });
});

describe('renderBranch: hidden filter + depth flag (XML)', () => {
  const out = renderBranch(thing.help);

  test('hidden child is dropped from the branch listing', () => {
    assert.doesNotMatch(out, /secret/);
  });

  test('all non-hidden children are listed as <subcommand> rows', () => {
    for (const n of ['make', 'promote', 'inspect', 'plain']) {
      assert.match(out, new RegExp(`name="${n}"`));
    }
  });

  test('a branch child flags how many subcommands it owns', () => {
    assert.match(out, /name="inspect"[^>]*subcommands="2"/);
  });

  test('leaf children carry no subcommand flag', () => {
    assert.doesNotMatch(out, /name="make"[^>]*subcommands=/);
  });
});
