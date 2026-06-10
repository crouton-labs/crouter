// web-cmd.ts — the `crtr web` command leaf + registration (Phase 4, T10).
//
// Starts the ONE long-running multiplexing bridge server (server.ts): a browser
// opens `ws://127.0.0.1:PORT/node/<id>` and the server relays frames VERBATIM to
// that node's running broker `view.sock`, making the browser the SAME protocol
// peer as `crtr attach`. The node is selected by the `/node/<id>` URL, so there
// is NO positional node here.
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
  description: 'start the crtr web bridge — view and drive headless nodes from a browser',
  whenToUse:
    'you want to WATCH or DRIVE headless nodes from a browser instead of a terminal pane. It starts ONE long-running local server (127.0.0.1) that serves the web viewer and, on a browser connection to /node/<id>, relays VERBATIM over a unix socket to that node\'s already-running broker — the browser becomes the same protocol peer as `crtr attach` (one controller drives, extra viewers follow read-only; arbitration + dialogs work identically). It NEVER starts an engine: each node must already have a running headless broker (focus or revive it first). The server keeps running until you stop it (ctrl+c); the node is picked in the browser via the URL, not on the command line.',
  help: {
    name: 'web serve',
    summary:
      'start the long-running crtr web bridge server on 127.0.0.1: serves the browser viewer and relays browser ⇄ node-broker over the view socket (browser picks the node via /node/<id>)',
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
    ],
    output: [],
    outputKind: 'object',
    effects: [
      'Binds a long-running HTTP+WebSocket server on 127.0.0.1:<port> and keeps serving until interrupted (ctrl+c / SIGTERM). Safe to run non-interactively (daemon-like): it prints the URL and serves.',
      'Serves the static browser viewer bundle, and on a browser ws://127.0.0.1:<port>/node/<id> connection opens that node\'s running broker view.sock and relays frames VERBATIM both directions.',
      'NEVER spawns pi and NEVER writes any session — it only opens a socket to an already-running broker; if the broker is not running, the browser connection is closed with a clear reason.',
    ],
  },
  run: async (input) => {
    const port = (input['port'] as number | undefined) ?? DEFAULT_PORT;
    const open = (input['open'] as boolean | undefined) ?? false;

    const server = await startWebServer({ port });
    const nodeUrlShape = `${server.url}/node/<id>`;
    process.stdout.write(
      `crtr web serving on ${server.url}\n` +
        `  open a node:  ${nodeUrlShape}\n` +
        `  client dir:   ${server.clientDir}\n` +
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
      concept: 'a browser bridge for headless nodes — serve a web viewer that relays to a node\'s running broker',
      desc: 'serve a browser viewer for headless nodes',
      useWhen:
        'you want to watch or drive headless nodes from a browser instead of a tmux pane. It runs one long-lived local server that serves the viewer and relays a browser connection VERBATIM to a node\'s already-running broker over its unix socket — same protocol peer as `crtr attach`. The node is selected in the browser via the /node/<id> URL; the server never starts an engine, so each node must already have a running headless broker.',
    },
    help: {
      name: 'web',
      summary: 'serve a browser viewer that bridges to headless nodes\' running brokers',
      model:
        '`serve` starts the ONE long-running bridge on 127.0.0.1 (--port, default 7878; --open to launch the browser). It serves the static web viewer and, on a browser ws://127.0.0.1:PORT/node/<id> connection, opens that node\'s broker view.sock and relays frames VERBATIM both ways — the browser is the same protocol peer as `crtr attach` (one controller drives, extra viewers are read-only; arbitration + dialogs ride the same frames). It NEVER spawns pi or writes a session: the node must already have a running headless broker (focus or revive it first). The server keeps running until ctrl+c; the node is chosen in the browser via the URL, not on the command line.',
    },
    children: [webServeLeaf],
  });
}
