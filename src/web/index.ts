// index.ts — the public barrel for crtr's web runtime, published as the package
// `exports` subpath `@crouton-kit/crouter/web` (→ ./dist/web/index.js).
//
// A dual-target view's `web.jsx` imports the shared four-state vocabulary +
// (if it needs them) the chrome wrapper from here, via that stable specifier —
// NOT a relative path from builtin-views, which would break for user/project
// views living outside the package tree. The shell + dev Vite resolve this
// subpath against crouter's own built barrel.
//
// The web shell composes views via <ViewPane>/useViewCore (the React surface)
// over createViewStore (the framework-free dispatch loop + the onIntent tap +
// the refresh() SSE seam).

export { ViewPane, useViewCore } from './ViewPane.js';
export type { UseViewCoreOptions, ViewCoreHandle } from './ViewPane.js';
export { createViewStore } from './runtime.js';
export type { ViewStore, ViewStoreOptions, IntentTap } from './runtime.js';
export { ViewChrome } from './ViewChrome.js';
export { Loading, Empty, ErrorState, NotReady } from './states.js';
