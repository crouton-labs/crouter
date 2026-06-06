// canvas-resume.ts — pi extension registering the /resume-node canvas command.
//
//   /resume-node  — open a TREE-SHAPED picker over the WHOLE canvas (every root,
//     INCLUDING DORMANT nodes: done / idle / dead / canceled) rendered with tree
//     glyphs (├─ / └─) + a status tag + name + short id, then revive the chosen
//     node by shelling `crtr node focus <id>` (fire-and-forget). Reviving dormant
//     nodes is the entire point, so — unlike the BASE/GRAPH chrome and
//     renderForest()'s live-only (active|idle) filter — this walks ALL roots
//     and ALL statuses.
//
//   The name is literally `resume-node`, NOT `resume`, to avoid clashing with
//   pi's built-in /resume.
//
// ⚠ DESYNC — why `crtr node focus` is the ONLY sanctioned open
//   `crtr node focus <id>` routes through reviveNode() (src/core/runtime/
//   revive.ts), the ONLY sanctioned launcher of `pi --session <file>`: it sets
//   CRTR_NODE_ID + the `-e` canvas extensions and runs transition('revive').
//   A RAW `pi --session <file>` has NEITHER → every canvas hook is inert: the
//   stophook never records pi_pid / clears intent / marks done, no inbox-watcher
//   wakes it, and transition('revive') never runs so the row stays dormant.
//   Worst case (idle + intent=idle-release) the daemon can't see the raw pi (no
//   pi_pid) and DOUBLE-SPAWNS a second pi on the same .jsonl, corrupting the
//   conversation. A UI must therefore NEVER spawn `pi --session` directly — it
//   opens nodes via `crtr node focus` / `crtr canvas revive`.
//
// INERT when CRTR_NODE_ID is absent (a plain pi session, not a canvas node).
//
// Plain TS-with-types — no imports from @earendil-works/* so this compiles
// inside crouter's own tsc build without a dep on the pi packages (mirrors
// canvas-nav.ts / canvas-commands.ts).

import { execFile } from 'node:child_process';

import { getNode, listNodes, subscriptionsOf, fullName } from '../core/canvas/index.js';
import type { NodeMeta, NodeStatus } from '../core/canvas/index.js';

// ---------------------------------------------------------------------------
// Minimal Pi interface (avoids a hard dep on @earendil-works/*). Signatures
// sourced from pi-coding-agent's dist/core/extensions/types.d.ts:
//   registerCommand(name, { description?, handler })
//   ctx.mode: "tui" | "rpc" | "json" | "print"  (guard "tui" before ui.select)
//   ctx.ui.select(title, options) -> Promise<string | undefined>
// ---------------------------------------------------------------------------

interface CommandUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  notify(message: string, type?: 'info' | 'warning' | 'error'): void;
}

interface CommandCtx {
  mode: string;
  ui: CommandUI;
}

interface PiLike {
  registerCommand?(
    name: string,
    options: { description?: string; handler: (args: string, ctx: CommandCtx) => void | Promise<void> },
  ): void;
}

// ---------------------------------------------------------------------------
// Forest rendering — one line per node across the WHOLE canvas, with a parallel
// ids[] array so the chosen line maps back to its node_id. Plain unicode glyphs
// (no ANSI) so the line renders cleanly inside pi's select dialog.
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<NodeStatus, string> = {
  active:   '●',
  idle:     '○',
  done:     '✓',
  dead:     '✗',
  canceled: '⊘',
};

function shortId(id: string): string {
  return id.slice(0, 8);
}

/** `<glyph> <status> <name> [<kind>/<mode>] (<shortid>)` — a status TAG + name
 *  + short id, prefixed with the tree branch. Best-effort on a missing meta. */
function nodeLabel(nodeId: string, branch: string): string {
  const node = getNode(nodeId);
  if (node === null) return `${branch}? <missing ${shortId(nodeId)}>`;
  const glyph = STATUS_GLYPH[node.status] ?? '?';
  return `${branch}${glyph} ${node.status} ${fullName(node)} [${node.kind}/${node.mode}] (${shortId(nodeId)})`;
}

