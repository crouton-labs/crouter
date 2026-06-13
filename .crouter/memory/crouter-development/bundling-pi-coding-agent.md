---
kind: knowledge
when-and-why-to-read: When bundling crouter's attach viewer — or any
  pi-coding-agent consumer — with esbuild, this knowledge should be read because
  it carries the two non-obvious runtime fixes without which the bundle crashes
  every full-tree crtr invocation.
short-form: "Bundling @earendil-works/pi-coding-agent with esbuild: needs
  PI_PACKAGE_DIR override + createRequire banner, else asset-resolution +
  dynamic-require crashes."
system-prompt-visibility: name
file-read-visibility: name
---

Bundling `@earendil-works/pi-coding-agent` (e.g. crouter's `crtr attach` viewer) into a single esbuild file is worth it — it collapses the ~940-file resolve+read tax of pi's barrel to ONE file (~0.74s→~0.49s module load; ~0.35s with compile-cache), which is most of the attach cold-boot cost. The win is the file-count collapse, NOT tree-shaking: pi's barrel isn't `sideEffects:false`, so the engine stays in the bundle (~6.4MB). Two runtime landmines must both be fixed or the bundle crashes on import — and they only surface when code actually runs (theme/render), never on `--help`, so verify against a real attach, not `attach -h`.

**1. Asset-resolution (the subtle one, inside node_modules).** pi finds its theme/asset root by walking up from its OWN `import.meta.url` to the nearest `package.json` (`config.js` getPackageDir). Bundled into the consumer's `dist/`, that walk lands on the CONSUMER's package.json, so `initTheme` ENOENTs on `src/modes/interactive/theme/dark.json` (pi ships it at `node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json`). FIX: pi's documented override — set `process.env.PI_PACKAGE_DIR` to pi's real package dir at the very top of the bundled entry, before any theme access. Resolve it via `import.meta.resolve('@earendil-works/pi-coding-agent/package.json')` → dirname; `import.meta.resolve` survives bundling. Harmless no-op on the unbundled dev (tsx) path.

**2. `Dynamic require of "child_process" is not supported`.** esbuild's `--format=esm` shims `require` to a thunk that throws; bundled CJS deps (cross-spawn, the SDK) call `require()` at runtime. FIX: a createRequire banner so esbuild's `__require` falls through to a real require: `--banner:js="import{createRequire as __cr}from'node:module';const require=__cr(import.meta.url);"`.

**Keep it scoped + safe.** Bundle ONLY the heavy viewer entry; let tsc emit the rest of `dist/` unbundled so the broker/crtrd sibling-entry resolvers (and crouter's ~12 `import.meta.url` sites) are untouched. Verify the one-writer invariant after: `grep -c 'reviveNode\|headlessBrokerHost\|resolveBrokerEntry' <bundle>` must be 0 — the viewer holds only a socket and must never pull the broker launcher (placement.ts is reachable but its reviver is dependency-injected, so tree-shaking drops focus()/the reviver as long as attach imports only leaf helpers).

History note: a first attempt concluded pi's asset resolution had "no clean fix" and reverted the bundle to compile-cache-only. That was wrong — PI_PACKAGE_DIR is the clean fix.
