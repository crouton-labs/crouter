// Run with: node --import tsx/esm --test src/core/__tests__/broker-crash-teardown.test.ts
//
// Broker crash / teardown / boot-failure — acceptance items 4–6 of the headless-
// broker migration plus the M-1/M-2 boot-failure regression. Split out of
// broker-lifecycle.test.ts (see its header for the full file map); the tests are
// the original acceptance gate, unchanged, on their own isolated harness:
//   4 survive a broker crash via grace-revive RESUME on the saved .jsonl         → "CRASH"
//   5 tear down cleanly — close → shutdown frame → exit, socket unlinked         → "clean teardown"
//   6 ONE-WRITER (R2) — never two engine pids alive across crash→grace-revive    → "CRASH"
//   M-1/M-2 a broker that dies before session_start is reaped, not stranded      → "boot failure"

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createHarness, hasTmux, type Harness } from './helpers/harness.js';
import { isPidAlive } from '../canvas/pid.js';
import { FAIL_BEFORE_SESSION_START } from './fixtures/fake-engine.js';

// crtrd.ts module const (not exported). The fresh-pi-boot grace window the daemon
// waits before grace-reviving a pi observed dead. Reference: crtrd.ts
// `REVIVE_GRACE_MS = 20_000`.
const REVIVE_GRACE_MS = 20_000;

let h: Harness;
let root: string;

before(async () => {
  if (!hasTmux()) return;
  h = await createHarness({ sessionPrefix: 'crtr-brkcrash' });
  root = h.spawnRoot('broker-crash suite root');
});

after(async () => {
  if (h !== undefined) await h.dispose();
});

// ===========================================================================
// Item 4 + 6 — broker CRASH → grace-revive RESUME on the saved .jsonl; ONE-
// WRITER: the crashed pid is dead BEFORE the revive launches and never
// resurrects, and the revived pid is distinct (never two engine pids at once).
// ===========================================================================
test('CRASH → grace-revive RESUME; one-writer (old pid dead before new, never resurrects)', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — crash');
  const oldPid = h.node(id)!.pi_pid!;
  assert.equal(isPidAlive(oldPid), true, 'broker alive before the crash');
  assert.equal(h.node(id)!.intent ?? null, null, 'fresh broker has a null intent (not refresh/idle-release)');
  const boots = h.bootCount(id);

  // Kill the broker out from under the daemon (a crash). Use a fixed clock so the
  // grace window is exercised deterministically.
  process.kill(oldPid, 'SIGKILL');
  await h.waitFor(() => !isPidAlive(oldPid), { label: 'crashed broker pid is dead' });
  // ONE-WRITER: the old engine pid is dead BEFORE any revive can launch.
  assert.equal(isPidAlive(oldPid), false, 'crashed pid dead before the daemon revives');

  const NOW = 5_000_000;
  await h.tick(NOW); // pid dead, intent null → handleBrokerLiveness → handleLiveWindow marks pending
  assert.equal(h.bootCount(id), boots, 'inside the grace window → NOT yet revived');

  await h.tick(NOW + REVIVE_GRACE_MS + 1); // grace elapsed → reviveNode(resume:true)
  const boot2 = await h.awaitBoot(id, { minCount: boots + 1 });
  assert.equal(boot2.resuming, true, 'grace-revive RESUMES the saved .jsonl');

  const newPid = h.node(id)!.pi_pid!;
  assert.ok(newPid != null && isPidAlive(newPid), 'the revived broker pid is alive');
  assert.notEqual(newPid, oldPid, 'the revived pid is distinct from the crashed one');
  assert.equal(isPidAlive(oldPid), false, 'one-writer: the crashed pid never resurrected');
});

