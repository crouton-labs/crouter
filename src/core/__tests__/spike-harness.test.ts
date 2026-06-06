// Run with: node --import tsx/esm --test src/core/__tests__/spike-harness.test.ts
//
// SPIKE — a throwaway-grade proof that a faithful integration harness for the
// node/canvas runtime is feasible. It drives the REAL `crtr` CLI into an
// isolated REAL tmux session, substitutes a FAKE-PI vehicle (the fake-pi-host
// fixture) via the CRTR_PI_BINARY seam, and proves the spawned window actually
// exec's the fake pi with the right argv+env, that the fake loads the REAL
// extensions, and that one real lifecycle hook drives a real canvas transition.
//
// Milestones (de-risk order):
//   1. SEAM      — piCommand substitutes CRTR_PI_BINARY only when set (unit).
//   2. ROUND-TRIP— real `node new` → isolated tmux window → fake pi boots with
//                  CRTR_NODE_ID + the -e env intact (GO/NO-GO).
//   3. REAL HOOKS— the fake pi loads the real stophook and a clean /quit drives
//                  status=done via the real session_shutdown handler.
//   4. TEARDOWN  — the isolated session + fake-pi procs are killed; no strays.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import { createNode, getNode } from '../canvas/canvas.js';
import { closeDb } from '../canvas/db.js';
import { piCommand } from '../runtime/placement.js';
import { CANVAS_EXTENSIONS } from '../runtime/launch.js';
import type { NodeMeta } from '../canvas/types.js';

// --- locations --------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url)); // src/core/__tests__
const CROUTER = join(HERE, '..', '..', '..'); // package root
const CLI_SRC = join(CROUTER, 'src', 'cli.ts');
const FAKE_PI_HOST = join(HERE, 'fixtures', 'fake-pi-host.ts');
const TSX_ESM = createRequire(import.meta.url).resolve('tsx/esm');
// A multi-word launcher baked verbatim ahead of the (shell-quoted) argv.
const FAKE_PI_BINARY = `${process.execPath} --import ${TSX_ESM} ${FAKE_PI_HOST}`;

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function tmuxSessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

// --- env isolation: scrub every canvas var the harness itself runs under, so
// the spawned CLI cannot leak into the real canvas. -------------------------
const CANVAS_ENV_KEYS = [
  'CRTR_NODE_ID',
  'CRTR_HOME',
  'CRTR_ROOT_SESSION',
  'CRTR_NODE_SESSION',
  'CRTR_PARENT_NODE_ID',
  'CRTR_FRONT_DOOR',
  'CRTR_KIND',
  'CRTR_MODE',
  'CRTR_LIFECYCLE',
  'CRTR_NODE_CWD',
  'CRTR_PI_BINARY',
  'TMUX',
  'TMUX_PANE',
];

function cleanBaseEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  for (const k of CANVAS_ENV_KEYS) delete e[k];
  // Contain per-invocation bootstrap + auto-update side effects.
  e['CRTR_NO_BOOTSTRAP'] = '1';
  e['CRTR_NO_AUTO_UPDATE'] = '1';
  e['CRTR_NO_BOOT_SKILL'] = '1';
  e['CRTR_NO_MODE_CMDS'] = '1';
  e['CRTR_NO_AUTO_INIT'] = '1';
  return e;
}

function node(id: string, over: Partial<NodeMeta> = {}): NodeMeta {
  return {
    node_id: id,
    name: id,
    created: new Date().toISOString(),
    cwd: CROUTER,
    kind: 'general',
    mode: 'base',
    lifecycle: 'resident',
    status: 'active',
    parent: null,
    ...over,
  };
}

async function waitFor<T>(
  probe: () => T | undefined | null | false,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 150;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.label ?? 'condition'}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// --- harness state ----------------------------------------------------------
let home: string;
let tmpHome: string;
let origHome: string | undefined;
const sessionsToKill = new Set<string>();
const pidsToKill = new Set<number>();

before(() => {
  origHome = process.env['CRTR_HOME'];
  home = mkdtempSync(join(tmpdir(), 'crtr-spike-home-'));
  tmpHome = mkdtempSync(join(tmpdir(), 'crtr-spike-HOME-'));
  // The harness reads/writes the isolated canvas in-process.
  process.env['CRTR_HOME'] = home;
  closeDb();
});

