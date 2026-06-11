// Regression test for the namespaced plugin-doc READ path in resolveMemoryDoc.
//
// Bug (substrate-unification cut f1b071b, fixed by 945d121): plugin memory docs
// mount at a virtual `<pluginName>/` namespace and ARE enumerated by
// listAllMemoryDocs, so `crtr memory list` advertises canonical names like
// `claude-capture/capture`. But findMemoryMatches (the direct-path lookup inside
// resolveMemoryDoc) only searched the NATIVE scopeMemoryDir, never each plugin's
// pluginMemoryDir — so `crtr memory read <plugin>/<leaf>` returned not_found for
// a name that `list` had just shown. Only the bare-leaf fallback (`read capture`)
// resolved. The fix taught findMemoryMatches to resolve `<plugin>/<rest>` against
// each enabled plugin's pluginMemoryDir, native-before-plugin precedence kept.
//
// Follow-up bug (same seat): the `<plugin>/<rest>` branch required a non-empty
// rest (`if (slash <= 0) continue`), so a BARE plugin name never tried the
// plugin-root INDEX.md — `read claude-godot-prompter` / `read ai` returned
// not_found even though `<plugin>/INDEX` and `<plugin>/<child>` resolved. The
// fix resolves a bare plugin name to `<plugin>/memory/INDEX.md`, mirroring the
// native bare-dir-name -> INDEX.md contract, native-before-plugin kept.
//
// This test FAILS on the pre-fix code (the fully-qualified and bare-plugin-name
// reads throw notFound) and PASSES on the current code.
//
// Run: node --import tsx/esm --test src/core/__tests__/memory-resolver.test.ts

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveMemoryDoc } from '../memory-resolver.js';
import { resetScopeCache } from '../scope.js';

// Fixture: a temp PROJECT scope (a `.crouter/` dir discovered by walking up from
// cwd) holding both a native memory/ tree and one enabled fixture plugin whose
// memory/ tree mounts under the `fixplug/` namespace.
let projectDir: string;
let prevCwd: string;

const PLUGIN = 'fixplug';

function doc(name: string): string {
  return `---\nkind: knowledge\nwhen-and-why-to-read: fixture doc ${name}\n---\n\n# ${name}\n`;
}

before(() => {
  prevCwd = process.cwd();
  projectDir = mkdtempSync(join(tmpdir(), 'crtr-memres-'));
  const scopeRoot = join(projectDir, '.crouter');

  // Native scope docs. `fixplug/shared` is a native SHADOW of a plugin doc of
  // the same canonical name — it must win (native-before-plugin precedence).
  const memDir = join(scopeRoot, 'memory');
  mkdirSync(join(memDir, PLUGIN), { recursive: true });
  writeFileSync(join(memDir, PLUGIN, 'shared.md'), doc('native-shared'));

  // Fixture plugin: enabled manifest + a flat substrate doc and a nested one.
  const pluginRoot = join(scopeRoot, 'plugins', PLUGIN);
  mkdirSync(join(pluginRoot, '.crouter-plugin'), { recursive: true });
  writeFileSync(
    join(pluginRoot, '.crouter-plugin', 'plugin.json'),
    JSON.stringify({ name: PLUGIN, version: '0.0.0' }),
  );
  const pluginMem = join(pluginRoot, 'memory');
  mkdirSync(join(pluginMem, 'area'), { recursive: true });
  writeFileSync(join(pluginMem, 'widget.md'), doc('plugin-widget'));
  writeFileSync(join(pluginMem, 'area', 'zone.md'), doc('plugin-zone'));
  writeFileSync(join(pluginMem, 'shared.md'), doc('plugin-shared'));
  // Plugin-root INDEX.md: a BARE plugin name must resolve this (mirrors the
  // native bare-dir-name -> INDEX.md contract for the plugin mount root).
  writeFileSync(join(pluginMem, 'INDEX.md'), doc('plugin-root-index'));

  // Explicitly enable the plugin in config (default is enabled, but be robust).
  writeFileSync(
    join(scopeRoot, 'config.json'),
    JSON.stringify({ plugins: { [PLUGIN]: { enabled: true } } }),
  );

  // Point the scope resolver at the fixture: project scope is found by walking
  // up from cwd, so chdir into the temp dir and clear the cached project root.
  process.chdir(projectDir);
  resetScopeCache();
});

after(() => {
  process.chdir(prevCwd);
  resetScopeCache();
  rmSync(projectDir, { recursive: true, force: true });
});

test('fully-qualified <plugin>/<leaf> resolves to the plugin substrate doc', () => {
  // Pre-fix this threw notFound (findMemoryMatches never searched pluginMemoryDir).
  const d = resolveMemoryDoc(`${PLUGIN}/widget`);
  assert.equal(d.name, `${PLUGIN}/widget`);
  assert.ok(d.path.endsWith(join('plugins', PLUGIN, 'memory', 'widget.md')));
});

test('fully-qualified multi-segment <plugin>/<a>/<b> resolves the nested doc', () => {
  // Pre-fix this also threw notFound.
  const d = resolveMemoryDoc(`${PLUGIN}/area/zone`);
  assert.equal(d.name, `${PLUGIN}/area/zone`);
  assert.ok(d.path.endsWith(join('plugins', PLUGIN, 'memory', 'area', 'zone.md')));
});

test('the bare leaf still resolves via last-segment fallback', () => {
  // This worked even pre-fix (leaf fallback scans listAllMemoryDocs, which DID
  // enumerate plugin docs) — the gap was the direct fully-qualified path only.
  const d = resolveMemoryDoc('widget');
  assert.equal(d.name, `${PLUGIN}/widget`);
});

test('bare plugin name resolves the plugin-root INDEX.md', () => {
  // Regression: findMemoryMatches skipped the plugin branch for a bare name
  // (`if (slash <= 0) continue`), so a bare plugin name never tried the
  // plugin-root INDEX.md and returned not_found — even though `<plugin>/INDEX`
  // resolved. The fix resolves the bare mount root to <plugin>/memory/INDEX.md.
  const d = resolveMemoryDoc(PLUGIN);
  assert.equal(d.name, PLUGIN);
  assert.ok(d.path.endsWith(join('plugins', PLUGIN, 'memory', 'INDEX.md')));
});

test('native doc wins over a plugin doc of the same canonical name', () => {
  // native-before-plugin precedence: findMemoryMatches checks scopeMemoryDir
  // before pluginMemoryDir, so the native shadow at memory/fixplug/shared.md
  // wins over the plugin's memory/shared.md.
  const d = resolveMemoryDoc(`${PLUGIN}/shared`);
  assert.equal(d.name, `${PLUGIN}/shared`);
  assert.ok(d.path.endsWith(join('memory', PLUGIN, 'shared.md')));
  assert.ok(!d.path.includes(join('plugins', PLUGIN)));
});
