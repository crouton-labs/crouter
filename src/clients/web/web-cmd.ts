// web-cmd.ts — the `crtr web` command leaf + registration.
//
// Starts the ONE long-running unified web server (server.ts): the crouter web UI
// host. It serves the shell SPA, the source + command bridge (POST
// /__crtr/source), the SSE change lane (GET /__crtr/events), and a VERBATIM
// browser ⇄ broker relay on `ws://127.0.0.1:PORT/node/<id>` (the browser becomes
// the SAME protocol peer as `crtr attach`). The node is selected by the URL, so
// there is NO positional node here.
//
// Command shape (plan §3.6): the CLI path-walker forbids a flat top-level leaf
// (`defineRoot.subtrees` is `BranchDef[]`), so `web` is a BRANCH wrapping a
// single leaf: `crtr web serve`.

import { spawn } from 'node:child_process';
import { defineBranch, defineLeaf } from '../../core/command.js';
import type { BranchDef, LeafDef } from '../../core/command.js';
import { startWebServer } from './server.js';

const DEFAULT_PORT = 7878;

/** Best-effort open of the default browser to `url` (the `--open` flag). Never
 *  throws — a failed open just leaves the user to click the printed URL. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin'
      ? ['open', [url]]
      : platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      /* no browser opener available — the printed URL is the fallback */
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

const webServeLeaf: LeafDef = defineLeaf({
  name: 'serve',
  description: 'start the crouter web UI server — the shell, the source/command bridge, and a browser ⇄ broker relay',
  whenToUse:
    'you want the crouter web UI: a browser shell to watch the canvas and drive headless nodes, instead of a terminal pane. It starts ONE long-running local server (127.0.0.1) that serves the shell SPA, the source + command bridge (POST /__crtr/source — views\' reads AND `crtr` command writes), an SSE change-invalidation lane (GET /__crtr/events), and a VERBATIM browser ⇄ broker relay on /node/<id> (the browser becomes the same protocol peer as `crtr attach`: one controller drives, extra viewers follow read-only). The relay NEVER starts an engine — each node must already have a running headless broker (focus or revive it first); all writes flow through `crtr` subprocesses the bridge runs. Pass --dev for Vite middleware (HMR) while iterating on the shell. The server runs until ctrl+c; the node is picked in the browser via the URL, not on the command line.',
  help: {
    name: 'web serve',
    summary:
      'start the long-running crouter web UI server on 127.0.0.1: serves the shell SPA, the POST /__crtr/source bridge, the GET /__crtr/events SSE lane, and a VERBATIM browser ⇄ node-broker relay (browser picks the node via /node/<id>)',
    params: [
      {
        kind: 'flag',
        name: 'port',
        type: 'int',
        required: false,
        default: DEFAULT_PORT,
        constraint: `TCP port to bind on 127.0.0.1. Default ${DEFAULT_PORT}.`,
      },
      {
        kind: 'flag',
        name: 'open',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'Auto-open the default browser to the served URL after the server starts.',
      },
      {
        kind: 'flag',
        name: 'dev',
        type: 'bool',
        required: false,
        default: false,
        constraint: 'Serve shell assets via a Vite dev server (middleware mode, HMR) instead of the prebuilt dist/web-client/ bundle. For contributors iterating on the shell or a builtin view. The bridge, SSE lane, and WS relay are identical in both modes.',
      },
    ],
    output: [],
    outputKind: 'object',
    effects: [
      'Binds a long-running HTTP+WebSocket server on 127.0.0.1:<port> and keeps serving until interrupted (ctrl+c / SIGTERM). Safe to run non-interactively (daemon-like): it prints the URL and serves.',
      'Serves the shell SPA (static dist/web-client/, or Vite middleware under --dev), runs the POST /__crtr/source bridge (exec/file/http in this cwd), streams the GET /__crtr/events SSE change lane, and on a browser ws://127.0.0.1:<port>/node/<id> connection opens that node\'s running broker view.sock and relays frames VERBATIM both directions.',
      'The relay NEVER spawns pi and NEVER writes any session — it only opens a socket to an already-running broker; if the broker is not running, the browser connection is closed with a clear reason. All graph mutations go through `crtr` subprocesses the bridge runs.',
    ],
  },
  run: async (input) => {
    const port = (input['port'] as number | undefined) ?? DEFAULT_PORT;
    const open = (input['open'] as boolean | undefined) ?? false;
    const dev = (input['dev'] as boolean | undefined) ?? false;

    const server = await startWebServer({ port, dev });
    const nodeUrlShape = `${server.url}/node/<id>`;
    process.stdout.write(
      `crtr web serving on ${server.url}${dev ? ' (--dev: Vite middleware)' : ''}\n` +
        `  open a node:  ${nodeUrlShape}\n` +
        `  bridge:       POST ${server.url}/__crtr/source\n` +
        `  events (SSE): GET  ${server.url}/__crtr/events\n` +
        `  shell assets: ${dev ? 'Vite middleware (HMR)' : server.clientDir}\n` +
        `  (ctrl+c to stop)\n`,
    );
    if (open) openBrowser(server.url);

    // Long-running: resolve only on a shutdown signal, tearing down cleanly.
    await new Promise<void>((resolveShutdown) => {
      const shutdown = (): void => {
        void server.close().then(() => resolveShutdown());
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      process.once('SIGHUP', shutdown);
    });
    return;
  },
  render: () => '',
});

export function registerWeb(): BranchDef {
  return defineBranch({
    name: 'web',
    rootEntry: {
      concept: 'the crouter web UI server — one host serving the browser shell, the source/command bridge, an SSE change lane, and a VERBATIM relay to nodes\' running brokers',
      desc: 'serve the crouter web UI for the canvas and headless nodes',
      useWhen:
        'you want the crouter web UI in a browser instead of a tmux pane: watch the canvas and drive headless nodes. It runs one long-lived local server that serves the shell SPA, runs view sources + `crtr` command writes over POST /__crtr/source, streams canvas-change invalidations over GET /__crtr/events (SSE), and relays a browser connection VERBATIM to a node\'s already-running broker on /node/<id> — same protocol peer as `crtr attach`. The node is selected in the browser via the URL; the relay never starts an engine, so each node must already have a running headless broker.',
    },
    help: {
      name: 'web',
      summary: 'serve the crouter web UI: the shell SPA, the source/command bridge, the SSE change lane, and a VERBATIM relay to headless nodes\' brokers',
      model:
        '`serve` starts the ONE long-running unified server on 127.0.0.1 (--port, default 7878; --open to launch the browser; --dev for Vite middleware/HMR). It serves the shell SPA (static dist/web-client/ shipped, Vite middleware in --dev), the POST /__crtr/source bridge (views\' reads AND `crtr` command writes via the local exec/file/http transport), the GET /__crtr/events SSE change-invalidation lane, and on a browser ws://127.0.0.1:PORT/node/<id> connection opens that node\'s broker view.sock and relays frames VERBATIM both ways — the browser is the same protocol peer as `crtr attach` (one controller drives, extra viewers are read-only; arbitration + dialogs ride the same frames). The relay NEVER spawns pi or writes a session: the node must already have a running headless broker (focus or revive it first); all graph mutations flow through `crtr` subprocesses the bridge runs. The server keeps running until ctrl+c; the node is chosen in the browser via the URL, not on the command line.',
    },
    children: [webServeLeaf],
  });
}