// ===========================================================================
// Item 5 — clean teardown: close → hostFor(meta).teardown → `shutdown` frame →
// broker disposes + exits, socket unlinked, status canceled, daemon leaves it.
// ===========================================================================
test('clean teardown — node close → broker shutdown frame → exit, socket unlinked, not revived', { skip: !hasTmux() }, async () => {
  const id = await h.spawnHeadlessChild(root, 'headless worker — teardown');
  const pid = h.node(id)!.pi_pid!;
  const sock = h.brokerSock(id);
  await h.waitFor(() => existsSync(sock), { label: 'broker created its view.sock' });

  // Close via the REAL CLI (resolves the node from --node; the subprocess carries
  // no TMUX_PANE). closeNode marks canceled BEFORE teardown (crash-safe order),
  // then hostFor(broker).teardown sends the `shutdown` frame.
  const res = h.cli(root, ['node', 'close', '--node', id]);
  assert.equal(res.code, 0, `node close should exit 0\n--stderr--\n${res.stderr}`);

  await h.waitFor(() => !isPidAlive(pid), { label: 'broker process exited on shutdown frame' });
  await h.waitFor(() => !existsSync(sock), { label: 'broker unlinked its socket on exit' });
  assert.equal(h.status(id), 'canceled', 'the closed node is canceled');

  // listNodes only surfaces active|idle, so a canceled broker is never supervised.
  await h.tick();
  assert.equal(h.status(id), 'canceled', 'still canceled after a daemon tick');
  assert.equal(isPidAlive(pid), false, 'the broker stays dead — never revived');
});

// ===========================================================================
// M-1 regression — a broker that DIES before session_start must surface a boot
// failure, not strand the node forever. Before the fix handleBrokerLiveness read
// pid==null UNCONDITIONALLY as "still booting", so a broker that threw before
// recording a pid/session left the node 'active' with no engine FOREVER and the
// parent waited on a dead child. The daemon must instead crash it past the boot
// grace + push a boot-failure up the spine. (Also proves M-2: the broker's fatal
// diagnostic reaches job/broker.log instead of /dev/null.)
// ===========================================================================
test('boot failure — a broker that dies before session_start is reaped, not stranded (review M-1/M-2)', { skip: !hasTmux() }, async () => {
  // A headless child whose broker throws before session_start (no pid, no session
  // EVER recorded). spawnHeadlessChildNoBoot does not awaitBoot (there is none).
  const id = await h.spawnHeadlessChildNoBoot(root, `headless worker — boot fail ${FAIL_BEFORE_SESSION_START}`);

  // M-2: the broker logs its fatal stack to job/broker.log and exits(1). Without
  // the stdio redirect this diagnostic would be lost to /dev/null.
  const brokerLog = join(h.home, 'nodes', id, 'job', 'broker.log');
  await h.waitFor(
    () => existsSync(brokerLog) && /simulated pre-session_start boot failure/.test(readFileSync(brokerLog, 'utf8')),
    { label: 'broker logged its pre-session_start failure to job/broker.log' },
  );

  // The node is stuck 'active' with a null pid and a null session — the strand.
  const n0 = h.node(id)!;
  assert.equal(n0.pi_pid ?? null, null, 'no broker pid was ever recorded');
  assert.equal(n0.pi_session_id ?? null, null, 'no session was ever recorded');

  // Inside the boot grace the daemon LEAVES it (could be the sub-second boot gap).
  const NOW = 9_000_000;
  await h.tick(NOW);
  assert.equal(h.status(id), 'active', 'inside the boot grace → daemon leaves it (boot gap)');

  // Past the boot grace with STILL no pid and no session → crash + boot failure.
  await h.tick(NOW + REVIVE_GRACE_MS + 1);
  await h.waitForStatus(id, 'dead');
  assert.equal(h.status(id), 'dead', 'a never-booted broker is reaped, not stranded active forever');

  // …and the parent (an active subscriber of the child) was told up the spine.
  const note = h.inbox(root).find((e) => /never started/.test(e.label ?? ''));
  assert.ok(note !== undefined, 'the parent received a boot-failure notice up the spine');
});
