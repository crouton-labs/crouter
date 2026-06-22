// Run with: node --import tsx/esm --test src/core/__tests__/connection-reconnect-resume.test.ts
//
// BUG-REGRESSION + feature (§J connectivity-recovery). Observed: when wifi drops,
// a node's pi engine exhausts its retry budget on "Error: Connection error." /
// "fetch failed" and PARKS (stophook case (a) — stay alive, no shutdown). It then
// sits stuck. The §I error-stall timer would, after 5 min of quiet, kill+RESUME-
// revive it — but a RESUME injects NO continue nudge, and while the network is
// still down the retry just re-errors (and the kill WIPES the error-stall marker
// §J needs). So connection-parked nodes don't reliably come back when wifi does.
//
// Fix (§J): the daemon holds connection-kind error-stalls (§I now SKIPS them) and,
// the moment the network is confirmed reachable again, appends an urgent "continue"
// nudge to each parked node's inbox. The node's still-alive in-process inbox-watcher
// delivers it, starting a fresh turn that retries the failed work — conversation
// intact, no kill, no relaunch.
//
// PROVEN WITHOUT TOUCHING REAL WIFI: the ONLY fakes are the network probe (the
// "wifi state", injected via superviseTick deps) and the LLM (fake-pi broker).
// The stophook, the error-stall marker + classifier, the daemon passes, the live
// inbox-watcher, and inbox delivery are all REAL.
//
// Four legs: J1 the pure nudge-owed truth table; J2 the real TCP probe
// (connect/refuse/timeout); J3 daemon integration over a fabricated live engine
// (§I does NOT kill a connection stall; §J holds while offline, nudges when
// online); J4 end-to-end over a REAL fake-pi broker (the live inbox-watcher
// delivers the continue nudge on reconnect).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { writeFileSync, utimesSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createHeadlessHarness, type Harness } from './helpers/harness.js';
import { reconnectNudgeOwed, ERROR_STALL_QUIET_MS, isPidAlive } from '../../daemon/crtrd.js';
import { tcpReachable } from '../runtime/connectivity.js';
import { markErrorStall, readErrorStall } from '../runtime/error-stall.js';

// Session-jsonl line builder (the shape pi writes: {type:'message', message}).
const line = (message: Record<string, unknown>): string =>
  JSON.stringify({ type: 'message', id: 'x', timestamp: new Date().toISOString(), message });
const assistant = (stopReason: string, errorMessage?: string): string =>
  line({ role: 'assistant', stopReason, ...(errorMessage === undefined ? {} : { errorMessage }) });

const ONLINE = async (): Promise<boolean> => true;
const OFFLINE = async (): Promise<boolean> => false;

const hasNudge = (h: Harness, id: string): boolean =>
  h.inbox(id).some((e) => /connection restored/i.test(e.label));

// ---------------------------------------------------------------------------
// J1 — the pure nudge-owed truth table.
// ---------------------------------------------------------------------------
test('J1 reconnectNudgeOwed: owe a nudge ONLY for a live, parked, not-yet-nudged connection stall', () => {
  // The one owed case.
  assert.equal(reconnectNudgeOwed(true, null, false, 'connection', false), true, 'live + parked + connection + un-nudged → owed');

  // Already nudged this exact park → not again (dedup; one nudge per episode).
  assert.equal(reconnectNudgeOwed(true, null, false, 'connection', true), false, 'already nudged this park → no');

  // Not a connection stall → §J leaves it to §I's timer.
  assert.equal(reconnectNudgeOwed(true, null, false, 'rate-limit', false), false, 'rate-limit → no (§I owns it)');
  assert.equal(reconnectNudgeOwed(true, null, false, 'overloaded', false), false, 'overloaded → no');
  assert.equal(reconnectNudgeOwed(true, null, false, 'other', false), false, 'other → no');
  assert.equal(reconnectNudgeOwed(true, null, false, null, false), false, 'no stall marker → no');

  // A dead broker is the crash-revive path's job, never §J's.
  assert.equal(reconnectNudgeOwed(false, null, false, 'connection', false), false, 'dead pid → no');

  // A pending intent (refresh/idle-release) or a mid-turn engine is never nudged.
  assert.equal(reconnectNudgeOwed(true, 'refresh', false, 'connection', false), false, 'intent=refresh → no');
  assert.equal(reconnectNudgeOwed(true, 'idle-release', false, 'connection', false), false, 'intent=idle-release → no');
  assert.equal(reconnectNudgeOwed(true, null, true, 'connection', false), false, 'busy (mid-turn) → no');
});

