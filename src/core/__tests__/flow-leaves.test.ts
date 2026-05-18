// Tests for flow subtree leaves (spec new/show/list, plan new/show/list, debug).
// Exercises the argv parsing path for each leaf via parseArgv and verifies
// help.params structure (not help.input).
//
// Run with: node --import tsx/esm --test src/core/__tests__/flow-leaves.test.ts

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgv } from '../command.js';
import { renderLeafArgv } from '../help.js';
import { registerSpec } from '../../commands/spec.js';
import { registerPlan } from '../../commands/plan.js';
import { registerDebug } from '../../commands/debug.js';
import type { LeafDef, BranchDef } from '../command.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLeaf(branch: BranchDef, name: string): LeafDef {
  const leaf = branch.children.find((c) => c.name === name);
  assert.ok(leaf !== undefined, `leaf '${name}' not found in branch`);
  assert.equal(leaf.kind, 'leaf');
  return leaf as LeafDef;
}

// ---------------------------------------------------------------------------
// spec new
// ---------------------------------------------------------------------------

describe('spec new: argv model', () => {
  const specBranch = registerSpec();
  const leaf = getLeaf(specBranch, 'new');

  test('help.params defined', () => {
    assert.ok(leaf.help.params !== undefined);
  });

  test('has positional name param', () => {
    const pos = leaf.help.params!.find((p) => p.kind === 'positional' && p.name === 'name');
    assert.ok(pos !== undefined);
    assert.equal(pos.required, true);
  });

  test('has stdin body param', () => {
    const stdin = leaf.help.params!.find((p) => p.kind === 'stdin' && p.name === 'body');
    assert.ok(stdin !== undefined);
    assert.equal(stdin.required, true);
  });

  test('parseArgv: positional name parsed correctly', async () => {
    const params = leaf.help.params!;
    // Remove stdin param for parse-only test (stdin reads from process.stdin)
    const noStdin = params.filter((p) => p.kind !== 'stdin');
    const result = await parseArgv(noStdin, ['my-spec-name']);
    assert.equal(result['name'], 'my-spec-name');
  });

  test('parseArgv: missing required positional throws', async () => {
    const params = leaf.help.params!.filter((p) => p.kind !== 'stdin');
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('renderLeafArgv renders Input section with positional', () => {
    const out = renderLeafArgv(leaf.help);
    assert.ok(out.includes('Input'));
    assert.ok(out.includes('NAME'));
    assert.ok(out.includes('stdin'));
  });
});

// ---------------------------------------------------------------------------
// spec show
// ---------------------------------------------------------------------------

describe('spec show: argv model', () => {
  const specBranch = registerSpec();
  const leaf = getLeaf(specBranch, 'show');

  test('help.params defined', () => {
    assert.ok(leaf.help.params !== undefined);
  });

  test('parseArgv: positional name', async () => {
    const result = await parseArgv(leaf.help.params!, ['my-spec']);
    assert.equal(result['name'], 'my-spec');
  });

  test('parseArgv: rejects unknown flag', async () => {
    await assert.rejects(
      () => parseArgv(leaf.help.params!, ['my-spec', '--bogus']),
      (err: Error) => { assert.match(err.message, /unknown flag/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// spec list
// ---------------------------------------------------------------------------

describe('spec list: argv model', () => {
  const specBranch = registerSpec();
  const leaf = getLeaf(specBranch, 'list');

  test('help.params defined', () => {
    assert.ok(leaf.help.params !== undefined);
  });

  test('has --scope enum flag', () => {
    const flag = leaf.help.params!.find((p) => p.kind === 'flag' && p.name === 'scope');
    assert.ok(flag !== undefined);
    assert.equal(flag.kind, 'flag');
    if (flag.kind === 'flag') {
      assert.equal(flag.type, 'enum');
      assert.deepEqual(flag.choices, ['user', 'project', 'all']);
    }
  });

  test('has --limit int flag with default 20', () => {
    const flag = leaf.help.params!.find((p) => p.kind === 'flag' && p.name === 'limit');
    assert.ok(flag !== undefined);
    assert.equal(flag.kind, 'flag');
    if (flag.kind === 'flag') {
      assert.equal(flag.type, 'int');
      assert.equal(flag.default, 20);
    }
  });

  test('has --cursor string flag', () => {
    const flag = leaf.help.params!.find((p) => p.kind === 'flag' && p.name === 'cursor');
    assert.ok(flag !== undefined);
  });

  test('parseArgv: --limit 50 parses as integer', async () => {
    const result = await parseArgv(leaf.help.params!, ['--limit', '50']);
    assert.equal(result['limit'], 50);
  });

  test('parseArgv: --scope user parses', async () => {
    const result = await parseArgv(leaf.help.params!, ['--scope', 'user']);
    assert.equal(result['scope'], 'user');
  });

  test('parseArgv: --scope invalid throws', async () => {
    await assert.rejects(
      () => parseArgv(leaf.help.params!, ['--scope', 'invalid']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });

  test('parseArgv: default limit applied when absent', async () => {
    const result = await parseArgv(leaf.help.params!, []);
    assert.equal(result['limit'], 20);
  });

  test('parseArgv: --cursor token', async () => {
    const result = await parseArgv(leaf.help.params!, ['--cursor', 'tok123']);
    assert.equal(result['cursor'], 'tok123');
  });
});

// ---------------------------------------------------------------------------
// plan new
// ---------------------------------------------------------------------------

describe('plan new: argv model', () => {
  const planBranch = registerPlan();
  const leaf = getLeaf(planBranch, 'new');

  test('help.params defined', () => {
    assert.ok(leaf.help.params !== undefined);
  });

  test('has positional name param', () => {
    const pos = leaf.help.params!.find((p) => p.kind === 'positional' && p.name === 'name');
    assert.ok(pos !== undefined);
    assert.equal(pos.required, true);
  });

  test('has stdin body param', () => {
    const stdin = leaf.help.params!.find((p) => p.kind === 'stdin' && p.name === 'body');
    assert.ok(stdin !== undefined);
    assert.equal(stdin.required, true);
  });

  test('has optional --spec flag', () => {
    const flag = leaf.help.params!.find((p) => p.kind === 'flag' && p.name === 'spec');
    assert.ok(flag !== undefined);
    assert.equal(flag.required, false);
  });

  test('parseArgv: positional name and --spec flag', async () => {
    const params = leaf.help.params!.filter((p) => p.kind !== 'stdin');
    const result = await parseArgv(params, ['my-plan', '--spec', 'my-spec']);
    assert.equal(result['name'], 'my-plan');
    assert.equal(result['spec'], 'my-spec');
  });

  test('parseArgv: positional name without --spec', async () => {
    const params = leaf.help.params!.filter((p) => p.kind !== 'stdin');
    const result = await parseArgv(params, ['my-plan']);
    assert.equal(result['name'], 'my-plan');
    assert.equal(result['spec'], undefined);
  });
});

// ---------------------------------------------------------------------------
// plan show
// ---------------------------------------------------------------------------

describe('plan show: argv model', () => {
  const planBranch = registerPlan();
  const leaf = getLeaf(planBranch, 'show');

  test('help.params defined', () => {
    assert.ok(leaf.help.params !== undefined);
  });

  test('parseArgv: positional name', async () => {
    const result = await parseArgv(leaf.help.params!, ['my-plan']);
    assert.equal(result['name'], 'my-plan');
  });
});

// ---------------------------------------------------------------------------
// plan list
// ---------------------------------------------------------------------------

describe('plan list: argv model', () => {
  const planBranch = registerPlan();
  const leaf = getLeaf(planBranch, 'list');

  test('help.params defined', () => {
    assert.ok(leaf.help.params !== undefined);
  });

  test('has --scope, --limit, --cursor flags', () => {
    const names = leaf.help.params!.map((p) => p.name);
    assert.ok(names.includes('scope'));
    assert.ok(names.includes('limit'));
    assert.ok(names.includes('cursor'));
  });

  test('parseArgv: --limit 10 --cursor abc', async () => {
    const result = await parseArgv(leaf.help.params!, ['--limit', '10', '--cursor', 'abc']);
    assert.equal(result['limit'], 10);
    assert.equal(result['cursor'], 'abc');
  });
});

// ---------------------------------------------------------------------------
// debug
// ---------------------------------------------------------------------------

describe('debug: argv model', () => {
  const leaf = registerDebug();

  test('help.params defined', () => {
    assert.ok(leaf.help.params !== undefined);
  });

  test('has stdin steps_to_reproduce param', () => {
    const stdin = leaf.help.params!.find((p) => p.kind === 'stdin' && p.name === 'steps_to_reproduce');
    assert.ok(stdin !== undefined);
    assert.equal(stdin.required, true);
  });

  test('has required --summary flag', () => {
    const flag = leaf.help.params!.find((p) => p.kind === 'flag' && p.name === 'summary');
    assert.ok(flag !== undefined);
    assert.equal(flag.required, true);
    if (flag.kind === 'flag') assert.equal(flag.type, 'string');
  });

  test('has optional --cwd flag of type path', () => {
    const flag = leaf.help.params!.find((p) => p.kind === 'flag' && p.name === 'cwd');
    assert.ok(flag !== undefined);
    assert.equal(flag.required, false);
    if (flag.kind === 'flag') assert.equal(flag.type, 'path');
  });

  test('parseArgv: --summary and --cwd flags (no stdin)', async () => {
    const params = leaf.help.params!.filter((p) => p.kind !== 'stdin');
    const result = await parseArgv(params, ['--summary', 'test fails on startup', '--cwd', '/tmp/project']);
    assert.equal(result['summary'], 'test fails on startup');
    assert.equal(result['cwd'], '/tmp/project');
  });

  test('parseArgv: missing required --summary throws', async () => {
    const params = leaf.help.params!.filter((p) => p.kind !== 'stdin');
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('renderLeafArgv renders --summary and stdin', () => {
    const out = renderLeafArgv(leaf.help);
    assert.ok(out.includes('--summary'));
    assert.ok(out.includes('stdin'));
    assert.ok(out.includes('--cwd'));
  });

  test('stdin name is steps_to_reproduce (underscores, no camelCase transform)', () => {
    // flagNameToKey only converts hyphen segments; underscores are passed through.
    // The handler reads input['steps_to_reproduce'], not input['stepsToReproduce'].
    const stdin = leaf.help.params!.find((p) => p.kind === 'stdin');
    assert.equal(stdin?.name, 'steps_to_reproduce');
  });
});
