import { defineLeaf } from '../../core/command.js';
import { notFound } from '../../core/errors.js';
import { getNode, nodeArtifacts, type HistorySource } from '../../core/canvas/index.js';
import { statSync } from 'node:fs';

const TYPES: HistorySource[] = ['report', 'doc', 'roadmap'];

export const showLeaf = defineLeaf({
  name: 'show',
  description: 'enumerate one node\'s artifacts as refs',
  whenToUse:
    'you have a node id and want to see everything it left behind — its reports and context docs as refs ready for `canvas history read`. The bridge from "found the node" to "read its artifacts". Use `node inspect show` instead for the node\'s topology/neighbors, not its content.',
  help: {
    name: 'canvas history show',
    summary: 'list one node\'s artifacts (reports + context docs) as refs ready for `canvas history read`',
    params: [
      { kind: 'positional', name: 'node-id', required: true, constraint: 'The node whose artifacts to list.' },
      { kind: 'flag', name: 'type', type: 'enum', choices: [...TYPES], required: false, constraint: 'Narrow to one corpus: report | doc | roadmap. Default: all.' },
      { kind: 'flag', name: 'sort', type: 'enum', choices: ['recency', 'oldest'], required: false, constraint: 'Order by artifact timestamp. Default recency.' },
    ],
    output: [
      { name: 'node', type: 'string', required: true, constraint: 'Node name + id.' },
      { name: 'artifacts', type: 'object[]', required: true, constraint: 'Each: {ref, source, ts, detail}. source = report:<kind> | doc | roadmap. detail = report title / doc heading + size. ref passes verbatim to `canvas history read`.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next commands.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const nodeId = (input['nodeId'] as string).trim();
    const type = input['type'] as HistorySource | undefined;
    const sort = (input['sort'] as string | undefined) ?? 'recency';

    if (getNode(nodeId) === null) {
      throw notFound(`unknown node: ${nodeId}`, {
        received: nodeId,
        next: 'List nodes with `crtr node inspect list`, or find one with `canvas history search`.',
      });
    }

    const arts = nodeArtifacts(nodeId, type !== undefined ? [type] : undefined);
    arts.sort((a, b) => (sort === 'oldest' ? a.tsMs - b.tsMs : b.tsMs - a.tsMs) || a.ref.localeCompare(b.ref));

    const artifacts = arts.map((a) => {
      let size = 0;
      try {
        if (a.path !== null) size = statSync(a.path).size;
      } catch {
        /* ignore */
      }
      return {
        ref: a.ref,
        source: a.source === 'report' && a.reportKind ? `report:${a.reportKind}` : a.source,
        ts: a.ts,
        detail: a.title + (size > 0 ? `  (${size}B)` : ''),
      };
    });

    const node = getNode(nodeId);
    return {
      node: `${node?.name} (${nodeId})`,
      artifacts,
      follow_up: 'Read one with `canvas history read <ref>`; reopen the node with `canvas revive ' + nodeId + '`.',
    };
  },
  render: (r) => {
    const arts = r['artifacts'] as Record<string, unknown>[];
    const parts: string[] = [`node: ${r['node']}`];
    if (arts.length === 0) {
      parts.push('0 artifacts.');
    } else {
      const cols = Object.keys(arts[0]);
      const head = `| ${cols.join(' | ')} |`;
      const sep = `| ${cols.map(() => '---').join(' | ')} |`;
      const body = arts
        .map((a) => `| ${cols.map((c) => String(a[c] ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')).join(' | ')} |`)
        .join('\n');
      parts.push(`${arts.length} artifacts:\n\n${head}\n${sep}\n${body}`);
    }
    parts.push(String(r['follow_up']));
    return parts.join('\n\n');
  },
});
