import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { getNode, jobDir } from '../../core/canvas/index.js';

export const sysSyspromptLeaf = defineLeaf({
  name: 'sysprompt',
  description: 'print a node\'s assembled system prompt',
  whenToUse: 'you want to inspect a node\'s assembled system prompt headlessly, without paying conversation/context cost — the broker writes it to disk while live, and this command reads that artifact back as markdown.',
  help: {
    name: 'sys sysprompt',
    summary: 'print a node\'s assembled system prompt',
    params: [
      { kind: 'positional', name: 'node', required: false, constraint: 'Node id. Defaults to the calling node (CRTR_NODE_ID).' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The node whose prompt was read.' },
      { name: 'captured_at', type: 'string', required: true, constraint: 'File mtime in ISO-8601 UTC.' },
      { name: 'chars', type: 'number', required: true, constraint: 'Character count of the stored prompt.' },
      { name: 'prompt', type: 'string', required: true, constraint: 'The assembled system prompt, exactly as pi built it.' },
    ],
    outputKind: 'object',
    effects: ['Read-only: reads the node\'s job/system-prompt.md artifact.'],
  },
  run: async (input) => {
    const nodeId = (input['node'] as string | undefined)?.trim() || process.env['CRTR_NODE_ID'];
    if (nodeId === undefined || nodeId === '') {
      throw new InputError({ error: 'empty_node', message: 'a node id is required', field: 'node', next: 'Pass a node id or run from inside a node.' });
    }
    if (getNode(nodeId) === null) {
      throw new InputError({ error: 'not_found', message: `no node: ${nodeId}`, field: 'node', next: 'List nodes with `crtr node inspect list`.' });
    }
    const path = join(jobDir(nodeId), 'system-prompt.md');
    if (!existsSync(path)) {
      throw new InputError({
        error: 'not_found',
        message: `system prompt not captured yet for ${nodeId}`,
        field: 'node',
        next: 'Focus or revive the node once while its broker is live, then rerun `crtr sys sysprompt <node>`.',
      });
    }
    const prompt = readFileSync(path, 'utf8');
    const capturedAt = statSync(path).mtime.toISOString();
    return { node_id: nodeId, captured_at: capturedAt, chars: prompt.length, prompt };
  },
  render: (r) => `- node_id: ${r['node_id']}\n- captured_at: ${r['captured_at']}\n- chars: ${r['chars']}\n\n${r['prompt']}`,
});
