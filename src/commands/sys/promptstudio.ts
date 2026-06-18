import { spawn } from 'node:child_process';
import { defineLeaf } from '../../core/command.js';
import type { LeafDef } from '../../core/command.js';
import { startWebServer } from '../../clients/web/server.js';

const DEFAULT_PORT = 7878;
const PROMPT_STUDIO_PATH = '/views/prompt-review';

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* the printed URL is enough when no browser opener is available */
    });
    child.unref();
  } catch {
    /* the printed URL is enough when no browser opener is available */
  }
}

export const sysPromptStudioLeaf: LeafDef = defineLeaf({
  name: 'promptstudio',
  description: 'open Prompt Studio in the browser',
  whenToUse: 'you want the Prompt Studio browser UI — a prompt review surface for toggling crouter persona/mode/lifecycle configs, inspecting the assembled system prompt, comparing configurations, and exporting review comments with source-file pointers.',
  help: {
    name: 'sys promptstudio',
    summary: 'start the crouter web server and open Prompt Studio directly',
    params: [
      { kind: 'flag', name: 'port', type: 'int', required: false, default: DEFAULT_PORT, constraint: `TCP port to bind on 127.0.0.1. Default ${DEFAULT_PORT}.` },
      { kind: 'flag', name: 'dev', type: 'bool', required: false, default: false, constraint: 'Serve the web shell through Vite middleware/HMR while iterating on Prompt Studio or the web client.' },
    ],
    output: [
      { name: 'url', type: 'string', required: true, constraint: 'Prompt Studio URL opened in the browser.' },
    ],
    outputKind: 'object',
    effects: [
      'Binds the same long-running local web server as `crtr web serve`, opens `/views/prompt-review` in the default browser, and keeps serving until ctrl+c/SIGTERM.',
      'The Prompt Studio view uses the existing source bridge to call `crtr sys prompt-review` for composed prompts and review export.',
    ],
  },
  run: async (input) => {
    const port = (input['port'] as number | undefined) ?? DEFAULT_PORT;
    const dev = (input['dev'] as boolean | undefined) ?? false;
    const server = await startWebServer({ port, dev });
    const url = `${server.url}${PROMPT_STUDIO_PATH}`;
    process.stdout.write(
      `Prompt Studio serving at ${url}${dev ? ' (--dev: Vite middleware)' : ''}\n` +
        `  bridge:       POST ${server.url}/__crtr/source\n` +
        `  events (SSE): GET  ${server.url}/__crtr/events\n` +
        `  shell assets: ${dev ? 'Vite middleware (HMR)' : server.clientDir}\n` +
        `  (ctrl+c to stop)\n`,
    );
    openBrowser(url);

    await new Promise<void>((resolveShutdown) => {
      const shutdown = (): void => {
        void server.close().then(() => resolveShutdown());
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      process.once('SIGHUP', shutdown);
    });
    return { url };
  },
  render: () => '',
});
