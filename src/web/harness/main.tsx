// main.tsx — THROWAWAY verification harness for <ViewPane> (Wave 2, §4.1).
//
// Proves the ViewPane surface works in a real browser WITHOUT touching the
// sibling-owned shell under src/clients/web/client/: it mounts the canvas view
// through <ViewPane>, runs its sources over the bridge (the vite.config bridge
// middleware → local transport → real `crtr …`), and installs an onIntent TAP
// that records the canvas `activate` payload to a visible panel + a window
// global, so a screenshot proves the tap observes a click.
//
// It imports the BUILT artifacts (dist/) so vite never has to resolve the
// package's `.js`-extension NodeNext source imports — `npm run build` first,
// then `npx vite` here. This is exactly how the shipped shell loads the runtime.

import './index.css';
import { createRoot } from 'react-dom/client';
import { createElement, useState } from 'react';
// @ts-expect-error — built barrel, no local types path
import { ViewPane } from '../../../dist/web/index.js';
// @ts-expect-error — built (copied) view core, plain JS
import canvasCore from '../../../dist/builtin-views/canvas/core.mjs';
// @ts-expect-error — built (copied) view web component, JSX
import CanvasWeb from '../../../dist/builtin-views/canvas/web.jsx';

type Tapped = { name: string; payload: unknown; at: number };

function Harness() {
  const [taps, setTaps] = useState<Tapped[]>([]);

  const onIntent = (name: string, payload: unknown) => {
    // Record EVERY tapped intent; the `activate` one is what the shell wires.
    const entry: Tapped = { name, payload, at: Date.now() };
    setTaps((prev) => [entry, ...prev].slice(0, 8));
    // Expose for capture/automation assertions.
    (window as unknown as { __lastIntent?: Tapped }).__lastIntent = entry;
    // eslint-disable-next-line no-console
    console.log('[harness onIntent tap]', name, JSON.stringify(payload));
  };

  return createElement(
    'div',
    { style: { display: 'flex', gap: '16px', alignItems: 'flex-start', padding: '16px', fontFamily: 'ui-sans-serif, system-ui' } },
    createElement(
      'div',
      { style: { flex: '1 1 0', minWidth: 0, border: '1px solid #e2e8f0', borderRadius: '8px', overflow: 'hidden' } },
      createElement(ViewPane, { core: canvasCore, View: CanvasWeb, onIntent }),
    ),
    createElement(
      'div',
      {
        id: 'tap-panel',
        style: {
          width: '340px', flex: '0 0 auto', border: '1px solid #cbd5e1', borderRadius: '8px',
          padding: '12px', background: '#0f172a', color: '#e2e8f0', fontFamily: 'ui-monospace, monospace', fontSize: '12px',
        },
      },
      createElement('div', { style: { fontWeight: 700, marginBottom: '8px', color: '#38bdf8' } }, 'onIntent TAP (shell seam)'),
      taps.length === 0
        ? createElement('div', { style: { opacity: 0.6 } }, 'click a node row to fire `activate`…')
        : taps.map((t, i) =>
            createElement(
              'div',
              { key: t.at + '-' + i, style: { padding: '6px 0', borderBottom: '1px solid #1e293b' } },
              createElement('span', { style: { color: t.name === 'activate' ? '#4ade80' : '#94a3b8', fontWeight: 700 } }, t.name),
              createElement('span', { style: { color: '#cbd5e1' } }, '  ' + JSON.stringify(t.payload)),
            ),
          ),
    ),
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('harness: no #root');
createRoot(root).render(createElement(Harness));
