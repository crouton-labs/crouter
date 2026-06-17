import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { getNode, jobDir } from '../../core/canvas/index.js';
import { focusOf, openNodeWindow } from '../../core/runtime/placement.js';

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const sysSyspromptLeaf = defineLeaf({
  name: 'sysprompt',
  description: 'print a node\'s assembled system prompt',
  whenToUse: 'you want to inspect a node\'s assembled system prompt headlessly, without paying conversation/context cost — the broker writes it to disk while live, and this command reads that artifact back as markdown.',
  help: {
    name: 'sys sysprompt',
    summary: 'print a node\'s assembled system prompt',
    params: [
      { kind: 'positional', name: 'node', required: false, constraint: 'Node id. Defaults to the calling node (CRTR_NODE_ID).' },
      { kind: 'flag', name: 'window', type: 'bool', required: false, constraint: 'Open the assembled prompt in a NEW tmux window in the session currently showing that node instead of printing to stdout.' },
    ],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The node whose prompt was read.' },
      { name: 'captured_at', type: 'string', required: true, constraint: 'File mtime in ISO-8601 UTC.' },
      { name: 'chars', type: 'number', required: true, constraint: 'Character count of the stored prompt.' },
      { name: 'prompt', type: 'string', required: true, constraint: 'The assembled system prompt, exactly as pi built it.' },
      { name: 'session', type: 'string', required: false, constraint: 'tmux session showing the node (only when --window is used).' },
      { name: 'window', type: 'string', required: false, constraint: 'tmux window opened for the prompt (only when --window is used).' },
    ],
    outputKind: 'object',
    effects: ['Read-only: reads the node\'s job/system-prompt.md artifact, or opens it in a tmux window.'],
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

    if (input['window'] === true) {
      const focus = focusOf(nodeId);
      if (focus === null || focus.session === null || focus.session === '') {
        throw new InputError({
          error: 'not_focused',
          message: `node ${nodeId} is not currently shown in tmux`,
          field: 'node',
          next: `Focus the node first with \`crtr node focus ${nodeId}\`, then rerun \`crtr sys sysprompt --window ${nodeId}\`.`,
        });
      }
      const tmpPath = join(tmpdir(), `crtr-sysprompt-${nodeId}.md`);
      writeFileSync(tmpPath, prompt, 'utf8');
      const command = `less -R ${shellQuote(tmpPath)}`;
      const opened = openNodeWindow({ session: focus.session, name: `sysprompt:${nodeId}`, cwd: process.cwd(), env: {}, command });
      if (opened === null) {
        throw new InputError({
          error: 'window_open_failed',
          message: `tmux could not open a window for node ${nodeId}`,
          field: 'node',
          next: 'Check the tmux server is reachable, then retry.',
        });
      }
      return { node_id: nodeId, session: focus.session, window: opened.window };
    }

    return { node_id: nodeId, captured_at: capturedAt, chars: prompt.length, prompt };
  },
  render: (r) => ('window' in r)
    ? `Opened system prompt for node ${r['node_id']} in tmux session ${r['session']} — window ${r['window']}.`
    : `- node_id: ${r['node_id']}\n- captured_at: ${r['captured_at']}\n- chars: ${r['chars']}\n\n${r['prompt']}`,
});
