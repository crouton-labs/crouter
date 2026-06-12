// vite.config.ts — THROWAWAY harness dev server for verifying <ViewPane>.
//
// Mirrors what the unified `crtr web serve --dev` does for the shell, scoped to
// this harness dir so it stays entirely inside the view-pane lane (no edits to
// src/clients/web/**). It serves index.html + main.tsx with react + tailwind,
// resolves the `@crouton-kit/crouter/web` subpath to the built barrel, and adds
// the POST /__crtr/source bridge middleware (the exact body lifted into
// server.ts) so the canvas view's `crtr … --json` sources resolve against the
// live machine.

import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';
// Built (dist) bridge + local transport — plain JS, no NodeNext resolution
// snags. dist is wiped before tsc, so these only resolve at vite runtime (after
// a build); suppress the build-time module-not-found.
// @ts-expect-error — built barrel, resolved at vite runtime only
import { runSourceRequest } from '../../../dist/core/view/bridge.js';
// @ts-expect-error — built barrel, resolved at vite runtime only
import { createLocalTransport } from '../../../dist/core/view/transport-local.js';

const HERE = resolve(import.meta.dirname);
const PKG = resolve(HERE, '../../..');

/** The source/command bridge as a Vite middleware (the same contract as the
 *  unified server's POST /__crtr/source). */
function bridgePlugin(): Plugin {
  const transport = createLocalTransport({ cwd: process.cwd() });
  return {
    name: 'crtr-harness-bridge',
    configureServer(server) {
      server.middlewares.use('/__crtr/source', (req, res, next) => {
        if (req.method !== 'POST') { next(); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', async () => {
          const { status, body: out } = await runSourceRequest(transport, body);
          res.statusCode = status;
          res.setHeader('content-type', 'application/json');
          res.end(out);
        });
      });
    },
  };
}

export default defineConfig({
  root: HERE,
  plugins: [react(), tailwindcss(), bridgePlugin()],
  resolve: {
    alias: {
      '@crouton-kit/crouter/web': resolve(PKG, 'dist', 'web', 'index.js'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5199,
    fs: { allow: [HERE, PKG] },
  },
  logLevel: 'warn',
});
