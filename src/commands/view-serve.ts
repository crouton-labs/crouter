// `crtr view serve <name>` — open a dual-target view in the BROWSER.
//
// This is the web target's host (the TUI target is `crtr view run`). It is NOT
// a TUI and carries NO tmux requirement: it is a plain Node process that runs
// two local servers and opens a browser.
//
//   1. A Vite dev server that bundles, FOR THE BROWSER: the view's core.mjs +
//      web.jsx + the crtr web runtime (src/web). Vite owns JSX + Tailwind. The
//      portable core runs CLIENT-SIDE (the ratified run-location decision) so a
//      future static publish is a `vite build` + transport swap, not a rewrite.
//   2. A bridge HTTP endpoint (`POST /__crtr/source`) mounted on the same Vite
//      server: it decodes a SourceRequest and runs it through the LOCAL
//      transport (execFile/readFile in this cwd), returning the RawResponse the
//      browser bundle's HTTP transport asked for. This endpoint is the ONE
//      thing a cloud deploy replaces.
//
// PROVISIONAL host — kept thin and tear-out-able (the design says it will later
// fold into the broader crouter web interface). Re-hosting the core+web.jsx
// bundle elsewhere is a mount/transport swap, nothing here is load-bearing.

import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError, diag } from '../core/io.js';
import { resolveView, requireWeb, listViews } from '../core/view/loader.js';
import { createLocalTransport } from '../core/view/transport-local.js';
import { runSourceRequest } from '../core/view/bridge.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Locate the web runtime entry — runtime.tsx in dev (tsx from src), runtime.js
 *  in a built/published install (dist). */
function resolveRuntimeEntry(): string {
  const webDir = resolve(HERE, '../web');
  for (const f of ['runtime.tsx', 'runtime.js']) {
    const p = join(webDir, f);
    if (existsSync(p)) return p;
  }
  throw new Error(`crtr web runtime not found under ${webDir} (expected runtime.tsx or runtime.js)`);
}

/** Best-effort open of the default browser. Never throws — the printed URL is
 *  the fallback. */
function openBrowser(url: string): void {
  const platform = process.platform;
  const [cmd, args] =
    platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true });
    child.on('error', () => { /* no opener available */ });
    child.unref();
  } catch { /* ignore */ }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { chunks.push(c); });
    // Buffer.concat before decoding so a multibyte char split across chunks
    // (e.g. UTF-8 in a write command's stdin) is never corrupted.
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

