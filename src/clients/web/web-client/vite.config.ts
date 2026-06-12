// vite.config.ts — BUILD/DEV config for the shell SPA (design §11). Used two ways:
//  • Shipped: `npm run build` runs `vite build` against this config to emit the
//    static shell bundle into `dist/web-client/`, which `crtr web serve` serves.
//  • Standalone dev: `vite --config …/vite.config.ts` serves the shell and PROXIES
//    the bridge + broker relay to a running `crtr web serve` so same-origin
//    POST/WS work (rewriting Origin to an allowed value so the relay's same-origin
//    allowlist M1 admits it). (`crtr web serve --dev` is the integrated equivalent.)
//
// The shell statically imports the builtin view cores/presenters from src/ and the
// web runtime via the `@crouton-kit/crouter/web` subpath — aliased here to the
// built barrel (dist/web), produced by the `tsc` step that runs before this build.
//
// The relay runs on 127.0.0.1:7878 by default (`crtr web serve`); override with
// CRTR_WEB_PORT for the proxy target.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RELAY = `127.0.0.1:${process.env['CRTR_WEB_PORT'] ?? '7878'}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rewriteOrigin = (proxy: any) => {
  // The relay's M1 allowlist admits an Origin matching its own host; the browser
  // would otherwise send the Vite origin and be 403'd on the WS upgrade.
  proxy.on('proxyReqWs', (req: { setHeader: (k: string, v: string) => void }) => req.setHeader('origin', `http://${RELAY}`));
  proxy.on('proxyReq', (req: { setHeader: (k: string, v: string) => void }) => req.setHeader('origin', `http://${RELAY}`));
};

const PACKAGE_ROOT = resolve(HERE, '../../../..');

export default defineConfig({
  root: HERE,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // crouter's own web runtime, pinned to its built barrel so the shell + the
      // builtin web.jsx presenters resolve it from this root.
      '@crouton-kit/crouter/web': resolve(PACKAGE_ROOT, 'dist/web/index.js'),
    },
    dedupe: ['react', 'react-dom'],
  },
  server: {
    proxy: {
      '/node': { target: `ws://${RELAY}`, ws: true, changeOrigin: true, configure: rewriteOrigin },
      '/__crtr': { target: `http://${RELAY}`, changeOrigin: true, configure: rewriteOrigin },
    },
  },
  build: {
    outDir: resolve(HERE, '../../../../dist/web-client'),
    emptyOutDir: true,
  },
});
