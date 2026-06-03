// `crtr daemon` — thin supervisor daemon management.
//
// The daemon (crtrd) polls active+idle nodes and handles window exit:
//   • crash (window gone, no intent) → mark 'dead'
//   • refresh-yield (intent=refresh) → fresh respawn
//
// This subtree starts, checks, and stops the daemon process.

import { defineLeaf, defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { spawnDaemon } from '../daemon/manage.js';
import { isDaemonRunning, readPidfile, isPidAlive } from '../daemon/crtrd.js';

// ---------------------------------------------------------------------------
// daemon start
// ---------------------------------------------------------------------------

const daemonStart = defineLeaf({
  name: 'start',
  help: {
    name: 'daemon start',
    summary: 'start the crtrd supervisor daemon in the background (no-op if already running)',
    params: [],
    output: [
      { name: 'started', type: 'boolean', required: true, constraint: 'True when a new daemon process was spawned; false when one was already running.' },
      { name: 'pid', type: 'number', required: false, constraint: 'PID of the newly spawned daemon.' },
      { name: 'existing_pid', type: 'number', required: false, constraint: 'PID of the already-running daemon (when started=false).' },
    ],
    outputKind: 'object',
    effects: [
      'Spawns dist/daemon/crtrd-cli.js detached + unref\'d; it outlives this process.',
      'Writes a pidfile at crtrHome()/crtrd.pid.',
    ],
  },
  run: async (_input) => {
    const result = spawnDaemon();
    return result as unknown as Record<string, unknown>;
  },
});

// ---------------------------------------------------------------------------
// daemon status
// ---------------------------------------------------------------------------

const daemonStatus = defineLeaf({
  name: 'status',
  help: {
    name: 'daemon status',
    summary: 'check whether the crtrd supervisor daemon is currently running',
    params: [],
    output: [
      { name: 'running', type: 'boolean', required: true, constraint: 'True when the daemon is alive.' },
      { name: 'pid', type: 'number', required: false, constraint: 'PID of the running daemon.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: reads the pidfile and probes the pid.'],
  },
  run: async (_input) => {
    const pid = readPidfile();
    const running = pid !== null && isPidAlive(pid);
    return running
      ? { running: true, pid }
      : { running: false };
  },
});

// ---------------------------------------------------------------------------
// daemon stop
// ---------------------------------------------------------------------------

const daemonStop = defineLeaf({
  name: 'stop',
  help: {
    name: 'daemon stop',
    summary: 'send SIGTERM to the crtrd supervisor daemon',
    params: [],
    output: [
      { name: 'stopped', type: 'boolean', required: true, constraint: 'True when a running daemon was signaled. False when no daemon was found.' },
      { name: 'pid', type: 'number', required: false, constraint: 'PID that was signaled.' },
    ],
    outputKind: 'object',
    effects: ['Sends SIGTERM to the recorded pid; the daemon removes its pidfile on exit.'],
  },
  run: async (_input) => {
    const pid = readPidfile();
    if (pid === null || !isPidAlive(pid)) {
      return { stopped: false };
    }
    try {
      process.kill(pid, 'SIGTERM');
      return { stopped: true, pid };
    } catch (err) {
      throw new InputError({
        error: 'kill_failed',
        message: `failed to signal pid ${pid}: ${(err as Error).message}`,
        next: 'The pidfile may be stale; remove ~/.crtr/crtrd.pid manually.',
      });
    }
  },
});

// ---------------------------------------------------------------------------
// registerDaemon
// ---------------------------------------------------------------------------

export function registerDaemon(): BranchDef {
  return defineBranch({
    name: 'daemon',
    rootEntry: {
      concept: 'the background supervisor that watches node window exit and auto-revives nodes',
      desc: 'start, check, and stop the crtrd supervisor daemon',
      useWhen: 'managing the background daemon that keeps canvas nodes alive',
    },
    help: {
      name: 'daemon',
      summary: 'manage the crtrd canvas supervisor daemon',
      model:
        'crtrd is a thin background daemon that polls active+idle nodes and acts on window exit: crashed windows become dead; refresh-yield windows get a fresh respawn. It holds no orchestration logic — just process supervision.',
      children: [
        { name: 'start', desc: 'start the daemon in the background', useWhen: 'bringing up the supervisor for the first time in a session' },
        { name: 'status', desc: 'check whether the daemon is running', useWhen: 'verifying the daemon is up before spawning canvas nodes' },
        { name: 'stop', desc: 'stop the running daemon', useWhen: 'shutting down supervision' },
      ],
    },
    children: [daemonStart, daemonStatus, daemonStop],
  });
}