export const viewServeLeaf: LeafDef = defineLeaf({
  name: 'serve',
  description: 'open a view in the browser (the web target) — Vite dev server + a local source bridge',
  whenToUse:
    'you want to OPEN a dual-target view as a React+Tailwind web page instead of a tmux pane. It is the web counterpart of `crtr view run`: a plain Node process (no tmux required) that starts a Vite dev server bundling the view\'s core + web component + the crtr web runtime, plus a local bridge that runs the view\'s sources (exec/file) on this machine, then opens your browser. Requires the view to ship a web.jsx presenter; a tui-only view points you back at `crtr view run`. Use `crtr view list` to see what is available.',
  help: {
    name: 'view serve',
    summary: 'serve a view\'s web target: a Vite dev server (core+web.jsx+runtime) + a local /__crtr/source bridge, then open the browser',
    params: [
      { kind: 'positional', name: 'name', required: true, constraint: 'View id to serve (its directory name). Resolves project→user→builtin. Must ship a web.jsx presenter.' },
      { kind: 'flag', name: 'port', type: 'int', required: false, constraint: 'TCP port for the Vite dev server (also hosts the bridge). Default: Vite picks a free port from 5173.' },
      { kind: 'flag', name: 'no-open', type: 'bool', required: false, constraint: 'Do not auto-open the browser; just print the URL and keep serving.' },
      { kind: 'flag', name: 'target', type: 'string', required: false, constraint: 'Forwarded verbatim into the view\'s options map (read by core.init).' },
    ],
    output: [],
    outputKind: 'object',
    effects: [
      'Binds a long-running Vite dev server on 127.0.0.1:<port> (default Vite picks from 5173) and serves until interrupted (ctrl+c / SIGTERM).',
      'Mounts POST /__crtr/source on that server: decodes a SourceRequest and runs it through the LOCAL transport (execFile/readFile in this cwd), returning RawResponse JSON.',
      'Opens the default browser to the served URL unless --no-open; the URL is always printed.',
      'Runs the portable core CLIENT-SIDE in the browser; mutates nothing on the canvas. No tmux required.',
    ],
  },
  run: async (input) => {
    const name = input['name'] as string;
    const port = input['port'] as number | undefined;
    const noOpen = input['noOpen'] === true;
    const target = input['target'] as string | undefined;

    const r = resolveView(name);
    if (r === null) {
      const avail = listViews().map((v) => v.id);
      throw new InputError({
        error: 'view_not_found',
        message: `no view: ${name}`,
        received: name,
        next: avail.length > 0
          ? `Available views: ${avail.join(', ')}. Or scaffold one with \`crtr view new ${name}\`.`
          : `No views found. Scaffold one with \`crtr view new ${name}\`.`,
      });
    }
    // Web target requires a web.jsx presenter; a tui-only view points back to run.
    requireWeb(r);

    const runtimeEntry = resolveRuntimeEntry();
    const options: Record<string, string> = {};
    if (target !== undefined) options.target = target;

    // React/Tailwind/JSX are owned by Vite; the core (.mjs) + web (.jsx) are
    // bundled verbatim. The bundled deps (react, tailwindcss, the crtr web
    // runtime) all live in crouter's OWN node_modules — and a builtin/user view
    // can sit anywhere on disk — so the generated Vite root must be a place whose
    // node_modules resolution walk REACHES that dir. A scratch dir under
    // crouter/node_modules satisfies that for every bare specifier at once
    // (tailwindcss's CSS @import, react, and the `@crouton-kit/crouter/web`
    // self-subpath) — a sibling /tmp root resolves none of them.
    const packageRoot = resolve(HERE, '../..');
    const nodeModules = join(packageRoot, 'node_modules');

    // Scaffold a tiny Vite root: index.html + a generated entry that wires the
    // runtime to THIS view's core + web component, plus the Tailwind stylesheet.
    const tmp = mkdtempSync(join(nodeModules, '.crtr-view-serve-'));
    const entryFile = join(tmp, 'entry.jsx');
    // Tailwind v4 (@tailwindcss/vite) auto-content-detection scans from the CSS
    // file's base, but EXCLUDES node_modules AND .gitignore'd paths. Our Vite
    // root lives under node_modules (for dep resolution) and both the view's
    // web.jsx (r.dir) and the crtr web runtime (dist/web) sit under gitignored
    // dist/ — so auto-detection finds ZERO of the utility classes and emits a
    // preflight-only stylesheet (the board renders unstyled). Explicit @source
    // directives override both exclusions: they register the exact dirs whose
    // JSX/JS carry the className literals, so the utilities are generated.
    const webSources = [r.dir, join(packageRoot, 'dist', 'web')];
    writeFileSync(
      join(tmp, 'styles.css'),
      '@import "tailwindcss";\n' +
        webSources.map((d) => `@source ${JSON.stringify(d)};`).join('\n') + '\n',
    );
    writeFileSync(join(tmp, 'index.html'),
      '<!doctype html>\n<html>\n<head>\n<meta charset="utf-8" />\n' +
      `<title>${r.id}</title>\n` +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
      '</head>\n<body>\n<div id="root"></div>\n' +
      '<script type="module" src="/entry.jsx"></script>\n</body>\n</html>\n');
    writeFileSync(entryFile,
      "import './styles.css';\n" +
      `import { mount } from ${JSON.stringify(runtimeEntry)};\n` +
      `import core from ${JSON.stringify(r.core)};\n` +
      `import View from ${JSON.stringify(r.web as string)};\n` +
      `mount(core, View, { options: ${JSON.stringify(options)} });\n`);

    // The bridge runs the view's sources locally, in the cwd crtr was invoked
    // from (a git-pr view inspects THIS repo). Same model as the TUI host.
    const transport = createLocalTransport({ cwd: process.cwd() });

    const { createServer } = await import('vite');
    const react = (await import('@vitejs/plugin-react')).default;
    const tailwindcss = (await import('@tailwindcss/vite')).default;

    // The bridge: POST /__crtr/source → run the SourceRequest via the local
    // transport. Registered through a plugin's configureServer PRE-hook (the
    // returned thunk) so it runs BEFORE Vite's SPA/404 fallback — a plain
    // post-createServer `middlewares.use` lands AFTER that fallback and never
    // sees the POST (it 404s).
    const bridgePlugin = {
      name: 'crtr:source-bridge',
      configureServer(s: { middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void } }) {
        return () => {
          s.middlewares.use((req: IncomingMessage, res: ServerResponse, next: () => void) => {
            if (req.method === 'POST' && (req.url === '/__crtr/source' || req.url?.startsWith('/__crtr/source?'))) {
              void readBody(req)
                .then((body) => runSourceRequest(transport, body))
                .then(({ status, body }) => {
                  res.statusCode = status;
                  res.setHeader('content-type', 'application/json');
                  res.end(body);
                })
                .catch((e: unknown) => {
                  res.statusCode = 500;
                  res.setHeader('content-type', 'application/json');
                  res.end(JSON.stringify({ ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) }));
                });
              return;
            }
            next();
          });
        };
      },
    };

    const server = await createServer({
      configFile: false,
      root: tmp,
      plugins: [react(), tailwindcss(), bridgePlugin],
      resolve: {
        alias: {
          react: join(nodeModules, 'react'),
          'react-dom': join(nodeModules, 'react-dom'),
          // The crtr web runtime is a self-subpath of crouter's own package;
          // enhanced-resolve won't self-reference it from a generated root, so
          // pin it to the built barrel explicitly (same idiom as react above).
          '@crouton-kit/crouter/web': join(packageRoot, 'dist', 'web', 'index.js'),
        },
        dedupe: ['react', 'react-dom'],
      },
      server: {
        host: '127.0.0.1',
        port,
        fs: { allow: [tmp, packageRoot, r.dir] },
      },
      // Quiet Vite's own banner; we print our URL.
      logLevel: 'warn',
    });

    await server.listen();
    const url = server.resolvedUrls?.local[0] ?? `http://127.0.0.1:${port ?? 5173}/`;
    process.stdout.write(
      `crtr view serve "${r.id}" on ${url}\n` +
      `  source bridge:  POST ${url.replace(/\/$/, '')}/__crtr/source\n` +
      `  (ctrl+c to stop)\n`,
    );
    if (!noOpen) openBrowser(url);

    // Long-running: resolve on a shutdown signal, then tear down Vite + tmp.
    await new Promise<void>((resolveShutdown) => {
      const shutdown = (): void => {
        void server.close()
          .catch(() => { /* best-effort */ })
          .finally(() => {
            try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
            resolveShutdown();
          });
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      process.once('SIGHUP', shutdown);
    });
    diag(`view serve "${r.id}" stopped`);
    return;
  },
  render: () => '',
});
