// Self-update and content-check primitives extracted from commands/update.ts.
// Moved here to break the core→commands import inversion: auto-update.ts
// (core) previously imported from commands/update.ts (commands layer).

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { listAllPlugins, listAllMarketplaces } from './resolver.js';
import { pull, fetch, currentSha, remoteSha } from './git.js';
import { updateState } from './config.js';
import { nowIso } from './fs-utils.js';
import { general, network } from './errors.js';
import type { Scope } from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// src/core/self-update.ts → up to src/ → up to pkg root
const PKG_ROOT = join(__dirname, '..', '..');
const PACKAGE_JSON_PATH = join(PKG_ROOT, 'package.json');

export function currentVersion(): string {
  const raw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

export function selfUpdate(): void {
  const res = spawnSync('npm', ['i', '-g', '@crouton-kit/crouter@latest'], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw general('npm install failed');
  }
}

/** Check whether a newer crtr version is available on npm.
 *  Warns to stderr if network unavailable; returns {current, latest} or null if unreachable. */
export function selfCheck(): { current: string; latest: string } | null {
  const res = spawnSync('npm', ['view', '@crouton-kit/crouter', 'version'], { encoding: 'utf8' });
  if (res.status !== 0) {
    return null;
  }
  const latest = (res.stdout as string).trim();
  const current = currentVersion();
  return { current, latest };
}

/** Pull updates for all installed marketplaces and standalone plugins. */
export function contentUpdate(): void {
  const marketplaces = listAllMarketplaces();
  for (const mkt of marketplaces) {
    const res = pull(mkt.root);
    if (res.status !== 0) {
      throw network(`git pull failed for marketplace ${mkt.name}: ${res.stderr.trim()}`);
    }
    updateState(mkt.scope as Scope, (s) => {
      if (!s.marketplaces[mkt.name]) s.marketplaces[mkt.name] = {};
      s.marketplaces[mkt.name].last_updated = nowIso();
    });
  }

  const plugins = listAllPlugins();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    if (plugin.sourceMarketplace) continue;
    const res = pull(plugin.root);
    if (res.status !== 0) {
      throw network(`git pull failed for plugin ${plugin.name}: ${res.stderr.trim()}`);
    }
    updateState(plugin.scope, (s) => {
      if (!s.plugins[plugin.name]) s.plugins[plugin.name] = {};
      s.plugins[plugin.name].last_updated = nowIso();
    });
  }
}

export interface ContentUpdateEntry {
  name: string;
  kind: 'marketplace' | 'plugin';
  current: string | null;
  latest: string | null;
  up_to_date: boolean;
  unreachable: boolean;
}

/** Check whether any marketplace/plugin has updates available.
 *  Returns per-item status without applying anything. */
export function contentCheck(): ContentUpdateEntry[] {
  const results: ContentUpdateEntry[] = [];

  const marketplaces = listAllMarketplaces();
  for (const mkt of marketplaces) {
    const fetchRes = fetch(mkt.root, mkt.ref);
    if (fetchRes.status !== 0) {
      results.push({ name: mkt.name, kind: 'marketplace', current: null, latest: null, up_to_date: true, unreachable: true });
      continue;
    }
    const head = currentSha(mkt.root);
    const remote = remoteSha(mkt.root, mkt.ref);
    const up_to_date = head !== null && remote !== null ? head === remote : true;
    results.push({ name: mkt.name, kind: 'marketplace', current: head, latest: remote, up_to_date, unreachable: false });
  }

  const plugins = listAllPlugins();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    if (plugin.sourceMarketplace) continue;
    const ref = 'main';
    const fetchRes = fetch(plugin.root, ref);
    if (fetchRes.status !== 0) {
      results.push({ name: plugin.name, kind: 'plugin', current: null, latest: null, up_to_date: true, unreachable: true });
      continue;
    }
    const head = currentSha(plugin.root);
    const remote = remoteSha(plugin.root, ref);
    const up_to_date = head !== null && remote !== null ? head === remote : true;
    results.push({ name: plugin.name, kind: 'plugin', current: head, latest: remote, up_to_date, unreachable: false });
  }

  return results;
}
