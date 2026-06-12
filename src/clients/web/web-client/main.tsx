// main.tsx — the shell SPA entry. Mounts <Shell> (design §3) and pulls in Tailwind
// (styles.css). Served two ways by the unified `crtr web serve` (design §11):
// the prebuilt dist/web-client/ bundle (shipped) or Vite middleware (--dev, HMR).

import './styles.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell } from './Shell.js';

const root = document.getElementById('root');
if (root === null) throw new Error('shell: #root missing');
createRoot(root).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