// ---------------------------------------------------------------------------
// J2 — the real connectivity probe: connect succeeds, refused/unroutable fail.
// ---------------------------------------------------------------------------
test('J2 tcpReachable: true on a live listener, false on refused + on timeout', { timeout: 15_000 }, async () => {
  // A live local listener → reachable.
  const srv: Server = createServer();
  await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
  const port = (srv.address() as { port: number }).port;
  try {
    assert.equal(await tcpReachable('127.0.0.1', port, 2000), true, 'live listener → reachable');
  } finally {
    await new Promise<void>((res) => srv.close(() => res()));
  }

  // The same port AFTER close → connection refused → not reachable.
  assert.equal(await tcpReachable('127.0.0.1', port, 2000), false, 'closed port (refused) → not reachable');

  // TEST-NET-1 (192.0.2.0/24, RFC 5737) is reserved + unroutable → connect times
  // out. A short timeout keeps the test fast; the probe must read this as down.
  assert.equal(await tcpReachable('192.0.2.1', 443, 400), false, 'unroutable address (timeout) → not reachable');
});

// ---------------------------------------------------------------------------
// J3 — daemon integration over a fabricated live engine. §I must NOT kill a
//      connection stall (even quiet past its grace); §J holds it while offline
//      and nudges it (NOT kills) once online. A real `sleep` stands in for the
//      parked engine so "the broker was never killed" is directly observable.
// ---------------------------------------------------------------------------
const T0 = 9_000_000_000;

