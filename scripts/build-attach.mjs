// Bundles the attach viewer (`crtr attach`) into a single minified ESM file so
// its cold boot skips Node resolving+compiling the ~760-file paint-only subset
// of the @earendil-works/pi-coding-agent graph on every launch (the dominant
// ~700ms of the old ~1s boot). tsc emits the rest of dist/ unbundled; only this
// one heavy entry is bundled.
//
// The createRequire banner is load-bearing: esbuild's ESM output shims `require`
// to a thunk that throws `Dynamic require of "X" is not supported`, and bundled
// deps (cross-spawn, the SDK) call require('child_process'/'fs'/...) at runtime.
// Defining a real top-level `require` via createRequire lets that shim delegate
// instead of throwing — without it, loading the bundle crashes every `crtr`
// invocation that builds the full command tree (e.g. bare `crtr`).
import { build } from 'esbuild';

await build({
  entryPoints: ['src/clients/attach/attach-cmd.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: 'dist/clients/attach/attach-cmd.js',
  banner: {
    js: "import { createRequire as __crtrCreateRequire } from 'module'; const require = __crtrCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
