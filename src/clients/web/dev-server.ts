// dev-server.ts — `crtr web serve --dev` Vite middleware mode.
//
// The shipped server serves a prebuilt static shell bundle from dist/web-client/
// (§11). In --dev a contributor iterating on the shell or a builtin view gets
// HMR instead: a Vite dev server in MIDDLEWARE mode mounted on the SAME HTTP
// server as the bridge + WS relay. This is the one place Vite runs at runtime —
// the mainstream "Vite middleware in dev, static dist in prod" split.
//
// The bridge (POST /__crtr/source), the SSE lane (GET /__crtr/events) and the
// WS relay are owned by server.ts and checked BEFORE Vite's middlewares; this
// module only supplies the asset/HMR middleware. Vite's HMR WebSocket shares
// the HTTP server (server.hmr.server) — server.ts's upgrade handler routes
// `/node/<id>` to the broker relay and leaves every other upgrade for Vite.

import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server as HttpServer } from 'node:http';
import type { ViteDevServer } from 'vite';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The shell SPA Vite root — the in-tree shell project (`src/clients/web/web-client/`).
 *  --dev is a from-source contributor loop, so this resolves against the source
 *  tree (HERE is `dist/clients/web` when built, `src/clients/web` under tsx);
 *  walk to the package root and into src. */
function resolveShellRoot(packageRoot: string): string {
  return join(packageRoot, 'src', 'clients', 'web', 'web-client');
}

/** Create a Vite dev server in middleware mode, HMR bound to `httpServer`.
 *  Mirrors the old `view serve` resolve setup so the shell's bare imports
 *  (react, the `@crouton-kit/crouter/web` self-subpath) resolve from the
 *  generated/shell root. Lazily imports vite so the shipped path never loads it. */
export async function createDevServer(httpServer: HttpServer): Promise<ViteDevServer> {
  const packageRoot = resolve(HERE, '../../..');
  const nodeModules = join(packageRoot, 'node_modules');
  const shellRoot = resolveShellRoot(packageRoot);

  const { createServer } = await import('vite');
  const react = (await import('@vitejs/plugin-react')).default;
  const tailwindcss = (await import('@tailwindcss/vite')).default;

  return createServer({
    configFile: false,
    root: shellRoot,
    plugins: [react(), tailwindcss()],
    appType: 'spa',
    resolve: {
      alias: {
        react: join(nodeModules, 'react'),
        'react-dom': join(nodeModules, 'react-dom'),
        // The crtr web runtime is a self-subpath of crouter's own package;
        // pin it to the built barrel so the shell can import it from any root.
        '@crouton-kit/crouter/web': join(packageRoot, 'dist', 'web', 'index.js'),
      },
      dedupe: ['react', 'react-dom'],
    },
    server: {
      middlewareMode: true,
      // Share our HTTP server for HMR; server.ts's upgrade handler hands every
      // non-`/node/<id>` upgrade to Vite (the vite-hmr WebSocket).
      hmr: { server: httpServer },
      fs: { allow: [shellRoot, packageRoot] },
    },
    logLevel: 'warn',
  });
}