/** Sort rank for roots — live first (active, then idle), dormant after. Keeps
 *  the picker oriented while still listing every dormant root. */
function statusRank(status: NodeStatus): number {
  switch (status) {
    case 'active':   return 0;
    case 'idle':     return 1;
    case 'done':     return 2;
    case 'canceled': return 3;
    case 'dead':     return 4;
    default:         return 5;
  }
}

interface Forest {
  lines: string[];
  ids: string[];
}

/** Recursively render the subscription subtree rooted at `nodeId` into the
 *  parallel lines/ids arrays. Mirrors render.ts walkTree but keeps lines and
 *  ids strictly 1:1 (a cycle back-ref still maps to its real node, so selecting
 *  it just focuses that node — harmless). Cycle-safe via `visited`. */
function walkSubtree(
  nodeId: string,
  indent: string,
  connector: string,
  visited: Set<string>,
  out: Forest,
): void {
  if (visited.has(nodeId)) {
    out.lines.push(`${indent}${connector}↺ ${shortId(nodeId)} (cycle)`);
    out.ids.push(nodeId);
    return;
  }
  visited.add(nodeId);
  out.lines.push(nodeLabel(nodeId, `${indent}${connector}`));
  out.ids.push(nodeId);

  const children = subscriptionsOf(nodeId);
  // Root rows carry no connector; children of a last-child get clear space, of a
  // mid-child a continued spine — exactly render.ts walkTree's prefix math.
  const childIndent = indent + (connector === '' ? '' : connector === '└─ ' ? '   ' : '│  ');
  for (let i = 0; i < children.length; i++) {
    const isLast = i === children.length - 1;
    walkSubtree(children[i]!.node_id, childIndent, isLast ? '└─ ' : '├─ ', visited, out);
  }
}

/** The whole-canvas forest: EVERY root (parent === null, ANY status) and its
 *  subtree, flattened to parallel label/id arrays. */
function buildForest(): Forest {
  const out: Forest = { lines: [], ids: [] };
  const visited = new Set<string>();
  const roots = listNodes()
    .filter((n) => n.parent === null)
    .sort((a, b) => statusRank(a.status) - statusRank(b.status));
  for (const r of roots) walkSubtree(r.node_id, '', '', visited, out);
  return out;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/**
 * Register the /resume-node command on `pi`.
 *
 * Returns immediately when CRTR_NODE_ID is absent — the extension is fully
 * inert in a non-canvas pi session.
 */
export function registerCanvasResume(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node
  if (typeof pi.registerCommand !== 'function') return;

  pi.registerCommand('resume-node', {
    description: 'Resume a node — pick from the whole canvas (incl. dormant) and revive it',
    handler: async (_args: string, ctx: CommandCtx): Promise<void> => {
      // select() is a terminal-only dialog — guard the run mode before it.
      if (ctx.mode !== 'tui') {
        try { ctx.ui.notify('/resume-node needs the interactive TUI', 'warning'); } catch { /* best-effort */ }
        return;
      }

      let forest: Forest;
      try {
        forest = buildForest();
      } catch {
        try { ctx.ui.notify('resume: could not read the canvas', 'error'); } catch { /* best-effort */ }
        return;
      }
      if (forest.lines.length === 0) {
        try { ctx.ui.notify('No nodes on the canvas to resume.', 'info'); } catch { /* best-effort */ }
        return;
      }

      const choice = await ctx.ui.select('Resume which node?', forest.lines);
      if (choice === undefined) return; // cancelled / timed out

      const idx = forest.lines.indexOf(choice);
      const targetId = idx >= 0 ? forest.ids[idx] : undefined;
      if (targetId === undefined) return;

      // The ONLY sync-safe open: route through reviveNode via `crtr node focus`.
      // Fire-and-forget — `node focus` swaps the target into THIS pane, replacing
      // the current pi, so the callback may never run (best-effort notify only).
      try {
        execFile('crtr', ['node', 'focus', targetId], (err): void => {
          if (err != null) {
            try { ctx.ui.notify(`resume failed: focus ${shortId(targetId)}`, 'error'); } catch { /* best-effort */ }
          }
        });
      } catch {
        /* best-effort */
      }
    },
  });
}

export default registerCanvasResume;
