// `crtr canvas revive` — explicit node revival.
//
// Bypasses the daemon: directly relaunches the broker engine for a node that is
// done, idle, or dead. Default behavior resumes the saved pi conversation
// (--session <id>); pass --fresh to start a clean pi session against the context dir.
//
// `--all` sweeps EVERY disconnected node (engine not running, resumable session)
// in one shot — the recovery for a reboot / mass-crash / daemon-down-a-while
// event. It is a two-step gate: run it once to PREVIEW the candidates (nothing is
// launched), then confirm to actually revive them.

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { reviveNode } from '../core/runtime/revive.js';
import { listDisconnected, reviveAll } from '../core/runtime/revive-all.js';
import { waitForBrokerViewSocket } from '../core/runtime/placement.js';
import { getNode, fullName } from '../core/canvas/index.js';
import { isPidAlive } from '../core/canvas/pid.js';
import { readErrorStall } from '../core/runtime/error-stall.js';

// ---------------------------------------------------------------------------
// revive node
// ---------------------------------------------------------------------------

export const reviveLeaf: LeafDef = defineLeaf({
  name: 'revive',
  description: 'reopen a window for a done/idle/dead/canceled node, or --all disconnected nodes',
  whenToUse: 'you want to bring a dormant node back yourself — reopen a window for one that is done, idle, dead, or canceled: resume a node you closed with `node close`, reopen a finished worker for a follow-up, or restart a crashed one now instead of waiting. It resumes the saved conversation by default, or can restart the node clean. Pass `--all` instead of a node id to bring back EVERY disconnected node at once (engine not running but a saved session intact) — the recovery after a reboot, a killed login/tmux session, a mass crash, or the daemon being down a while. You rarely need this for crashes — the daemon auto-revives those; reach for it to bring a node back on demand, to revive a canceled node the daemon will never touch on its own, or to mass-reconnect survivors after a disconnect event',
  help: {
    name: 'canvas revive',
    summary: 'relaunch a node\'s broker engine (resuming its saved conversation), or --all disconnected nodes',
    params: [
      {
        kind: 'positional',
        name: 'node',
        required: false,
        constraint: 'Node id to revive. Omit when using --all.',
      },
      {
        kind: 'flag',
        name: 'all',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'Revive EVERY disconnected node (engine not running, resumable saved session) — excludes done/canceled (terminal-by-choice). Run it once to PREVIEW the candidates; nothing is launched until you confirm. Mutually exclusive with a node id.',
      },
      {
        kind: 'flag',
        name: 'fresh',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'When set, start a clean pi session (no --session). Default: resume the saved conversation. Ignored with --all (which always resumes).',
      },
      {
        kind: 'flag',
        name: 'now',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'On-demand kick of a HANGING node (parked on an exhausted-retry engine error, broker still alive). Its broker pid is alive, so an ordinary revive no-ops (double-launch guard) — --now SIGTERMs the live broker instead, so the daemon\'s crash→grace→resume path brings it back in ~20s instead of waiting out the 5-min auto-revive grace. Only valid for a node that has an error-stall marker AND a live pid. Mutually exclusive with --all/--fresh.',
      },
      // --force is a DELIBERATELY UNDOCUMENTED confirmation gate for --all (hidden
      // from -h; see FlagParam.hidden). Silas's intent (2026-06-13): a mass revive
      // can have large, unforeseen consequences, so the agent must NOT be able to
      // discover a one-shot bypass by reading the schema. The unforced --all path
      // PREVIEWS the candidates and instructs the agent to double-check with the
      // USER before re-running; only then, having been told the flag, does it pass
      // --force. Documenting it here would defeat that gate.
      {
        kind: 'flag',
        name: 'force',
        type: 'bool',
        required: false,
        default: false,
        hidden: true,
        constraint: 'Confirm a --all sweep (internal gate; see code comment).',
      },
    ],
    output: [
      { name: 'window', type: 'string', required: false, constraint: 'Always null — the revived broker is headless and opens no tmux window. Kept for caller back-compat.' },
      { name: 'session', type: 'string', required: false, constraint: 'The node\'s last live location session, or null — the headless broker has no tmux session of its own.' },
      { name: 'resumed', type: 'boolean', required: false, constraint: 'True when pi was told to --session the saved conversation. Single-node revive only.' },
      { name: 'ready', type: 'boolean', required: false, constraint: 'True when the revived broker\'s view.sock accepted a connection before return — the node is immediately attachable/drivable. Single-node revive only.' },
      { name: 'mode', type: 'string', required: false, constraint: '"preview" (the --all candidate list, nothing launched), "revived" (the --all sweep ran), or absent for a single-node revive.' },
      { name: 'candidates', type: 'string', required: false, constraint: '--all preview: the node ids that WOULD be revived (newline-joined). Empty when none are disconnected.' },
      { name: 'revived', type: 'string', required: false, constraint: '--all sweep: the node ids whose broker engine was relaunched (newline-joined).' },
      { name: 'failed', type: 'string', required: false, constraint: '--all sweep: node ids whose relaunch threw, with the error (newline-joined). Absent when none failed.' },
    ],
    outputKind: 'object',
    effects: [
      'Launches the node\'s detached headless broker engine (no tmux window).',
      'Updates the node\'s canvas record: status=active, intent=null.',
      'Blocks until the broker\'s view.sock accepts a connection (up to ~30s), so a caller can attach/dial immediately on return.',
      '--all without confirmation launches NOTHING — it only previews the disconnected candidates.',
    ],
  },
  run: async (input) => {
    const all = (input['all'] as boolean | undefined) ?? false;
    const nodeId = input['node'] as string | undefined;

    if (all) {
      if (nodeId !== undefined) {
        throw new InputError({
          error: 'conflicting_args',
          message: '`--all` reconnects every disconnected node; do not also pass a node id.',
          next: 'Run `crtr canvas revive --all` (no node id), or `crtr canvas revive <node>` for one.',
        });
      }
      return runReviveAll(input);
    }

    if (nodeId === undefined) {
      throw new InputError({
        error: 'missing_parameter',
        message: 'pass a node id to revive, or `--all` to reconnect every disconnected node.',
        next: 'Run `crtr canvas revive <node>` or `crtr canvas revive --all`. List nodes with `crtr node inspect list`.',
      });
    }

    const fresh = (input['fresh'] as boolean | undefined) ?? false;
    const now = (input['now'] as boolean | undefined) ?? false;

    // Validate the node exists before attempting revival.
    const meta = getNode(nodeId);
    if (meta === null) {
      throw new InputError({
        error: 'not_found',
        message: `no node: ${nodeId}`,
        next: 'List nodes with `crtr node inspect list`.',
      });
    }

    // --now: the on-demand kick for a hanging node. The broker is ALIVE (so
    // reviveNode would no-op the double-launch guard) — SIGTERM it so the daemon's
    // ordinary crash→grace→resume path recovers it on the saved session, the same
    // thing the daemon does at the 5-min grace, just on demand. Gated on a live
    // pid AND an error-stall marker so it can't be used to nuke a healthy node.
    if (now) {
      const pid = meta.pi_pid;
      const stall = readErrorStall(nodeId);
      if (pid == null || !isPidAlive(pid)) {
        throw new InputError({
          error: 'not_hanging',
          message: `${nodeId} has no live broker — nothing to kick. --now is for a HANGING node (live broker parked on an engine error).`,
          next: 'Revive a dormant node with `crtr canvas revive ' + nodeId + '` (no --now).',
        });
      }
      if (stall === null) {
        throw new InputError({
          error: 'not_hanging',
          message: `${nodeId} is live but not hanging (no error-stall marker) — --now refuses to SIGTERM a healthy node.`,
          next: 'Use --now only on a node the canvas shows as hanging (⚠). For a routine relaunch, omit --now.',
        });
      }
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* best-effort: the broker may have just died; the daemon owns the resume */
      }
      return {
        window: null,
        session: meta.tmux_session ?? null,
        kicked: true,
        message: `Sent SIGTERM to ${fullName(meta)} (${nodeId}, pid ${pid}). The daemon will resume it on the saved session within ~20s (crash→grace→resume).`,
      };
    }

    const result = reviveNode(nodeId, { resume: !fresh });
    // Revive returns once the broker process is launched, which can be seconds
    // before its view.sock listens. Callers (attach, the web shell's Wake) dial
    // immediately on return, so block here until the socket accepts.
    const ready = waitForBrokerViewSocket(nodeId);
    return {
      window: result.window ?? undefined,
      session: result.session,
      resumed: result.resumed,
      ready,
    };
  },
});