after(() => {
  for (const s of sessionsToKill) spawnSync('tmux', ['kill-session', '-t', s], { stdio: 'ignore' });
  for (const p of pidsToKill) {
    try {
      process.kill(p, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  closeDb();
  if (home) rmSync(home, { recursive: true, force: true });
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  if (origHome === undefined) delete process.env['CRTR_HOME'];
  else process.env['CRTR_HOME'] = origHome;
});

// ===========================================================================
// MILESTONE 1 — the CRTR_PI_BINARY seam (always runs; no tmux needed).
// ===========================================================================
test('M1 seam: piCommand exec\'s `pi` when CRTR_PI_BINARY is unset, substitutes when set', () => {
  const saved = process.env['CRTR_PI_BINARY'];
  try {
    delete process.env['CRTR_PI_BINARY'];
    const unset = piCommand(['-e', '/abs/ext.ts', '-n', 'label']);
    assert.equal(unset, "pi '-e' '/abs/ext.ts' '-n' 'label'", 'unset → identical to exec pi');
    assert.ok(unset.startsWith('pi '), 'unset → leads with the literal pi binary');

    process.env['CRTR_PI_BINARY'] = '/tmp/fake-pi';
    const set = piCommand(['-e', '/abs/ext.ts']);
    assert.ok(set.startsWith('/tmp/fake-pi '), 'set → leads with the substituted binary');
    assert.ok(!set.startsWith('pi '), 'set → no longer the literal pi');
    assert.equal(set, "/tmp/fake-pi '-e' '/abs/ext.ts'", 'argv still shell-quoted after the substitution');

    // A multi-word launcher is spliced verbatim (argv stays quoted).
    process.env['CRTR_PI_BINARY'] = 'node --import tsx/esm host.ts';
    assert.equal(
      piCommand(['-n', 'x']),
      "node --import tsx/esm host.ts '-n' 'x'",
      'multi-word binary spliced ahead of the quoted argv',
    );

    // An explicit binary arg still overrides the env.
    assert.ok(
      piCommand(['-n', 'x'], 'pi').startsWith('pi '),
      'explicit binary arg wins over the env seam',
    );
  } finally {
    if (saved === undefined) delete process.env['CRTR_PI_BINARY'];
    else process.env['CRTR_PI_BINARY'] = saved;
  }
});

// ===========================================================================
// MILESTONES 2 + 3 — real CLI → isolated tmux → fake pi → real hooks.
// THE GO/NO-GO. Shares one spawned child across both milestones.
// ===========================================================================
test(
  'M2+M3 round-trip: real `node new` reaches the fake pi via the seam, and a real hook drives status=done',
  { skip: !hasTmux() },
  async () => {
    const session = `crtr-spike-${process.pid}-rt`;
    sessionsToKill.add(session);
    // Pre-create the isolated session (default tmux server — the runtime shells
    // `tmux` with no -L, so an -L server would be invisible to the real CLI).
    spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', CROUTER, 'sleep 600'], {
      stdio: 'ignore',
    });
    assert.ok(tmuxSessionExists(session), 'isolated tmux session created');

    // Bootstrap the acting node in the isolated canvas (the parent `node new`
    // spawns under). createNode shares the harness CRTR_HOME.
    createNode(node('A', { name: 'acting-root' }));

    // Drive the REAL CLI: `crtr node new` AS node A, into the isolated session,
    // with the fake-pi seam. Body passed as a positional (dodges the stdin hang).
    const env = cleanBaseEnv();
    env['CRTR_HOME'] = home;
    env['HOME'] = tmpHome;
    env['CRTR_NODE_ID'] = 'A';
    env['CRTR_NODE_SESSION'] = session;
    env['CRTR_PI_BINARY'] = FAKE_PI_BINARY;

    const res = spawnSync(
      process.execPath,
      ['--import', TSX_ESM, CLI_SRC, 'node', 'new', 'spike task', '--parent', 'A', '--cwd', CROUTER],
      { cwd: CROUTER, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 },
    );
    assert.equal(
      res.status,
      0,
      `node new should exit 0\n--- stdout ---\n${res.stdout}\n--- stderr ---\n${res.stderr}`,
    );

    // Find the spawned child: the only node dir that isn't the acting root.
    closeDb();
    const nodesDir = join(home, 'nodes');
    const childId = readdirSync(nodesDir).find((d) => d !== 'A');
    assert.ok(childId, 'a child node dir was created by node new');

    // ---- MILESTONE 2 assertions: the round-trip reached the fake pi --------
    const bootPath = join(nodesDir, childId!, 'fake-pi.boot.json');
    const errPath = join(nodesDir, childId!, 'fake-pi.error');
    await waitFor(
      () => existsSync(bootPath),
      {
        timeoutMs: 30_000,
        label: `fake-pi boot proof at ${bootPath}${existsSync(errPath) ? ` (error file: ${readFileSync(errPath, 'utf8')})` : ''}`,
      },
    );
    const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
    if (typeof boot.pid === 'number') pidsToKill.add(boot.pid);

    // env delivered via tmux -e arrived in the fake pi's process.env.
    assert.equal(boot.env.CRTR_NODE_ID, childId, 'CRTR_NODE_ID is the CHILD id, intact');
    assert.equal(boot.env.CRTR_HOME, home, 'CRTR_HOME isolated value intact');
    assert.ok(boot.env.CRTR_KIND, 'CRTR_KIND present');
    assert.ok(boot.env.CRTR_MODE, 'CRTR_MODE present');
    assert.ok(boot.env.CRTR_LIFECYCLE, 'CRTR_LIFECYCLE present');
    assert.equal(boot.env.CRTR_FRONT_DOOR, '1', 'CRTR_FRONT_DOOR overlay present');
    // argv from buildPiArgv arrived: every canvas -e extension + the kickoff.
    // Assert against the live CANVAS_EXTENSIONS count (8 at current HEAD — the
    // placement-v3 refactor added canvas-resume) so this never drifts again.
    assert.equal(
      boot.extPaths.length,
      CANVAS_EXTENSIONS.length,
      `all ${CANVAS_EXTENSIONS.length} canvas -e extension paths in argv`,
    );
    assert.ok(
      boot.loaded.some((p: string) => p.includes('canvas-stophook')),
      'real stophook module loaded by the fake pi',
    );
    assert.ok(
      boot.loaded.some((p: string) => p.includes('canvas-inbox-watcher')),
      'real inbox-watcher module loaded by the fake pi',
    );
    assert.equal(boot.failedExt.length, 0, `no extension failed to load: ${JSON.stringify(boot.failedExt)}`);
    assert.equal(boot.resuming, false, 'fresh start (no --session)');
    assert.equal(boot.prompt, 'spike task', 'kickoff prompt is the last positional');

    // The REAL stophook session_start handler ran inside the fake pi and wrote
    // shared canvas state (proves the hook chain, not just the boot).
    closeDb();
    const afterBoot = getNode(childId!);
    assert.ok(afterBoot, 'child node readable from the shared canvas');
    assert.equal(afterBoot!.pi_session_id, boot.sessionId, 'stophook captured pi_session_id');
    assert.equal(afterBoot!.status, 'active', 'child active after boot');

    // ---- MILESTONE 3: a clean /quit drives a real transition to done -------
    writeFileSync(join(nodesDir, childId!, 'fake-pi.cmd'), JSON.stringify({ cmd: 'shutdown' }));
    const done = await waitFor(
      () => {
        closeDb();
        return getNode(childId!)?.status === 'done' ? true : false;
      },
      { timeoutMs: 20_000, label: 'child status=done after clean /quit' },
    );
    assert.ok(done, 'real session_shutdown hook resolved the node to done');
    assert.equal(getNode(childId!)?.status, 'done', 'status=done via the real stophook');

    // ---- MILESTONE 4: teardown leaves no stray session ---------------------
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
    sessionsToKill.delete(session);
    assert.ok(!tmuxSessionExists(session), 'isolated session killed, no stray left');
  },
);
