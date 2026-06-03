// Daemon management helpers — importable without the full command tree.
//
// spawnDaemon() is the low-level spawn call shared by `crtr canvas daemon start` and
// ensureDaemon(). ensureDaemon() is the silent "start if not running" front-
// door helper called by the canvas runtime before spawning child nodes.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import { crtrHome } from '../core/canvas/paths.js';
import { isDaemonRunning, readPidfile } from './crtrd.js';

// ---------------------------------------------------------------------------
// Entry point resolution
// ---------------------------------------------------------------------------

/** Resolve the absolute path to the crtrd-cli entry point.
 *
 *  At runtime this file is dist/daemon/manage.js; the entry lives at
 *  dist/daemon/crtrd-cli.js (sibling in the same directory). */
function resolveCrtrdEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, 'crtrd-cli.js');
}

// ---------------------------------------------------------------------------
// spawnDaemon — low-level spawn
// ---------------------------------------------------------------------------

export interface SpawnDaemonResult {
  /** True when a new daemon process was spawned. */
  started: boolean;
  /** PID of the newly spawned process, if started. */
  pid?: number;
  /** PID of the already-running daemon, if it was already up. */
  existing_pid?: number;
}

/** Spawn crtrd detached. Returns immediately; the child outlives this process.
 *
 *  If the daemon is already running, returns {started:false, existing_pid}.
 *  If spawning fails (e.g. missing dist — run `npm run build` first), throws. */
export function spawnDaemon(): SpawnDaemonResult {
  if (isDaemonRunning()) {
    return { started: false, existing_pid: readPidfile() ?? undefined };
  }

  // Ensure the canvas home directory exists so the daemon can write its pidfile.
  mkdirSync(crtrHome(), { recursive: true });

  const entry = resolveCrtrdEntry();
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
  });

  const pid = child.pid;
  child.unref();

  return { started: true, pid };
}

// ---------------------------------------------------------------------------
// ensureDaemon — fire-and-forget front-door helper
// ---------------------------------------------------------------------------

/** Start the daemon if it is not already running. No-op if already up.
 *  Silently swallows spawn errors (the canvas still works without the daemon;
 *  nodes just won't be auto-revived). */
export function ensureDaemon(): void {
  try {
    if (!isDaemonRunning()) spawnDaemon();
  } catch {
    // Intentionally silent — a missing dist/daemon/crtrd-cli.js (dev mode,
    // pre-build) must not break the calling command.
  }
}
