// canvas-commands.ts — pi extension registering canvas slash-commands on nodes.
//
//   /promote [kind]  — promote THIS node to a resident orchestrator. Runs
//     `crtr node promote --json` for CRTR_NODE_ID (optionally specializing its
//     kind), then injects the orchestration guidance the command returns into
//     context and triggers a turn, so the node authors its roadmap immediately.
//     This is the same mid-turn guidance dump the node would get by running the
//     command itself by hand — surfaced as a one-keystroke affordance.
//
// The Alt+C tmux action menu's "promote to orchestrator" item (key `o`) simply
// send-keys `/promote` into the active pane, so the menu and the slash command
// share this one implementation.
//
// INERT when CRTR_NODE_ID is absent (a plain pi session, not a canvas node).
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages (mirrors
// canvas-nav.ts). The only crouter import is availableKinds, used to offer
// `/promote <kind>` completions.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { availableKinds } from '../core/personas/index.js';

const pexec = promisify(execFile);

// ---------------------------------------------------------------------------
// Minimal Pi interface (avoids a hard dep on @earendil-works/*). Signatures
// sourced from pi-coding-agent's dist/core/extensions/types.d.ts:
//   registerCommand(name, { description?, getArgumentCompletions?, handler })
//   sendMessage(msg, { triggerTurn? })   ctx.ui.{ notify, setStatus }
// ---------------------------------------------------------------------------

interface AutocompleteItem {
  value: string;
  label?: string;
}

interface CommandUI {
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
  setStatus(key: string, text: string | undefined): void;
}

interface CommandCtx {
  ui: CommandUI;
}

interface CustomMessage {
  customType: string;
  content: string;
  display?: boolean;
}

interface PiLike {
  registerCommand(
    name: string,
    options: {
      description?: string;
      getArgumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
      handler: (args: string, ctx: CommandCtx) => Promise<void>;
    },
  ): void;
  sendMessage(message: CustomMessage, options?: { triggerTurn?: boolean }): void;
}

/** Shape of `crtr node promote --json` output (see nodePromote in commands/node.ts). */
interface PromoteResult {
  node_id?: string;
  kind?: string;
  mode?: string;
  roadmap_written?: boolean;
  roadmap_path?: string;
  goal_path?: string;
  guidance?: string;
}

// Kinds for `/promote <kind>` completions — computed once (persona dirs rarely
// change within a session), best-effort so a loader hiccup never breaks input.
let cachedKinds: string[] | null = null;
function kinds(): string[] {
  if (cachedKinds === null) {
    try {
      cachedKinds = availableKinds();
    } catch {
      cachedKinds = [];
    }
  }
  return cachedKinds;
}

/**
 * Register the canvas slash-commands on `pi`.
 *
 * Returns immediately when CRTR_NODE_ID is absent — the extension is fully
 * inert in a non-canvas pi session.
 */
export function registerCanvasCommands(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node

  pi.registerCommand('promote', {
    description:
      'Promote this node to a resident orchestrator — /promote, or /promote <kind> to specialize',
    getArgumentCompletions: (prefix: string) => {
      const items = kinds()
        .filter((k) => k.startsWith(prefix))
        .map((k) => ({ value: k, label: k }));
      return items.length > 0 ? items : null;
    },
    handler: async (args: string, ctx: CommandCtx): Promise<void> => {
      const kind = args.trim().toLowerCase();
      ctx.ui.setStatus('crtr-promote', kind ? `promoting → ${kind}…` : 'promoting…');

      const argv = ['node', 'promote', '--json'];
      if (kind !== '') argv.push('--kind', kind);

      // Run promote out-of-process. On a non-zero exit, crtr still prints the
      // structured error to stdout, so prefer its `message` over the raw throw.
      let result: PromoteResult | null = null;
      let errMsg: string | null = null;
      try {
        const { stdout } = await pexec('crtr', argv, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 });
        result = JSON.parse(stdout) as PromoteResult;
      } catch (err: unknown) {
        const e = err as { stdout?: unknown; message?: unknown };
        const stdout = typeof e.stdout === 'string' ? e.stdout : '';
        try {
          const payload = JSON.parse(stdout) as { message?: string };
          errMsg = typeof payload.message === 'string' ? payload.message : null;
        } catch {
          /* stdout wasn't JSON */
        }
        if (errMsg === null) errMsg = typeof e.message === 'string' ? e.message : String(err);
      }

      ctx.ui.setStatus('crtr-promote', '');

      if (result === null) {
        ctx.ui.notify(`promote failed: ${errMsg ?? 'unknown error'}`, 'error');
        return;
      }

      const rmPath = (result.roadmap_path ?? '').trim();
      ctx.ui.notify(
        `Promoted to ${result.kind ?? 'orchestrator'} orchestrator — authoring roadmap${rmPath !== '' ? ` (${rmPath})` : ''}.`,
        'info',
      );

      // The guidance is operating instructions for the node, not the user.
      // Inject it silently and trigger a turn so the node acts on it now —
      // exactly what happens when the node runs `crtr node promote` by hand.
      const guidance = (result.guidance ?? '').trim();
      if (guidance === '') return;
      pi.sendMessage({ customType: 'crtr-promote', content: guidance, display: false }, { triggerTurn: true });
    },
  });
}

export default registerCanvasCommands;
