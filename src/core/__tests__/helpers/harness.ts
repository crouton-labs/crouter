// helpers/harness.ts — a reusable, FAITHFUL integration-test driver for the
// node/canvas runtime.
//
// It drives the REAL `crtr` CLI (as subprocesses, AS specific nodes) into a
// REAL but isolated tmux session, substitutes the fake-pi vehicle (fixtures/
// fake-pi-host.ts) for the LLM `pi` via the CRTR_PI_BINARY seam, fires the REAL
// extension hooks inside that fake-pi over a polled control channel, and runs
// the daemon decision pass in-process via superviseTick(now). Every assertion
// reads straight off the canvas data layer. NOTHING here mocks the runtime.
//
// See harness-design.md §4/§5 and vehicle-and-hooks.md §6 for the architecture
// this implements. The ONE production seam used is CRTR_PI_BINARY in
// piCommand (src/core/runtime/tmux.ts) — no production file is modified.
//
// Isolation contract (harness-design.md §4a):
//   • The harness itself runs AS a canvas node, so its OWN process.env carries
//     the REAL canvas vars. We override CRTR_HOME (+ CRTR_PI_BINARY) for our own
//     in-process reads/revives, and scrub every canvas var from each subprocess
//     env. closeDb() rebinds sqlite to the isolated home before every read.
//   • The isolated tmux session lives on the DEFAULT server (the runtime shells
//     `tmux` with no -L, so an -L server would be invisible to the real CLI and
//     to superviseTick). We only ever kill-session, never kill-server.

import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

import {
  createNode,
  getNode,
  subscribersOf,
  subscriptionsOf,
} from '../../canvas/canvas.js';
import { closeDb } from '../../canvas/db.js';
import { isFocused } from '../../runtime/placement.js';
import { superviseTick } from '../../../daemon/crtrd.js';
import { readInboxSince } from '../../feed/inbox.js';
import type { NodeMeta, NodeStatus, Mode, Lifecycle, ExitIntent } from '../../canvas/types.js';
import type { InboxEntry } from '../../feed/inbox.js';

// --- locations --------------------------------------------------------------
const HERE = dirname(fileURLToPath(import.meta.url)); // src/core/__tests__/helpers
const CROUTER = join(HERE, '..', '..', '..', '..'); // package root
const CLI_SRC = join(CROUTER, 'src', 'cli.ts');
const FAKE_PI_HOST = join(HERE, '..', 'fixtures', 'fake-pi-host.ts');
// The in-process fake BrokerEngine (the SDK analog of the fake-pi vehicle). The
// REAL broker loads it via the CRTR_BROKER_ENGINE seam (broker-sdk.ts). Point at
// the absolute `.ts` path — the broker runs under tsx (see NODE_OPTIONS below),
// which resolves it.
const FAKE_ENGINE = join(HERE, '..', 'fixtures', 'fake-engine.ts');
const TSX_ESM = createRequire(import.meta.url).resolve('tsx/esm');
// A multi-word launcher, baked verbatim ahead of the (shell-quoted) argv by the
// seam. Absolute paths so it works regardless of the spawned window's cwd.
const FAKE_PI_BINARY = `${process.execPath} --import ${TSX_ESM} ${FAKE_PI_HOST}`;

/** True when a usable tmux is on PATH — tests gate on this and SKIP otherwise. */
export function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;
}

function tmuxSessionExists(session: string): boolean {
  return spawnSync('tmux', ['has-session', '-t', session], { stdio: 'ignore' }).status === 0;
}

// Every canvas/tmux var the harness itself runs under — scrubbed from each child
// env so a spawned CLI cannot leak the REAL canvas into the isolated test.
const CANVAS_ENV_KEYS = [
  'CRTR_NODE_ID',
  'CRTR_HOME',
  'CRTR_ROOT_SESSION',
  'CRTR_SUBTREE',
  'CRTR_NODE_SESSION',
  'CRTR_PARENT_NODE_ID',
  'CRTR_FRONT_DOOR',
  'CRTR_KIND',
  'CRTR_MODE',
  'CRTR_LIFECYCLE',
  'CRTR_NODE_CWD',
  'CRTR_PI_BINARY',
  // Scrubbed then re-added (controlled) in childEnv, mirroring CRTR_PI_BINARY —
  // so the headless-broker seam can't leak the REAL engine into the isolated
  // test, and the CLI subprocess that spawns a broker carries the FAKE one.
  'CRTR_BROKER_ENGINE',
  'TMUX',
  'TMUX_PANE',
];