// ---------------------------------------------------------------------------
// revive --all
// ---------------------------------------------------------------------------

/** One line per candidate: `<id>  <full name>  [<status>]`. */
function describe(ids: { node_id: string }[]): string {
  return ids
    .map((m) => {
      const meta = getNode(m.node_id);
      const name = meta !== null ? fullName(meta) : m.node_id;
      const status = meta !== null ? meta.status : '?';
      return `  ${m.node_id}  ${name}  [${status}]`;
    })
    .join('\n');
}

/** The --all sweep, gated on confirmation. Without `--force` it PREVIEWS the
 *  disconnected candidates and returns WITHOUT launching anything, telling the
 *  agent to double-check with the user first (a mass revive can have large,
 *  unforeseen consequences). With `--force` it actually resumes them all. */
function runReviveAll(input: Record<string, unknown>): Record<string, unknown> {
  const force = (input['force'] as boolean | undefined) ?? false;
  const candidates = listDisconnected();

  if (candidates.length === 0) {
    return {
      mode: 'preview',
      candidates: '',
      message: 'No disconnected nodes — every node with a resumable session already has a running engine. Nothing to revive.',
    };
  }

  if (!force) {
    const list = describe(candidates);
    return {
      mode: 'preview',
      candidates: candidates.map((m) => m.node_id).join('\n'),
      // Directive for the AGENT (not a documented flag): this is a preview, and a
      // mass revive can have large, unforeseen consequences — so confirm with the
      // USER before proceeding, then re-run to actually revive.
      message:
        `${candidates.length} disconnected node(s) WOULD be revived (RESUME). Nothing has been launched yet:\n\n` +
        `${list}\n\n` +
        `Reviving all of these at once can have large, unforeseen consequences (a flood of resumed engines, ` +
        `cost, side effects from each node continuing its work). This is a preview only — DOUBLE-CHECK WITH THE ` +
        `USER that they want every node above brought back before you proceed. Once they confirm, re-run the ` +
        `revive with confirmation to actually relaunch them.`,
    };
  }

  const res = reviveAll();
  const out: Record<string, unknown> = {
    mode: 'revived',
    revived: res.revived.join('\n'),
    message: `Revived ${res.revived.length} disconnected node(s) (RESUME).`,
  };
  if (res.failed.length > 0) {
    out['failed'] = res.failed.map((f) => `${f.node_id}: ${f.error}`).join('\n');
    out['message'] =
      `Revived ${res.revived.length} of ${res.revived.length + res.failed.length} disconnected node(s); ` +
      `${res.failed.length} failed to relaunch (see failed).`;
  }
  return out;
}
