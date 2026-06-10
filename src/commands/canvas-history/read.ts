import { defineLeaf } from '../../core/command.js';
import { notFound, usage } from '../../core/errors.js';
import { resolveRef } from '../../core/canvas/index.js';

export const readLeaf = defineLeaf({
  name: 'read',
  description: 'read one search hit\'s full body by its ref',
  whenToUse:
    'you picked a hit from `canvas history search` (or `canvas history show`) and want its full content — pass the `<node-id>:<relpath>` ref verbatim. Strips frontmatter by default; add --frontmatter to keep the YAML header.',
  help: {
    name: 'canvas history read',
    summary: 'resolve a <node-id>:<relpath> ref to its full artifact body',
    params: [
      { kind: 'positional', name: 'ref', required: true, constraint: 'The <node-id>:<relpath> handle from `canvas history search` (e.g. mq186ky0-c754531c:reports/20260607T075536-final.md, or <node-id>:meta for a node\'s identity).' },
      { kind: 'flag', name: 'frontmatter', type: 'bool', required: false, constraint: 'Include the artifact\'s YAML frontmatter. Stripped by default.' },
    ],
    output: [
      { name: 'ref', type: 'string', required: true, constraint: 'Echo of the resolved ref.' },
      { name: 'node', type: 'string', required: true, constraint: 'Node name + id.' },
      { name: 'source', type: 'string', required: true, constraint: 'report | doc | roadmap | meta (+ report-kind for reports).' },
      { name: 'ts', type: 'string', required: true, constraint: 'Artifact timestamp.' },
      { name: 'content', type: 'string', required: true, constraint: 'Full body. Frontmatter stripped unless --frontmatter.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only.'],
  },
  run: async (input) => {
    const ref = (input['ref'] as string).trim();
    const includeFrontmatter = input['frontmatter'] === true;
    if (!ref.includes(':')) {
      throw usage(`ref must be <node-id>:<relpath>; received: ${ref}`, {
        received: ref,
        next: 'Get a valid ref from `canvas history search` or `canvas history show <node-id>`.',
      });
    }

    let resolved;
    try {
      resolved = resolveRef(ref);
    } catch (e) {
      throw usage(`ref rejected: ${(e as Error).message}`, { received: ref, next: 'Refs come verbatim from `canvas history search`; do not hand-construct relpaths.' });
    }
    if (resolved === null) {
      throw notFound(`no artifact for ref: ${ref}`, {
        ref,
        next: 'The node or file may not exist. Re-run `canvas history search` for a current ref, or `canvas history show <node-id>` to list a node\'s artifacts.',
      });
    }

    const source = resolved.source === 'report' && resolved.reportKind ? `report:${resolved.reportKind}` : resolved.source;
    const content =
      includeFrontmatter && resolved.raw !== null ? resolved.raw : resolved.body;
    return {
      ref,
      node: `${resolved.nodeName} (${resolved.nodeId})`,
      source,
      ts: resolved.ts,
      content,
    };
  },
  render: (r) => {
    const head = `${r['node']}  |  source: ${r['source']}  |  ts: ${r['ts']}  |  ref: ${r['ref']}`;
    return `${head}\n\n${String(r['content']).trim()}`;
  },
});