function cleanBaseEnv(): Record<string, string> {
  const e: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) e[k] = v;
  for (const k of CANVAS_ENV_KEYS) delete e[k];
  // Contain per-invocation bootstrap + auto-update side effects (they write to
  // ~/.crouter / ~/.claude / ~/.pi, NOT under CRTR_HOME — HOME is contained too).
  e['CRTR_NO_BOOTSTRAP'] = '1';
  e['CRTR_NO_AUTO_UPDATE'] = '1';
  e['CRTR_NO_BOOT_SKILL'] = '1';
  e['CRTR_NO_MODE_CMDS'] = '1';
  e['CRTR_NO_AUTO_INIT'] = '1';
  return e;
}

export interface WaitOpts {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

async function waitFor<T>(
  probe: () => T | undefined | null | false,
  opts: WaitOpts = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (Date.now() > deadline) throw new Error(`waitFor timed out: ${opts.label ?? 'condition'}`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface Injected {
  content: string;
  deliverAs?: string;
}

export interface BootProof {
  pid: number;
  nodeId: string;
  resuming: boolean;
  prompt: string | null;
  extPaths: string[];
  loaded: string[];
  failedExt: string[];
  env: Record<string, string | null>;
  [k: string]: unknown;
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
  json?: unknown;
}

export interface HarnessOpts {
  sessionPrefix?: string;
  /** HEADLESS mode: drive ONLY broker-hosted (paneless) nodes. When set the
   *  harness does NOT gate on tmux, does NOT eagerly create the isolated tmux
   *  session, and skips the per-pane `set-environment` seeding — nothing in a
   *  headless run opens a window. CRTR_NODE_SESSION is still set to the isolated
   *  name (and dispose still kill-sessions it) because `spawnChild` in spawn.ts
   *  calls `ensureSession()` UNCONDITIONALLY to record each node's durable
   *  `home_session` revive target — even a broker birth, which then ignores it.
   *  So `node new --headless` may LAZILY create that one isolated session as a
   *  side effect, but never a window/pane; the broker boots detached, supervised
   *  by pid. Headless tests must use `spawnHeadlessChild`, never `spawnChild`
   *  (which opens a real window). See createHeadlessHarness(). */
  headless?: boolean;
}

export interface SpawnOpts {
  kind?: string;
  mode?: Mode;
  lifecycle?: Lifecycle;
  id?: string;
}

/** Fabricate a broker-hosted node row directly — tmux-free, boot-free, NO
 *  subprocess. Builds a full NodeMeta (identity ∪ runtime) and calls createNode,
 *  which seeds BOTH halves in one statement (seedRow writes status/intent/pi_pid
 *  from the meta; writeMeta persists pi_session_id). The result is a row the
 *  daemon supervises by pid exactly as if a real broker had booted — so a test
 *  can drive superviseTick(now) liveness decisions against arbitrary liveness
 *  state (alive/dead pid, with/without session, any intent) with ZERO real boot.
 *  See foundation-spec §E.2. */
export interface FabricateOpts {
  parent?: string | null;
  kind?: string;
  mode?: Mode;
  lifecycle?: Lifecycle;
  status?: NodeStatus;
  intent?: ExitIntent;
  pi_pid?: number | null;
  pi_session_id?: string | null;
  id?: string;
}

export interface Harness {
  home: string;
  session: string;

  // spawn an acting root in-process (createNode; no inline bootRoot which would
  // exec pi and never return). Returns the new node id.
  spawnRoot(task: string, o?: SpawnOpts): string;
  // fabricate a broker-hosted node row directly — no boot, no subprocess (§E.2).
  fabricateBrokerNode(o?: FabricateOpts): string;
  // spawn a managed child through the REAL CLI `node new`, AS `parentId`.
  spawnChild(parentId: string, task: string, o?: SpawnOpts): Promise<string>;

  // run any real CLI verb AS a node (subprocess; body must be a positional).
  cli(nodeId: string | null, args: string[]): CliResult;

  // spawn a HEADLESS broker child through the REAL CLI `node new --headless`, AS
  // `parentId`, then awaitBoot. The broker process loads the fake engine.
  spawnHeadlessChild(parentId: string, task: string, o?: SpawnOpts): Promise<string>;
  // same, but DO NOT awaitBoot — for the boot-failure case (the broker dies
  // before session_start, so it never produces a boot proof to await).
  spawnHeadlessChildNoBoot(parentId: string, task: string, o?: SpawnOpts): Promise<string>;

  // drive a fake-pi over its control channel — fires the REAL hooks.
  turn(nodeId: string, text?: string): Promise<void>;
  stop(nodeId: string, reason?: 'stop' | 'length' | 'aborted' | 'error'): Promise<void>;
  finish(nodeId: string, finalText: string): Promise<void>;
  yieldNode(nodeId: string, note: string): Promise<void>;

  // the daemon decision pass, in-process, with an injectable clock.
  tick(now?: number): Promise<void>;

  // observers (each closeDb()s first to see cross-process WAL writes).
  awaitBoot(nodeId: string, o?: { minCount?: number; timeoutMs?: number }): Promise<BootProof>;
  awaitWake(
    nodeId: string,
    o?: { sinceCount?: number; timeoutMs?: number; match?: RegExp },
  ): Promise<string[]>;
  waitForStatus(nodeId: string, status: NodeStatus, timeoutMs?: number): Promise<void>;
  waitForPaneGone(nodeId: string, timeoutMs?: number): Promise<void>;
  waitFor<T>(probe: () => T | undefined | null | false, o?: WaitOpts): Promise<T>;

  // straight off the data layer.
  node(nodeId: string): NodeMeta | null;
  status(nodeId: string): NodeStatus | null;
  paneAlive(nodeId: string): boolean;
  inbox(nodeId: string): InboxEntry[];
  injected(nodeId: string): Injected[];

  // viewer-registry observability: a node has a live on-screen viewer pane iff
  // a focus row points at a still-alive pane (isFocused GC-prunes dead rows on
  // read). Replaces the deleted pane-existence probe (isNodePaneAlive) — liveness
  // is pid-only now, but the viewer presence test reads the focuses table.
  // headless-broker observability: write a raw fake-engine command (turn|stop|
  // dialog) atomically; read the resolved unattended-dialog log; the node's
  // broker view.sock path.
  fakeCmd(nodeId: string, cmd: Record<string, unknown>): void;
  dialogResults(nodeId: string): { resolved: unknown; ms: number }[];
  brokerSock(nodeId: string): string;
  bootCount(nodeId: string): number;
  subscribers(nodeId: string): { node_id: string; active: boolean }[];
  subscriptions(nodeId: string): { node_id: string; active: boolean }[];

  dispose(): Promise<void>;
}

/** Thin wrapper: a headless-only harness (broker-hosted, paneless nodes). */
export async function createHeadlessHarness(opts: HarnessOpts = {}): Promise<Harness> {
  return createHarness({ ...opts, headless: true });
}

export async function createHarness(opts: HarnessOpts = {}): Promise<Harness> {
  const headless = opts.headless === true;
  if (!headless && !hasTmux()) throw new Error('createHarness: tmux not available');

  const origHome = process.env['CRTR_HOME'];
  const origPiBinary = process.env['CRTR_PI_BINARY'];
  const origNodeSession = process.env['CRTR_NODE_SESSION'];
  const origNodeOptions = process.env['NODE_OPTIONS'];
  const origBrokerEngine = process.env['CRTR_BROKER_ENGINE'];

  // The headless broker binds a unix socket at <home>/nodes/<id>/view.sock. A
  // unix socket path (sun_path) has a ~104-char OS limit, and macOS's per-user
  // $TMPDIR (/var/folders/<…>/T/, ~49 chars) alone pushes that path past the
  // limit — server.listen() then fails EINVAL and the broker's loop drains
  // (boots, never serves). NOT a production concern (~/.crouter/canvas/… is
  // short); a test-only artifact of the long temp base. Use a SHORT base + short
  // prefix for the canvas home so broker sockets fit. tmpHome (HOME) hosts no
  // socket, so it can stay on the standard temp base.
  const shortTmpBase = existsSync('/tmp') ? '/tmp' : tmpdir();
  const home = mkdtempSync(join(shortTmpBase, 'crh-'));
  const tmpHome = mkdtempSync(join(tmpdir(), 'crtr-harness-HOME-'));
  const session = `${opts.sessionPrefix ?? 'crtr-harness'}-${process.pid}-${Date.now().toString(36)}`;

  // The harness reads/writes the isolated canvas in-process. CRTR_PI_BINARY in
  // OUR env makes in-process revives (superviseTick → reviveNode → openNodeWindow)
  // bake the fake-pi into the command string.
  process.env['CRTR_HOME'] = home;
  process.env['CRTR_PI_BINARY'] = FAKE_PI_BINARY;
  delete process.env['CRTR_NODE_SESSION'];
  // The headless broker (host.ts) launches `node <broker-cli.js> <id>` with a
  // plain `process.execPath` (no tsx) and resolveBrokerEntry returns a `.js`
  // path that, under the src test tree, only exists as `.ts`. Putting
  // `--import <tsx/esm>` in the broker's NODE_OPTIONS makes the spawned broker
  // run under tsx (resolving broker-cli.js→.ts AND the `.ts` fake engine). We set
  // it on OUR process.env so it propagates to BOTH broker-launch callers: the
  // in-process daemon revive (headlessBrokerHost.launch spreads {...process.env})
  // and the initial `node new --headless` CLI subprocess (cleanBaseEnv copies it,
  // since NODE_OPTIONS is deliberately NOT in CANVAS_ENV_KEYS). NODE_OPTIONS is
  // read at process START, so setting it on the already-running harness does NOT
  // re-trigger tsx here — it only propagates to spawned children (verified).
  process.env['NODE_OPTIONS'] = [process.env['NODE_OPTIONS'], `--import ${TSX_ESM}`]
    .filter((s) => s !== undefined && s !== '')
    .join(' ');
  process.env['CRTR_BROKER_ENGINE'] = FAKE_ENGINE;
  closeDb();

  // Neutralize ensureDaemon (spawn.ts calls it on every `node new`): write a
  // fake-live-daemon pidfile pointing at OUR (always-alive) pid, so
  // isDaemonRunning() is true and no REAL crtrd is spawned against the isolated
  // home. Required now that the broker's NODE_OPTIONS=--import tsx propagates to
  // the crtrd spawn (pre-broker, the tsx-less `node crtrd-cli.js` spawn silently
  // failed, so no daemon ever started); a stray real daemon would race the
  // in-process superviseTick + the fixed-clock crash/grace scenarios. The harness
  // drives the daemon pass itself via `tick()`. (fakeLiveDaemon pattern,
  // home-session.test.ts.) home/ is rmSync'd in dispose.
  writeFileSync(join(home, 'crtrd.pid'), String(process.pid), 'utf8');

  // Pre-create the isolated session on the DEFAULT server so teardown always
  // has a target and `node new`'s ensureSession no-ops.
  // ISOLATION ASSUMPTION (see header + MINOR-6): isolation is by SESSION NAME on
  // the DEFAULT tmux server only. The runtime CLI shells `tmux` with no `-L`, so
  // a custom-socket server (`tmux -L foo`) would be invisible to it; this harness
  // therefore assumes the default socket and only ever kill-sessions, never the
  // server.
  // HEADLESS: skip ALL eager tmux setup. No node in a headless run opens a
  // window, so there is no pane to pre-seed an env into and no session to pre-
  // create. (`node new --headless` may still lazily ensureSession() the isolated
  // name for home_session — dispose kill-sessions it regardless.)
  if (!headless) {
    spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', CROUTER, 'sleep 100000'], {
      stdio: 'ignore',
    });
    // Put CRTR_PI_BINARY in the SESSION environment so EVERY pane spawned in this
    // session inherits it — critically the fake-pi's OWN process, so when its real
    // stophook fires reviveInPlace (respawn-pane -k on its own pane, the refresh-
    // yield path) the in-process piCommand there substitutes the fake-pi too.
    spawnSync('tmux', ['set-environment', '-t', session, 'CRTR_PI_BINARY', FAKE_PI_BINARY], {
      stdio: 'ignore',
    });
    spawnSync('tmux', ['set-environment', '-t', session, 'CRTR_HOME', home], { stdio: 'ignore' });
  }

  const pidsToKill = new Set<number>();
  let nextRootSeq = 0;

  // -- env for a subprocess CLI invocation -----------------------------------
  function childEnv(nodeId: string | null): Record<string, string> {
    const e = cleanBaseEnv();
    e['CRTR_HOME'] = home;
    e['HOME'] = tmpHome;
    e['CRTR_NODE_SESSION'] = session;
    e['CRTR_PI_BINARY'] = FAKE_PI_BINARY;
    e['CRTR_BROKER_ENGINE'] = FAKE_ENGINE;
    if (nodeId !== null) e['CRTR_NODE_ID'] = nodeId;
    return e;
  }

  function nodeDir(id: string): string {
    return join(home, 'nodes', id);
  }
  function nodeDirs(): string[] {
    try {
      return readdirSync(join(home, 'nodes'));
    } catch {
      return [];
    }
  }
  function readLines(path: string): string[] {
    try {
      return readFileSync(path, 'utf8')
        .split('\n')
        .filter((l) => l.trim() !== '');
    } catch {
      return [];
    }
  }

  function cli(nodeId: string | null, args: string[]): CliResult {
    const res = spawnSync(process.execPath, ['--import', TSX_ESM, CLI_SRC, ...args], {
      cwd: CROUTER,
      env: childEnv(nodeId),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
    closeDb();
    let json: unknown;
    try {
      json = JSON.parse(res.stdout ?? '');
    } catch {
      /* not json */
    }
    return { code: res.status ?? -1, stdout: res.stdout ?? '', stderr: res.stderr ?? '', json };
  }

  // -- control channel -------------------------------------------------------
  function sendCmd(nodeId: string, cmd: Record<string, unknown>): void {
    const dir = nodeDir(nodeId);
    const tmp = join(dir, 'fake-pi.cmd.tmp');
    writeFileSync(tmp, JSON.stringify(cmd));
    renameSync(tmp, join(dir, 'fake-pi.cmd')); // atomic: host never reads a partial
  }
  function eventCount(nodeId: string, event: string): number {
    return readLines(join(nodeDir(nodeId), 'fake-pi.events.jsonl')).filter((l) => {
      try {
        return (JSON.parse(l) as { event?: string }).event === event;
      } catch {
        return false;
      }
    }).length;
  }
  function bootCount(nodeId: string): number {
    return readLines(join(nodeDir(nodeId), 'fake-pi.boots.jsonl')).length;
  }
  function injected(nodeId: string): Injected[] {
    return readLines(join(nodeDir(nodeId), 'fake-pi.injected.jsonl'))
      .map((l) => {
        try {
          return JSON.parse(l) as Injected;
        } catch {
          return null;
        }
      })
      .filter((x): x is Injected => x !== null);
  }

  // Wait for the host to have BEGUN dispatching agent_end (recorded before its
  // handlers run, so it survives a handler that tears the process down).
  async function awaitAgentEnd(nodeId: string, base: number, label: string): Promise<void> {
    await waitFor(() => eventCount(nodeId, 'agent_end') > base, {
      timeoutMs: 20_000,
      label,
    });
  }

  const harness: Harness = {
    home,
    session,

    spawnRoot(task, o = {}): string {
      const id = o.id ?? `root-${process.pid}-${nextRootSeq++}`;
      const meta: NodeMeta = {
        node_id: id,
        name: o.id ?? (task.slice(0, 24) || id),
        created: new Date().toISOString(),
        cwd: CROUTER,
        kind: o.kind ?? 'general',
        mode: o.mode ?? 'base',
        lifecycle: o.lifecycle ?? 'resident',
        status: 'active',
        parent: null,
      };
      createNode(meta);
      closeDb();
      return id;
    },

    fabricateBrokerNode(o = {}): string {
      const id = o.id ?? `brk-${process.pid}-${nextRootSeq++}`;
      const meta: NodeMeta = {
        node_id: id,
        name: id,
        created: new Date().toISOString(),
        cwd: CROUTER,
        host_kind: 'broker',
        kind: o.kind ?? 'developer',
        mode: o.mode ?? 'base',
        lifecycle: o.lifecycle ?? 'terminal',
        parent: o.parent ?? null,
        pi_session_id: o.pi_session_id ?? null,
        status: o.status ?? 'active',
        intent: o.intent ?? null,
        pi_pid: o.pi_pid ?? null,
      };
      createNode(meta);
      closeDb();
      return id;
    },

    async spawnChild(parentId, task, o = {}): Promise<string> {
      const before = new Set(nodeDirs());
      const args = ['node', 'new', task, '--parent', parentId, '--cwd', CROUTER];
      if (o.kind) args.push('--kind', o.kind);
      if (o.mode) args.push('--mode', o.mode);
      const res = cli(parentId, args);
      if (res.code !== 0) {
        throw new Error(
          `spawnChild(${parentId}) failed (code ${res.code})\n--stdout--\n${res.stdout}\n--stderr--\n${res.stderr}`,
        );
      }
      const added = nodeDirs().filter((d) => !before.has(d));
      if (added.length !== 1) {
        throw new Error(`spawnChild: expected exactly 1 new node dir, got [${added.join(', ')}]`);
      }
      const childId = added[0]!;
      await harness.awaitBoot(childId);
      return childId;
    },

    async spawnHeadlessChild(parentId, task, o = {}): Promise<string> {
      const before = new Set(nodeDirs());
      // POST-CUT: `--headless` is gone — EVERY node is a broker. spawnChild may
      // still open a background `crtr attach` viewer WINDOW (the §A.3 spawn UX),
      // but that viewer connects to the broker over view.sock as a SEPARATE
      // process and never touches the engine — so the broker-socket gates here
      // (zero-viewer dialogs, controller arbitration, one-writer) are unaffected
      // by it. The node itself is supervised by pid alone.
      const args = ['node', 'new', task, '--parent', parentId, '--cwd', CROUTER];
      if (o.kind) args.push('--kind', o.kind);
      if (o.mode) args.push('--mode', o.mode);
      const res = cli(parentId, args);
      if (res.code !== 0) {
        throw new Error(
          `spawnHeadlessChild(${parentId}) failed (code ${res.code})\n--stdout--\n${res.stdout}\n--stderr--\n${res.stderr}`,
        );
      }
      const added = nodeDirs().filter((d) => !before.has(d));
      if (added.length !== 1) {
        throw new Error(`spawnHeadlessChild: expected exactly 1 new node dir, got [${added.join(', ')}]`);
      }
      const childId = added[0]!;
      await harness.awaitBoot(childId);
      return childId;
    },

    async spawnHeadlessChildNoBoot(parentId, task, o = {}): Promise<string> {
      const before = new Set(nodeDirs());
      const args = ['node', 'new', task, '--parent', parentId, '--cwd', CROUTER];
      if (o.kind) args.push('--kind', o.kind);
      if (o.mode) args.push('--mode', o.mode);
      const res = cli(parentId, args);
      if (res.code !== 0) {
        throw new Error(
          `spawnHeadlessChildNoBoot(${parentId}) failed (code ${res.code})\n--stdout--\n${res.stdout}\n--stderr--\n${res.stderr}`,
        );
      }
      const added = nodeDirs().filter((d) => !before.has(d));
      if (added.length !== 1) {
        throw new Error(`spawnHeadlessChildNoBoot: expected exactly 1 new node dir, got [${added.join(', ')}]`);
      }
      return added[0]!;
    },

    cli,

    async turn(nodeId, text = ''): Promise<void> {
      const base = eventCount(nodeId, 'agent_end');
      sendCmd(nodeId, { cmd: 'turn', id: `turn-${Date.now()}`, text });
      await awaitAgentEnd(nodeId, base, `turn agent_end for ${nodeId}`);
    },

    async stop(nodeId, reason = 'stop'): Promise<void> {
      const base = eventCount(nodeId, 'agent_end');
      sendCmd(nodeId, { cmd: 'stop', id: `stop-${Date.now()}`, reason });
      await awaitAgentEnd(nodeId, base, `stop agent_end for ${nodeId}`);
    },

    async finish(nodeId, finalText): Promise<void> {
      const res = cli(nodeId, ['push', 'final', finalText]);
      if (res.code !== 0) {
        throw new Error(`finish(${nodeId}): push final failed (code ${res.code})\n${res.stderr}`);
      }
      // Fire agent_end so the now-done node runs the real (b) done branch
      // (null presence + ctx.shutdown → window closes), exactly as real pi would.
      const base = eventCount(nodeId, 'agent_end');
      sendCmd(nodeId, { cmd: 'stop', id: `finish-${Date.now()}` });
      await awaitAgentEnd(nodeId, base, `finish agent_end for ${nodeId}`);
      await harness.waitForPaneGone(nodeId);
    },

    async yieldNode(nodeId, note): Promise<void> {
      const res = cli(nodeId, ['node', 'yield', note]);
      if (res.code !== 0) {
        throw new Error(`yieldNode(${nodeId}): node yield failed (code ${res.code})\n${res.stderr}`);
      }
      // node yield set intent=refresh (active, kept). Fire agent_end so the real
      // (b') branch runs reviveInPlace (respawn-pane -k) IN the fake-pi's pane —
      // a FRESH fake-pi boots (resume); its session_start clears intent=refresh.
      const baseBoots = bootCount(nodeId);
      sendCmd(nodeId, { cmd: 'stop', id: `yield-${Date.now()}` });
      await waitFor(() => bootCount(nodeId) > baseBoots, {
        timeoutMs: 30_000,
        label: `fresh boot after yield for ${nodeId}`,
      });
      await waitFor(
        () => {
          closeDb();
          const n = getNode(nodeId);
          return n?.intent == null && n?.status === 'active';
        },
        { timeoutMs: 20_000, label: `intent=refresh cleared after yield for ${nodeId}` },
      );
      await harness.awaitBoot(nodeId, { minCount: baseBoots + 1 });
    },

    async tick(now?: number): Promise<void> {
      closeDb();
      await superviseTick(now);
      closeDb();
    },

    async awaitBoot(nodeId, o = {}): Promise<BootProof> {
      const minCount = o.minCount ?? 1;
      const bootsPath = join(nodeDir(nodeId), 'fake-pi.boots.jsonl');
      const errPath = join(nodeDir(nodeId), 'fake-pi.error');
      const lines = await waitFor(
        () => {
          const ls = readLines(bootsPath);
          return ls.length >= minCount ? ls : null;
        },
        {
          timeoutMs: o.timeoutMs ?? 30_000,
          label:
            `fake-pi boot >= ${minCount} for ${nodeId}` +
            (existsSync(errPath) ? ` (error file: ${readFileSync(errPath, 'utf8')})` : ''),
        },
      );
      const boot = JSON.parse(lines[lines.length - 1]!) as BootProof;
      if (typeof boot.pid === 'number') pidsToKill.add(boot.pid);
      return boot;
    },

    async awaitWake(nodeId, o = {}): Promise<string[]> {
      const sinceCount = o.sinceCount ?? 0;
      const match = o.match;
      const fresh = await waitFor(
        () => {
          const all = injected(nodeId).slice(sinceCount);
          if (all.length === 0) return null;
          if (match && !all.some((e) => match.test(e.content))) return null;
          return all;
        },
        { timeoutMs: o.timeoutMs ?? 15_000, label: `wake delivery for ${nodeId}` },
      );
      return fresh.map((e) => e.content);
    },

    async waitForStatus(nodeId, status, timeoutMs = 20_000): Promise<void> {
      await waitFor(
        () => {
          closeDb();
          return getNode(nodeId)?.status === status;
        },
        { timeoutMs, label: `status=${status} for ${nodeId}` },
      );
    },

    async waitForPaneGone(nodeId, timeoutMs = 20_000): Promise<void> {
      await waitFor(
        () => {
          closeDb();
          return !isFocused(nodeId);
        },
        { timeoutMs, label: `viewer gone for ${nodeId}` },
      );
    },

    waitFor,

    node(nodeId): NodeMeta | null {
      closeDb();
      return getNode(nodeId);
    },
    status(nodeId): NodeStatus | null {
      closeDb();
      return getNode(nodeId)?.status ?? null;
    },
    paneAlive(nodeId): boolean {
      closeDb();
      return isFocused(nodeId);
    },
    inbox(nodeId): InboxEntry[] {
      closeDb();
      return readInboxSince(nodeId);
    },
    injected,
    fakeCmd(nodeId, cmd): void {
      sendCmd(nodeId, cmd);
    },
    dialogResults(nodeId): { resolved: unknown; ms: number }[] {
      return readLines(join(nodeDir(nodeId), 'fake-pi.dialog.jsonl'))
        .map((l) => {
          try {
            return JSON.parse(l) as { resolved: unknown; ms: number };
          } catch {
            return null;
          }
        })
        .filter((x): x is { resolved: unknown; ms: number } => x !== null);
    },
    brokerSock(nodeId): string {
      return join(nodeDir(nodeId), 'view.sock');
    },
    bootCount,
    subscribers(nodeId): { node_id: string; active: boolean }[] {
      closeDb();
      return subscribersOf(nodeId).map((s) => ({ node_id: s.node_id, active: s.active }));
    },
    subscriptions(nodeId): { node_id: string; active: boolean }[] {
      closeDb();
      return subscriptionsOf(nodeId).map((s) => ({ node_id: s.node_id, active: s.active }));
    },

    async dispose(): Promise<void> {
      spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
      // Best-effort: a superviseTick-triggered revive of a fabricated node fires
      // a DETACHED throwaway broker (it loads the real SDK; the rmSync of home
      // below makes a mid-boot one self-terminate when its files vanish). Kill
      // any that recorded a pid first — scan every node's row pid + recorded
      // boot pids and add them to the kill set.
      closeDb();
      for (const d of nodeDirs()) {
        try {
          const n = getNode(d);
          if (n?.pi_pid != null) pidsToKill.add(n.pi_pid);
        } catch {
          /* row gone — fine */
        }
        for (const line of readLines(join(nodeDir(d), 'fake-pi.boots.jsonl'))) {
          try {
            const p = (JSON.parse(line) as { pid?: number }).pid;
            if (typeof p === 'number') pidsToKill.add(p);
          } catch {
            /* skip */
          }
        }
      }
      for (const p of pidsToKill) {
        try {
          process.kill(p, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
      closeDb();
      rmSync(home, { recursive: true, force: true });
      rmSync(tmpHome, { recursive: true, force: true });
      if (origHome === undefined) delete process.env['CRTR_HOME'];
      else process.env['CRTR_HOME'] = origHome;
      if (origPiBinary === undefined) delete process.env['CRTR_PI_BINARY'];
      else process.env['CRTR_PI_BINARY'] = origPiBinary;
      if (origNodeSession === undefined) delete process.env['CRTR_NODE_SESSION'];
      else process.env['CRTR_NODE_SESSION'] = origNodeSession;
      if (origNodeOptions === undefined) delete process.env['NODE_OPTIONS'];
      else process.env['NODE_OPTIONS'] = origNodeOptions;
      if (origBrokerEngine === undefined) delete process.env['CRTR_BROKER_ENGINE'];
      else process.env['CRTR_BROKER_ENGINE'] = origBrokerEngine;
    },
  };

  return harness;
}
