// The spawn orchestration — the one place that turns "I want a node here" into
// a running pi process on the canvas. Composes canvas (birth + spine), persona
// (resolve), launch (pi argv), and tmux (placement).
//
//   bootRoot   — a user-opened entry point (bare `crtr`).
//                Resident. Runs pi in the foreground (inline) or its own session.
//   spawnChild — a background worker spawned by a live node (`crtr node new`).
//                Terminal. Opens a non-focus-stealing window under the root.

import { spawnSync } from 'node:child_process';
import { FRONT_DOOR_ENV } from './front-door.js';
import { spawnNode, currentNodeContext, nodeEnv } from './nodes.js';
import { buildLaunchSpec, buildPiArgv } from './launch.js';
import { writeGoal } from './kickoff.js';
import {
  ensureSession,
  openNodeWindow,
  piCommand,
  currentTmux,
  inTmux,
  nodeSession,
  installMenuBinding,
  installNavBindings,
} from './tmux.js';
import { updateNode, getNode, type NodeMeta, type Mode } from '../canvas/index.js';
import { ensureDaemon } from '../../daemon/manage.js';

// All node windows live in one shared session — see `nodeSession()` in tmux.js.

// ---------------------------------------------------------------------------
// bootRoot — the front door
// ---------------------------------------------------------------------------

export interface BootRootOpts {
  cwd: string;
  kind?: string;
  name?: string;
  /** Optional starter prompt (bare `crtr` requires none). */
  prompt?: string;
  /** 'inline'  — exec pi in the current terminal (bare `crtr`).
   *  'session' — create a dedicated tmux session and run pi there (`session new`). */
  placement: 'inline' | 'session';
}

/** Create a root node and bring up its pi. Returns the node; for 'inline' this
 *  only returns after pi exits (it took over the terminal). */
export function bootRoot(opts: BootRootOpts): NodeMeta {
  // The thin supervisor must be up before any node exists, so a refresh-yield
  // or crash can be reaped/revived. Idempotent.
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const kind = opts.kind ?? 'general';
  // A born-resident root starts in base mode; it earns the orchestrator persona
  // the first time it delegates (or on promotion). Resident lifecycle either way.
  const { launch } = buildLaunchSpec(kind, 'base');
  const meta = spawnNode({
    kind,
    mode: 'base',
    lifecycle: 'resident',
    cwd: opts.cwd,
    name: opts.name ?? kind,
    parent: null,
    launch,
  });

  // Persist the spawning prompt as the goal so a fresh revive can re-read its
  // mandate (bare `crtr` has none — writeGoal no-ops on empty).
  if (opts.prompt !== undefined) writeGoal(meta.node_id, opts.prompt);

  // Every node window — root or child — lives in the one shared session.
  const session = nodeSession();
  ensureSession(session, opts.cwd);
  // Make the Alt+C action menu + Alt+] / Alt+[ nav keys live on this server
  // (idempotent, in-tmux only).
  if (inTmux()) {
    try { installMenuBinding(); } catch { /* best-effort */ }
    try { installNavBindings(); } catch { /* best-effort */ }
  }

  if (opts.placement === 'session') {
    updateNode(meta.node_id, { tmux_session: session });
    const withSession = getNode(meta.node_id) as NodeMeta;
    const inv = buildPiArgv(withSession, { prompt: opts.prompt });
    const env = { ...inv.env, CRTR_ROOT_SESSION: session, [FRONT_DOOR_ENV]: '1' };
    const win = openNodeWindow({
      session,
      name: meta.name,
      cwd: opts.cwd,
      env,
      command: piCommand(inv.argv),
    });
    updateNode(meta.node_id, { window: win });
    return getNode(meta.node_id) as NodeMeta;
  }

  // inline: the root's pi takes over THIS terminal, so its own window stays
  // where the user is (its tmux_session tracks that real pane so supervision
  // sees it alive). But its children spawn into the shared global session via
  // CRTR_ROOT_SESSION — they never clutter the user's working session.
  const here = currentTmux();
  const adopted = here?.session ?? session;
  updateNode(meta.node_id, { tmux_session: adopted, window: here?.window ?? null });
  const withSession = getNode(meta.node_id) as NodeMeta;
  const inv = buildPiArgv(withSession, { prompt: opts.prompt });
  const env = { ...process.env, ...inv.env, CRTR_ROOT_SESSION: session, [FRONT_DOOR_ENV]: '1' } as NodeJS.ProcessEnv;
  const r = spawnSync('pi', inv.argv, { stdio: 'inherit', env });
  process.exit(r.status ?? 0);
}

// ---------------------------------------------------------------------------
// spawnChild — background delegation
// ---------------------------------------------------------------------------

export interface SpawnChildOpts {
  kind: string;
  mode?: Mode;
  cwd: string;
  name?: string;
  prompt: string;
  /** Override the parent (defaults to the calling node from env). */
  parent?: string;
}

export interface SpawnChildResult {
  node: NodeMeta;
  window: string | null;
  session: string;
}

/** Spawn a terminal worker as a background window under the root session.
 *  The parent auto-subscribes (active) to it via spawnNode. */
export function spawnChild(opts: SpawnChildOpts): SpawnChildResult {
  try { ensureDaemon(); } catch { /* daemon is best-effort */ }
  const ctx = currentNodeContext();
  const parent = opts.parent ?? ctx.nodeId;
  if (parent === null || parent === undefined) {
    throw new Error('spawnChild requires a calling node (CRTR_NODE_ID) or an explicit parent');
  }

  const mode = opts.mode ?? 'base';
  const { launch } = buildLaunchSpec(opts.kind, mode);
  const meta = spawnNode({
    kind: opts.kind,
    mode,
    lifecycle: 'terminal',
    cwd: opts.cwd,
    name: opts.name ?? opts.kind,
    parent,
    launch,
  });

  // Persist the task as the child's goal for a fresh revive to re-read.
  writeGoal(meta.node_id, opts.prompt);

  // Children always land in the shared global session: inherited from the
  // parent's CRTR_ROOT_SESSION, else the default node session.
  let session = process.env['CRTR_ROOT_SESSION'];
  if (session === undefined || session === '') session = nodeSession();
  ensureSession(session, opts.cwd);

  const inv = buildPiArgv(meta, { prompt: opts.prompt });
  const env = { ...inv.env, CRTR_ROOT_SESSION: session };
  const window = openNodeWindow({
    session,
    name: meta.name,
    cwd: opts.cwd,
    env,
    command: piCommand(inv.argv),
  });

  const saved = updateNode(meta.node_id, { tmux_session: session, window });
  return { node: saved, window, session };
}
