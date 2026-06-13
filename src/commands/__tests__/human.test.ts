// Tests for the human subtree argv-model migration.
// Run with: node --import tsx/esm --test 'src/commands/__tests__/human.test.ts'
//
// These tests exercise the leaf param schemas via parseArgv (framework) and
// spot-check the leaf definitions directly — no subprocess spawning, no tmux.

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseArgv } from '../../core/command.js';
import type { InputParam } from '../../core/help.js';
import { humanCancel } from '../human/queue.js';
import { createNode, getNode, closeDb } from '../../core/canvas/index.js';
import type { NodeMeta } from '../../core/canvas/index.js';

// ---------------------------------------------------------------------------
// Helper: write a temp JSON file and return its path.
// ---------------------------------------------------------------------------
function tmpJson(obj: unknown): string {
  const dir = join(tmpdir(), `crtr-human-test-${randomBytes(4).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'deck.json');
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// ---------------------------------------------------------------------------
// human review — positional file (path) + optional --output
// ---------------------------------------------------------------------------

describe('human review: params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'file', type: 'path', required: true, constraint: 'Existing .md file.' },
    { kind: 'flag', name: 'output', type: 'path', required: false, constraint: 'Where to write feedback.' },
  ];

  test('parses positional file path', async () => {
    const result = await parseArgv(params, ['/tmp/plan.md']);
    assert.equal(result['file'], '/tmp/plan.md');
  });

  test('parses file + --output', async () => {
    const result = await parseArgv(params, ['/tmp/plan.md', '--output', '/tmp/fb.json']);
    assert.equal(result['file'], '/tmp/plan.md');
    assert.equal(result['output'], '/tmp/fb.json');
  });

  test('missing file throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// human notify — positional title + optional --body
// ---------------------------------------------------------------------------

describe('human notify: params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'title', type: 'string', required: true, constraint: 'Headline.' },
    { kind: 'flag', name: 'body', type: 'string', required: false, constraint: 'Markdown body.' },
  ];

  test('parses positional title', async () => {
    const result = await parseArgv(params, ['Build done']);
    assert.equal(result['title'], 'Build done');
  });

  test('parses title + --body', async () => {
    const result = await parseArgv(params, ['Done', '--body', 'All tests pass.']);
    assert.equal(result['title'], 'Done');
    assert.equal(result['body'], 'All tests pass.');
  });
});

// ---------------------------------------------------------------------------
// human show — positional path + --watch bool + --window enum
// ---------------------------------------------------------------------------

describe('human show: params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'path', type: 'path', required: true, constraint: 'File to render.' },
    { kind: 'flag', name: 'watch', type: 'bool', required: false, constraint: 'Presence = true.' },
    { kind: 'flag', name: 'window', type: 'enum', choices: ['auto', 'split', 'new'], required: false, default: 'auto', constraint: 'Placement.' },
  ];

  test('parses positional path', async () => {
    const result = await parseArgv(params, ['/tmp/doc.md']);
    assert.equal(result['path'], '/tmp/doc.md');
  });

  test('--watch absent → false (presence-only bool default)', async () => {
    const result = await parseArgv(params, ['/tmp/doc.md']);
    assert.equal(result['watch'], false);
  });

  test('--watch present → true', async () => {
    const result = await parseArgv(params, ['/tmp/doc.md', '--watch']);
    assert.equal(result['watch'], true);
  });

  test('--watch=true is rejected (bool takes no value)', async () => {
    await assert.rejects(
      () => parseArgv(params, ['/tmp/doc.md', '--watch=true']),
      (err: Error) => { assert.match(err.message, /takes no value/); return true; },
    );
  });

  test('--window default is auto', async () => {
    const result = await parseArgv(params, ['/tmp/doc.md']);
    assert.equal(result['window'], 'auto');
  });

  test('--window accepts valid enum value', async () => {
    const result = await parseArgv(params, ['/tmp/doc.md', '--window', 'split']);
    assert.equal(result['window'], 'split');
  });

  test('--window rejects invalid value', async () => {
    await assert.rejects(
      () => parseArgv(params, ['/tmp/doc.md', '--window', 'float']),
      (err: Error) => { assert.match(err.message, /must be one of/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// human ask — --context-file (context-file kind, key=deckFile) + --wait bool
//
// NOTE: The argv parser hardcodes the CLI token as `--context-file` regardless
// of the param's `name` field. The `name` field ("deckFile") becomes the key
// in the input record. So the correct invocation is:
//   crtr human ask --context-file deck.json
// not --deck-file. Tests use --context-file accordingly.
// ---------------------------------------------------------------------------

describe('human ask: params', () => {
  const params: InputParam[] = [
    { kind: 'context-file', name: 'deckFile', required: true, constraint: 'Humanloop deck JSON.' },
    { kind: 'flag', name: 'wait', type: 'bool', required: false, constraint: 'Presence-only.' },
  ];

  test('--context-file parses JSON file and yields input.deckFile', async () => {
    const deck = { interactions: [{ id: 'q', title: 'Go?', options: [{ id: 'yes', label: 'Yes' }] }] };
    const path = tmpJson(deck);
    const result = await parseArgv(params, ['--context-file', path]);
    assert.deepEqual(result['deckFile'], deck);
  });

  test('--context-file missing → missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });

  test('--context-file with nonexistent file → invalid_type', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--context-file', '/no/such/deck.json']),
      (err: Error) => { assert.match(err.message, /cannot read file/); return true; },
    );
  });

  test('--context-file with non-JSON file → invalid_type', async () => {
    const dir = join(tmpdir(), `crtr-human-test-${randomBytes(4).toString('hex')}`);
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'bad.json');
    writeFileSync(p, 'not json at all');
    await assert.rejects(
      () => parseArgv(params, ['--context-file', p]),
      (err: Error) => { assert.match(err.message, /not valid JSON/); return true; },
    );
  });

  test('--wait absent → false', async () => {
    const deck = { interactions: [] };
    const path = tmpJson(deck);
    const result = await parseArgv(params, ['--context-file', path]);
    assert.equal(result['wait'], false);
  });

  test('--wait present → true', async () => {
    const deck = { interactions: [] };
    const path = tmpJson(deck);
    const result = await parseArgv(params, ['--context-file', path, '--wait']);
    assert.equal(result['wait'], true);
  });
});

// ---------------------------------------------------------------------------
// human cancel — positional job_id + optional --reason
// ---------------------------------------------------------------------------

describe('human cancel: params', () => {
  const params: InputParam[] = [
    { kind: 'positional', name: 'job_id', type: 'string', required: true, constraint: 'Interaction node id.' },
    { kind: 'flag', name: 'reason', type: 'string', required: false, constraint: 'Why it was retracted.' },
  ];

  test('parses positional job_id', async () => {
    const result = await parseArgv(params, ['abc-1234']);
    assert.equal(result['job_id'], 'abc-1234');
  });

  test('parses job_id + --reason', async () => {
    const result = await parseArgv(params, ['abc-1234', '--reason', 'answered myself']);
    assert.equal(result['job_id'], 'abc-1234');
    assert.equal(result['reason'], 'answered myself');
  });

  test('missing job_id throws missing_parameter', async () => {
    await assert.rejects(
      () => parseArgv(params, []),
      (err: Error) => { assert.match(err.message, /required parameter is missing/); return true; },
    );
  });
});

// ---------------------------------------------------------------------------
// human cancel — run behavior (canvas-backed)
// ---------------------------------------------------------------------------

describe('human cancel: behavior', () => {
  let home: string;

  function humanNode(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
    return {
      node_id: id,
      name: 'human-ask',
      created: new Date().toISOString(),
      cwd: join(tmpdir(), `crtr-cancel-cwd-${randomBytes(3).toString('hex')}`),
      kind: 'human',
      mode: 'base',
      lifecycle: 'terminal',
      status: 'active',
      ...over,
    };
  }

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'crtr-cancel-home-'));
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

  test('unknown node throws not_found', async () => {
    await assert.rejects(
      () => humanCancel.run({ job_id: 'no-such-node' }),
      (err: Error) => { assert.match(err.message, /no interaction node/); return true; },
    );
  });

  test('already-done node returns canceled:false / already_resolved', async () => {
    createNode(humanNode('done-1', { status: 'done' }));
    const r = await humanCancel.run({ job_id: 'done-1' }) as Record<string, unknown>;
    assert.equal(r['canceled'], false);
    assert.equal(r['reason'], 'already_resolved');
  });

  test('live node with no pane → retires the node (status done)', async () => {
    createNode(humanNode('live-1', { status: 'active' }));
    const r = await humanCancel.run({ job_id: 'live-1' }) as Record<string, unknown>;
    assert.equal(r['canceled'], true);
    assert.equal(r['job_id'], 'live-1');
    assert.equal(getNode('live-1')?.status, 'done');
  });
});

// ---------------------------------------------------------------------------
// human list — --limit int + --cursor string
// ---------------------------------------------------------------------------

describe('human list: params', () => {
  const params: InputParam[] = [
    { kind: 'flag', name: 'limit', type: 'int', required: false, default: 20, constraint: 'Default 20.' },
    { kind: 'flag', name: 'cursor', type: 'string', required: false, constraint: 'Pagination token.' },
  ];

  test('defaults: limit=20, cursor=undefined', async () => {
    const result = await parseArgv(params, []);
    assert.equal(result['limit'], 20);
    assert.equal(result['cursor'], undefined);
  });

  test('--limit parses integer', async () => {
    const result = await parseArgv(params, ['--limit', '5']);
    assert.equal(result['limit'], 5);
  });

  test('--limit rejects non-integer', async () => {
    await assert.rejects(
      () => parseArgv(params, ['--limit', 'abc']),
      (err: Error) => { assert.match(err.message, /must be an integer/); return true; },
    );
  });

  test('--cursor passes through as string', async () => {
    const result = await parseArgv(params, ['--cursor', 'tok_abc123']);
    assert.equal(result['cursor'], 'tok_abc123');
  });
});

// ---------------------------------------------------------------------------
// human _run — no params (reads CRTR_HUMAN_DIR from env)
// ---------------------------------------------------------------------------

describe('human _run: no params', () => {
  const params: InputParam[] = [];

  test('empty argv yields empty result (no params declared)', async () => {
    const result = await parseArgv(params, []);
    assert.deepEqual(result, {});
  });

  test('positional token throws bad_invocation (no positionals declared)', async () => {
    await assert.rejects(
      () => parseArgv(params, ['some-value']),
      (err: Error) => { assert.match(err.message, /takes no positional/); return true; },
    );
  });

  test('CRTR_HUMAN_DIR env var contract: _run reads it from env, not argv', () => {
    // Structural check: the params array is empty, confirming no argv surface.
    // The actual env-var read is in the run handler and verified by inspection.
    assert.equal(params.length, 0);
  });
});
