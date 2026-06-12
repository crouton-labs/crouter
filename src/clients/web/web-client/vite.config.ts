// vite.config.ts — DEV/BUILD config for the web client. Used two ways:
//  • Verification (dev): `vite --config …/vite.config.ts` serves the dev harness
//    and PROXIES the broker relay so same-origin WS works (rewriting Origin to an
//    allowed value so the relay's same-origin allowlist M1 admits it).
//  • Shipped (design §11): the shell phase runs `vite build` against this config
//    to emit `dist/web-client/`. v1 ships ConversationPane; the full shell entry
//    (Sidebar/ViewPane/registry) is the next phase and is NOT in this build yet.
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

export default defineConfig({
  root: resolve(HERE, 'dev'),
  plugins: [react(), tailwindcss()],
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
