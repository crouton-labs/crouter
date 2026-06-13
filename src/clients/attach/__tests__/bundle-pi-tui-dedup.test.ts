// Regression: after the attach viewer was re-bundled (commit d72c0de), Alt+Enter
// silently stopped inserting a newline. Root cause was NOT in the editor logic —
// editor-newline.test.ts still passed because it runs UNBUNDLED (tsx), where
// config-load and pi-coding-agent's CustomEditor each load their own pi-tui from
// disk and `mirrorKeybindingsToEditor` reaches the editor's disk copy.
//
// In the BUNDLE, esbuild inlined TWO distinct pi-tui module instances — the
// top-level `node_modules/@earendil-works/pi-tui` (imported by config-load) and
// pi-coding-agent's nested `.../pi-coding-agent/node_modules/@earendil-works/pi-tui`
// (imported by CustomEditor). `setKeybindings` ran against the first global; the
// editor read `getKeybindings` from the second. The Alt+Enter newLine binding was
// invisible to the editor and the key fell through — swallowed. The runtime disk
// mirror can't help: it targets a third (on-disk) instance, not either bundled one.
//
// Fix: the build:attach script aliases @earendil-works/pi-tui to one absolute
// path so esbuild collapses both imports to a SINGLE bundled instance, and
// setKeybindings reaches the editor directly. This test bundles attach-cmd.ts
// the way the build script does and asserts exactly one pi-tui copy is inlined.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..'); // src/clients/attach/__tests__ → package root
const entry = join(repoRoot, 'src/clients/attach/attach-cmd.ts');
const piTui = join(repoRoot, 'node_modules/@earendil-works/pi-tui');

/** Count distinct pi-tui package directories esbuild inlines into the bundle.
 *  Unminified output keeps each module's source path as a `// <path>` comment. */
function piTuiCopies(code: string): Set<string> {
  const copies = new Set<string>();
  for (const m of code.matchAll(/node_modules\/(?:\.pnpm\/)?@earendil-works\/(?:pi-coding-agent\/node_modules\/@earendil-works\/)?pi-tui/g)) {
    copies.add(m[0]);
  }
  return copies;
}

test('build:attach aliases pi-tui to one path (sanity: package.json carries the alias)', () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  assert.match(
    pkg.scripts['build:attach'],
    /--alias:@earendil-works\/pi-tui=/,
    'build:attach must alias pi-tui so the bundle inlines a single instance',
  );
});

test('attach bundle inlines exactly ONE pi-tui instance (editor + config-load share the keybindings global)', async () => {
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    alias: { '@earendil-works/pi-tui': piTui },
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  const copies = piTuiCopies(code);
  assert.equal(
    copies.size,
    1,
    `bundle must inline exactly one pi-tui (two = the Alt+Enter regression). Found: ${[...copies].join(', ')}`,
  );
});