test('J3 daemon holds a connection stall offline, nudges (never kills) it online', { timeout: 30_000 }, async () => {
  const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-j3' });
  const dir = mkdtempSync(join(tmpdir(), 'crtr-j3-'));
  const parked = spawn('sleep', ['300'], { stdio: 'ignore' }); // the connection-parked engine
  try {
    // A session that ends in a CONNECTION error, quiet far past §I's grace — so if
    // §I were not gated it would SIGTERM this engine on sight (cf. E3).
    const file = join(dir, 'parked.jsonl');
    writeFileSync(file, [assistant('toolUse'), assistant('error', 'Connection error.')].join('\n') + '\n');
    const staleSec = (T0 - ERROR_STALL_QUIET_MS - 60_000) / 1000;
    utimesSync(file, staleSec, staleSec);
    const id = h.fabricateBrokerNode({
      kind: 'developer',
      status: 'active',
      pi_pid: parked.pid!,
      pi_session_id: 'sess-j3',
      pi_session_file: file,
    });
    // The marker the stophook would have recorded — kind 'connection'.
    markErrorStall(id, 'Connection error.');
    assert.equal(readErrorStall(id)?.kind, 'connection', 'precondition: connection-kind error-stall marker');
    assert.equal(isPidAlive(parked.pid!), true, 'precondition: parked engine alive');

    // --- OFFLINE tick: §I must not kill it (gated), §J must not nudge it (held). ---
    await h.tick(T0, { probeOnline: OFFLINE });
    // Give any (erroneous) SIGTERM time to land before asserting it did NOT.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(isPidAlive(parked.pid!), true, 'offline: §I did NOT kill the connection-parked engine');
    assert.equal(hasNudge(h, id), false, 'offline: §J held — no continue nudge appended');

    // --- ONLINE tick: §J appends the continue nudge; the engine is STILL alive. ---
    await h.tick(T0, { probeOnline: ONLINE });
    assert.equal(isPidAlive(parked.pid!), true, 'online: §J nudged, did NOT kill the engine');
    assert.equal(hasNudge(h, id), true, 'online: §J appended a "connection restored — continue" nudge');
    const nudge = h.inbox(id).find((e) => /connection restored/i.test(e.label))!;
    assert.equal(nudge.tier, 'urgent', 'the nudge is urgent');
    assert.match(String(nudge.data?.['body'] ?? ''), /continue|retry/i, 'the nudge body says continue/retry');

    // --- A SECOND online tick must NOT double-nudge this same park (dedup). ---
    await h.tick(T0, { probeOnline: ONLINE });
    const count = h.inbox(id).filter((e) => /connection restored/i.test(e.label)).length;
    assert.equal(count, 1, 'one nudge per park episode (dedup holds across ticks)');
  } finally {
    try {
      parked.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    rmSync(dir, { recursive: true, force: true });
    await h.dispose();
  }
});

// ---------------------------------------------------------------------------
// J4 — END-TO-END over a REAL fake-pi broker. Drive it to a connection error
//      (real stophook records the marker, broker stays alive), tick offline (no
//      delivery), then tick online and prove the LIVE inbox-watcher delivers the
//      continue nudge as an injected user message.
// ---------------------------------------------------------------------------
test('J4 a real connection-parked broker is nudged to continue on reconnect', { timeout: 45_000 }, async () => {
  // Speed up the broker's in-process inbox-watcher so delivery is sub-second.
  // Read at broker boot, so set BEFORE the harness spawns the child.
  const origTick = process.env['CRTR_WATCHER_TICK_MS'];
  const origDebounce = process.env['CRTR_WATCHER_DEBOUNCE_MS'];
  process.env['CRTR_WATCHER_TICK_MS'] = '100';
  process.env['CRTR_WATCHER_DEBOUNCE_MS'] = '100';
  const h: Harness = await createHeadlessHarness({ sessionPrefix: 'crtr-j4' });
  try {
    const parent = h.spawnRoot('parent');
    const child = await h.spawnHeadlessChild(parent, 'do work that will hit a connection error');
    const pid = h.node(child)!.pi_pid!;
    assert.equal(isPidAlive(pid), true, 'precondition: broker booted + alive');

    // Drive the engine to exhaust its retries on a connection error → the REAL
    // stophook (case a) records a connection-kind error-stall marker and PARKS
    // (no shutdown). The broker — and its inbox-watcher — stay alive.
    await h.stop(child, 'error', 'Error: fetch failed');
    await h.waitFor(() => readErrorStall(child)?.kind === 'connection', {
      label: 'stophook recorded a connection error-stall marker',
    });
    assert.equal(isPidAlive(pid), true, 'broker parked alive after the connection error');

    // --- OFFLINE: no nudge appended, nothing delivered. ---
    await h.tick(Date.now(), { probeOnline: OFFLINE });
    await new Promise((r) => setTimeout(r, 400)); // let the watcher run a few ticks
    assert.equal(hasNudge(h, child), false, 'offline: no continue nudge appended');

    // --- ONLINE: §J appends the nudge; the live inbox-watcher delivers it as an
    //     injected user message (the proof the parked node was told to continue). ---
    const sinceCount = h.injected(child).length;
    await h.tick(Date.now(), { probeOnline: ONLINE });
    assert.equal(hasNudge(h, child), true, 'online: §J appended the continue nudge to the inbox');
    const delivered = await h.awaitWake(child, {
      sinceCount,
      match: /connection is back|continue|retry/i,
      timeoutMs: 15_000,
    });
    assert.ok(
      delivered.some((c) => /continue|retry/i.test(c)),
      'the live inbox-watcher injected the continue nudge into the parked engine',
    );
    assert.equal(isPidAlive(pid), true, 'end-to-end: the broker was nudged, never killed');
  } finally {
    if (origTick === undefined) delete process.env['CRTR_WATCHER_TICK_MS'];
    else process.env['CRTR_WATCHER_TICK_MS'] = origTick;
    if (origDebounce === undefined) delete process.env['CRTR_WATCHER_DEBOUNCE_MS'];
    else process.env['CRTR_WATCHER_DEBOUNCE_MS'] = origDebounce;
    await h.dispose();
  }
});
