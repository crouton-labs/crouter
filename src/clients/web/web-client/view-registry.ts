// view-registry.ts — the build-time registry of bundled builtin views (design
// §11). Static imports of each builtin's browser-safe core (.mjs) + web presenter
// (.jsx), so Vite bundles them INTO the shell — no per-view dev server, no dynamic
// loading. Paths are src-relative; both the dev Vite root (web-client) and the
// `vite build` resolve them against src/builtin-views/.
//
// SEAM (design §11): user/project views are not bundled in v1. The registry is a
// plain map; a future `crtr view build` can dynamic-import additional entries.

import type { ViewCore, ChromeState } from '../../../core/view/contract.js';
import type { FunctionComponent } from 'react';

import canvasCore from '../../../builtin-views/canvas/core.mjs';
import CanvasWeb from '../../../builtin-views/canvas/web.jsx';
import inboxCore from '../../../builtin-views/inbox/core.mjs';
import InboxWeb from '../../../builtin-views/inbox/web.jsx';
import gitPrCore from '../../../builtin-views/git-pr/core.mjs';
import GitPrWeb from '../../../builtin-views/git-pr/web.jsx';
import linkedinCore from '../../../builtin-views/linkedin/core.mjs';
import LinkedinWeb from '../../../builtin-views/linkedin/web.jsx';
import workspaceCore from '../../../builtin-views/workspace-sidebar/core.mjs';
import WorkspaceWeb from '../../../builtin-views/workspace-sidebar/web.jsx';

export type ViewProps = {
  state: unknown;
  dispatch: (intent: string, payload?: unknown) => void;
  chrome: ChromeState;
};

export interface ViewEntry {
  core: ViewCore;
  View: FunctionComponent<ViewProps>;
}

export const VIEW_REGISTRY: Record<string, ViewEntry> = {
  canvas: { core: canvasCore as ViewCore, View: CanvasWeb },
  inbox: { core: inboxCore as ViewCore, View: InboxWeb },
  'git-pr': { core: gitPrCore as ViewCore, View: GitPrWeb },
  linkedin: { core: linkedinCore as ViewCore, View: LinkedinWeb },
  'workspace-sidebar': { core: workspaceCore as ViewCore, View: WorkspaceWeb },
};

/** View ids a user can open from the shell's view menu (canvas is the always-on
 *  sidebar navigator, so it is excluded from the openable-as-a-tab list). */
export const OPENABLE_VIEW_IDS = Object.keys(VIEW_REGISTRY).filter((id) => id !== 'canvas');

export function viewTitle(viewId: string): string {
  return VIEW_REGISTRY[viewId]?.core.manifest.title ?? viewId;
}
