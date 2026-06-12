// harness.tsx — DEV HARNESS ONLY (not shipped). Mounts a single <ConversationPane>
// for the node id in `?node=<id>` so the component can be verified live against
// `crtr web serve` (proxied by Vite — see vite.config.ts). The real shell mounts
// the component itself; this file exists solely for hands-on verification.

import { StrictMode, type JSX } from 'react';
import { createRoot } from 'react-dom/client';
import { ConversationPane } from '../ConversationPane.js';
import '../styles.css';

const nodeId = new URLSearchParams(location.search).get('node') ?? '';

function Harness(): JSX.Element {
  if (nodeId === '') {
    return (
      <div style={{ color: '#e5e5e5', fontFamily: 'sans-serif', padding: 24 }}>
        Pass a node id: <code>?node=&lt;id&gt;</code>
      </div>
    );
  }
  return (
    <ConversationPane
      nodeId={nodeId}
      onWake={async (id) => {
        // The shell wires this to the bridge command path; the harness just logs.
        console.log('[harness] onWake', id, '— shell would run: crtr canvas revive', id);
      }}
    />
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
