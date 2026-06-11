// Regression test for the `--dry-run` `wrote` count (found by P8 integration).
//
// Bug: under `--dry-run`, reconcilePair returned `wrote: counts.writes` — the
// WOULD-BE endpoint write total — even though nothing is written to disk. That
// contradicts the `sys sync -h` contract ("wrote … 0 under --dry-run") and the
// rendered "DRY RUN (nothing written)" header, which together promise 0. The
// fix makes `wrote` reflect ACTUAL writes (0 under dry-run) while still using
// the would-be counts internally to decide synced-vs-noop.
//
// This test FAILS on the pre-fix code (wrote === number of files that WOULD be
// written, e.g. 2 for a one-sided bootstrap) and PASSES on the current code.
//
// Run: node --import tsx/esm --test src/core/skill-sync/__tests__/dry-run-wrote-count.test.ts

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { reconcilePair } from '../engine.js';
import { DEFAULT_PROFILE } from '../profile.js';
import type { Pair } from '../manifest.js';

// The engine resolves user-scope endpoints + the snapshot store off homedir(),
// which reads $HOME at call time — so isolating $HOME isolates everything.
let home: string;
let prevHome: string | undefined;

const PAIR: Pair = {
  id: 'dryrun-regression',
  crtr: { scope: 'user', name: 'dr' },
  claude: { scope: 'user', name: 'dr' },
};

before(() => {
  prevHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'crtr-sync-dryrun-'));
  process.env.HOME = home;

  // One-sided bootstrap: only the crtr side exists. A real sync here would
  // materialize the Claude side + write the snapshot (2 endpoint files written).
  const crtrDir = join(home, '.crouter', 'memory', 'dr');
  mkdirSync(crtrDir, { recursive: true });
  writeFileSync(
    join(crtrDir, 'SKILL.md'),
    '---\nkind: knowledge\nwhen-and-why-to-read: "When the regression applies, this doc should be read."\n---\n# DR\nbody\n',
    'utf8',
  );
});

after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
  assert.equal(homedir(), prevHome ?? homedir()); // sanity: $HOME restored
});

test('--dry-run reports wrote === 0 and writes nothing to disk', () => {
  const res = reconcilePair(PAIR, DEFAULT_PROFILE, { dryRun: true });

  // Status still reflects that a real run WOULD sync this pair...
  assert.equal(res.status, 'synced', 'dry-run should still classify the pending change as synced');
  // ...but the `wrote` count is ACTUAL writes — zero under --dry-run.
  assert.equal(res.wrote, 0, 'dry-run must report wrote === 0 (contract: 0 under --dry-run)');

  // And nothing was actually written: no Claude bundle, no snapshot.
  assert.ok(
    !existsSync(join(home, '.claude', 'skills', 'dr', 'SKILL.md')),
    'dry-run must not materialize the Claude endpoint',
  );
  assert.ok(
    !existsSync(join(home, '.crouter', 'skill-sync', 'snapshots', PAIR.id)),
    'dry-run must not write the snapshot base',
  );
});
