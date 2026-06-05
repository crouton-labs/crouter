// `crtr canvas chord` — the tmux prefix-menu dispatcher.
//
// The alt+c display-menu can't see the cursor node or read config at popup time
// — it only knows the active pane. So every config-driven prefix chord routes
// through this one leaf: tmux passes `--pane '#{pane_id}'` + `--key <k>`, and
// the dispatcher resolves the node in that pane, reads
// `canvasNav.prefixBinds[key]`, interpolates the template vars, and execs
// `crtr <argv>`. This keeps the menu static while the behaviour stays fully
// config-driven (no per-node menu rebuild).
//
// Two special cases bypass the bind table:
//   • a digit key 1..9 → focus report N (the Nth live report of the pane node)
//   • a bind whose `run` is the sentinel `__graph__` → send-keys `/graph` into
//     the pane (toggles the in-pi GRAPH modal); the menu emits this directly so
//     the dispatcher only handles it defensively.
//
// execFile (never `sh -c`) runs the interpolated argv, so a node name with
// shell metacharacters can never inject — each argv element is literal.

import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { readConfig } from '../core/config.js';
import { sendKeysEnter } from '../core/runtime/tmux.js';
import { nodeInPane } from './node.js';
import {
  getNode,
  subscribersOf,
  subscriptionsOf,
  view,
  fullName,
} from '../core/canvas/index.js';

const pexec = promisify(execFile);

/** Template vars available to a `run` string. Single-valued vars interpolate
 *  in place (preserving spaces, e.g. a node name); `{subtree}` is multi-valued
 *  and a bare `{subtree}` token expands to several argv elements. */
function buildVars(selfId: string): Record<string, string> {
  const node = getNode(selfId);
  const manager = subscribersOf(selfId)[0]?.node_id ?? '';
  return {
    id: selfId,
    self: selfId,
    lane: selfId,
    name: node !== null ? fullName(node) : selfId,
    manager,
    subtree: view(selfId).join(' '),
  };
}

/** Split a `run` string argv-style and interpolate the template vars. A bare
 *  `{subtree}` token expands to several argv elements; every other placeholder
 *  is substituted in place (kept as one element so a multi-word name survives
 *  as a single argument under execFile). */
function interpolateArgv(run: string, vars: Record<string, string>): string[] {
  const out: string[] = [];
  for (const tok of run.split(/\s+/).filter((t) => t !== '')) {
    if (tok === '{subtree}') {
      for (const part of (vars['subtree'] ?? '').split(/\s+/).filter((p) => p !== '')) out.push(part);
      continue;
    }
    out.push(tok.replace(/\{(\w+)\}/g, (_, name: string) => vars[name] ?? ''));
  }
  return out;
}

export const chordLeaf: LeafDef = defineLeaf({
  name: 'chord',
  description: 'tmux prefix-menu dispatcher (bound by alt+c; not run by hand)',
  whenToUse: 'never directly — the alt+c menu routes config-driven chords through it',
  help: {
    name: 'canvas chord',
    summary:
      'tmux prefix-menu dispatcher — resolve the node in --pane, look up canvasNav.prefixBinds[--key], interpolate, and exec `crtr <argv>`. Bound by the alt+c menu; not meant to be run by hand.',
    params: [
      {
        kind: 'flag',
        name: 'pane',
        type: 'string',
        required: false,
        constraint: 'tmux pane id whose node the chord acts on. Defaults to $TMUX_PANE / your current pane.',
      },
      {
        kind: 'flag',
        name: 'key',
        type: 'string',
        required: true,
        constraint: 'The chord key pressed after alt+c (e.g. m, e, or a digit 1-9 for focus report N).',
      },
    ],
    output: [
      { name: 'ran', type: 'boolean', required: true, constraint: 'True when an action was dispatched.' },
      { name: 'key', type: 'string', required: true, constraint: 'Echo of the chord key.' },
      { name: 'node_id', type: 'string', required: false, constraint: 'The node the chord resolved against.' },
      { name: 'action', type: 'string', required: false, constraint: 'What ran: a crtr argv string, "graph-toggle", or "noop".' },
    ],
    outputKind: 'object',
    effects: ['Runs a `crtr` subcommand (focus/close/tmux-spread/…) or sends `/graph` into the pane, per the matched bind.'],
  },
  run: async (input) => {
    const pane = (input['pane'] as string | undefined) ?? process.env['TMUX_PANE'];
    const key = (input['key'] as string).trim();

    const selfId = nodeInPane(pane);
    if (selfId === undefined) {
      throw new InputError({
        error: 'no_node',
        message: 'no node found in this pane',
        next: 'Run from inside an agent\'s pane, or pass --pane <pane-id>.',
      });
    }

    // Digit keys 1..9 → focus the Nth live report (generated, not a bind entry).
    if (/^[1-9]$/.test(key)) {
      const n = parseInt(key, 10);
      const reports = subscriptionsOf(selfId)
        .map((r) => r.node_id)
        .filter((id) => {
          const s = getNode(id)?.status;
          return s === 'active' || s === 'idle';
        });
      const target = reports[n - 1];
      if (target === undefined) return { ran: false, key, node_id: selfId, action: 'noop' };
      try {
        await pexec('crtr', ['node', 'focus', target], { timeout: 15_000 });
      } catch {
        /* best-effort */
      }
      return { ran: true, key, node_id: selfId, action: `node focus ${target}` };
    }

    const bind = readConfig('user').canvasNav.prefixBinds[key];
    if (bind === undefined) return { ran: false, key, node_id: selfId, action: 'noop' };

    // The GRAPH-toggle sentinel: type /graph into the pane (the menu normally
    // emits this directly; handle it here too so a manual chord still works).
    if (bind.run === '__graph__') {
      if (pane !== undefined && pane !== '') sendKeysEnter(pane, '/graph');
      return { ran: true, key, node_id: selfId, action: 'graph-toggle' };
    }

    const argv = interpolateArgv(bind.run, buildVars(selfId));
    if (argv.length === 0) return { ran: false, key, node_id: selfId, action: 'noop' };
    try {
      await pexec('crtr', argv, { timeout: 15_000 });
    } catch {
      /* best-effort: the keystroke just acts; errors are surfaced by the inner cmd */
    }
    return { ran: true, key, node_id: selfId, action: `crtr ${argv.join(' ')}` };
  },
});
