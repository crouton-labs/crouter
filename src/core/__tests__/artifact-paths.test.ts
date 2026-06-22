import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { artifactsRoot, interactionsRoot, migrateLegacyWorkspaceDirs, workspaceRoot } from '../artifact.js';

let home: string;
let origHome: string | undefined;

before(() => {
  home = mkdtempSync(join(tmpdir(), 'crtr-workspaces-'));
  origHome = process.env['HOME'];
  process.env['HOME'] = home;
});

beforeEach(() => {
  rmSync(home, { recursive: true, force: true });
  mkdirSync(join(home, '.crouter'), { recursive: true });
});

after(() => {
  rmSync(home, { recursive: true, force: true });
  if (origHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = origHome;
});

test('workspace roots live under ~/.crouter/workspaces/<mangled-cwd>', () => {
  const cwd = '/Users/silasrhyneer/Code/cli/crouter';
  const root = join(home, '.crouter', 'workspaces', '-Users-silasrhyneer-Code-cli-crouter');
  assert.equal(workspaceRoot(cwd), root);
  assert.equal(artifactsRoot('plans', cwd), join(root, 'plans'));
  assert.equal(interactionsRoot(cwd), join(root, 'interactions'));
});

test('migrateLegacyWorkspaceDirs moves only legacy mangled cwd dirs', () => {
  const legacy = join(home, '.crouter', '-Users-silasrhyneer-Code-cli-crouter');
  const workspace = join(home, '.crouter', 'workspaces', '-Users-silasrhyneer-Code-cli-crouter');
  const memory = join(home, '.crouter', 'memory');
  const canvas = join(home, '.crouter', 'canvas');

  mkdirSync(legacy, { recursive: true });
  mkdirSync(memory, { recursive: true });
  mkdirSync(canvas, { recursive: true });

  migrateLegacyWorkspaceDirs();

  assert.ok(!existsSync(legacy));
  assert.ok(existsSync(workspace));
  assert.ok(existsSync(memory));
  assert.ok(existsSync(canvas));
});
