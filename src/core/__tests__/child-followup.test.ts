import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { jobDir } from '../canvas/paths.js';
import { readContextTokens } from '../canvas/telemetry.js';
import type { NodeMeta } from '../canvas/types.js';
import { childFollowUp } from '../../commands/node.js';

let home: string;

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: '/tmp/work',
    kind: 'general',
    mode: 'base',
    lifecycle: 'terminal',
    status: 'active',
    ...over,
  };
}

/** Write a telemetry.json with a live context gauge for a node. */
function writeTelemetry(id: string, over: Record<string, unknown>): void {
  const dir = jobDir(id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'telemetry.json'), JSON.stringify({ tokens_in: 0, tokens_out: 0, model: 'm', updated_at: new Date().toISOString(), ...over }));
}

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-followup-'));
  process.env['CRTR_HOME'] = home;
});

beforeEach(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
  delete process.env['CRTR_HOME'];
});

const STD = 'Two moves only';
const YIELD = 'crtr node yield';

test('readContextTokens: prefers context_tokens, falls back to tokens_in, else null', () => {
  createNode(node('n1'));
  writeTelemetry('n1', { context_tokens: 120_000, tokens_in: 5_000 });
  assert.equal(readContextTokens('n1'), 120_000);

  createNode(node('n2'));
  writeTelemetry('n2', { tokens_in: 42_000 });
  assert.equal(readContextTokens('n2'), 42_000);

  createNode(node('n3'));
  assert.equal(readContextTokens('n3'), null); // no telemetry at all
});

test('childFollowUp: orchestrator past 100k → yield nudge with rounded k', () => {
  createNode(node('orch', { mode: 'orchestrator' }));
  writeTelemetry('orch', { context_tokens: 134_500 });
  const msg = childFollowUp('orch');
  assert.match(msg, /crtr node yield/);
  assert.match(msg, /~135k/); // rounded
  assert.doesNotMatch(msg, /Two moves only/);
});

test('childFollowUp: orchestrator below 100k → standard road sign', () => {
  createNode(node('orch', { mode: 'orchestrator' }));
  writeTelemetry('orch', { context_tokens: 80_000 });
  assert.match(childFollowUp('orch'), new RegExp(STD));
  assert.doesNotMatch(childFollowUp('orch'), new RegExp(YIELD));
});

test('childFollowUp: base spawner past 100k → standard (only orchestrators yield)', () => {
  createNode(node('base', { mode: 'base' }));
  writeTelemetry('base', { context_tokens: 150_000 });
  assert.match(childFollowUp('base'), new RegExp(STD));
});

test('childFollowUp: orchestrator with no telemetry → standard (unknown size)', () => {
  createNode(node('orch', { mode: 'orchestrator' }));
  assert.match(childFollowUp('orch'), new RegExp(STD));
});

test('childFollowUp: missing / undefined spawner → standard', () => {
  assert.match(childFollowUp(undefined), new RegExp(STD));
  assert.match(childFollowUp(''), new RegExp(STD));
  assert.match(childFollowUp('ghost'), new RegExp(STD)); // no such node
});
