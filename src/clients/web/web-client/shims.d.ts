// shims.d.ts — ambient module types for the shell's static view-registry imports.
// The builtin view cores (.mjs) and web presenters (.jsx) are plain JS authored
// outside this tsconfig's allowJs scope; Vite/esbuild bundle them at build time.
// These shims let the registry import them without per-line ts-expect-error.

declare module '*.mjs' {
  // A view core: manifest · init · sources · commands · intents (browser-safe).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const core: any;
  export default core;
}

declare module '*.jsx' {
  import type { FunctionComponent } from 'react';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Component: FunctionComponent<any>;
  export default Component;
}
