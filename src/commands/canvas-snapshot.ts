import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { getNode } from '../core/canvas/index.js';
import { dashboardRowsAll, enrichRows } from '../core/canvas/render.js';

export const canvasSnapshotLeaf: LeafDef = defineLeaf({
  name: 'snapshot',
  description: 'emit the browser canvas roster as structured data',
  whenToUse: 'you need a machine-readable roster of every canvas node for a browser or local tool; use dashboard for the human-readable tree',
  help: {
    name: 'canvas snapshot',
    summary: 'machine-readable snapshot of the whole canvas roster',
    params: [],
    output: [
      { name: 'generated_at', type: 'string', required: true, constraint: 'ISO timestamp when the snapshot was generated.' },
      { name: 'nodes', type: 'object[]', required: true, constraint: 'NodeSummary rows for browser canvas rendering.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: queries canvas.db, focus rows, telemetry files, and human ask counts.'],
  },
  run: async () => {
    const rows = dashboardRowsAll();
    enrichRows(rows);
    const nodes = rows.map((row) => {
      const meta = getNode(row.node_id);
      const hostKind = meta?.host_kind ?? 'tmux';
      return {
        node_id: row.node_id,
        name: row.name,
        kind: row.kind,
        mode: row.mode,
        lifecycle: row.lifecycle ?? meta?.lifecycle,
        status: row.status,
        cwd: row.cwd,
        parent: meta?.parent ?? null,
        created: row.created,
        host_kind: hostKind,
        enterable: hostKind === 'broker',
        attention_count: row.asks,
        ...(meta?.cycles !== undefined ? { cycles: meta.cycles } : {}),
        ...(row.mtimeMs !== undefined ? { last_activity: new Date(row.mtimeMs).toISOString() } : {}),
        ctx_tokens: row.ctx_tokens,
        streaming: row.streaming ?? false,
        hanging: row.hanging ?? null,
        viewed: row.viewed ?? false,
      };
    });
    return { generated_at: new Date().toISOString(), nodes };
  },
});
