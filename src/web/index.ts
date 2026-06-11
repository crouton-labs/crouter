// index.ts — the public barrel for crtr's web runtime, published as the package
// `exports` subpath `@crouton-kit/crouter/web` (→ ./dist/web/index.js).
//
// A dual-target view's `web.jsx` imports the shared four-state vocabulary +
// (if it needs them) the chrome wrapper / mount from here, via that stable
// specifier — NOT a relative path from builtin-views, which would break for
// user/project views living outside the package tree. The serve path (Vite)
// resolves this subpath against crouter's own node_modules.

export { mount } from './runtime.js';
export type { MountOptions } from './runtime.js';
export { ViewChrome } from './ViewChrome.js';
export { Loading, Empty, ErrorState, NotReady } from './states.js';
