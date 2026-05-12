import { join } from 'node:path';
import {
  MARKETPLACE_MANIFEST_DIR,
  MARKETPLACE_MANIFEST_FILE,
  PLUGIN_MANIFEST_DIR,
  PLUGIN_MANIFEST_FILE,
} from '../types.js';
import type { MarketplaceManifest, PluginManifest } from '../types.js';
import { readJsonIfExists } from './fs-utils.js';

export function pluginManifestPath(pluginRoot: string): string {
  return join(pluginRoot, PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE);
}

export function marketplaceManifestPath(mktRoot: string): string {
  return join(mktRoot, MARKETPLACE_MANIFEST_DIR, MARKETPLACE_MANIFEST_FILE);
}

export function readPluginManifest(pluginRoot: string): PluginManifest | null {
  return readJsonIfExists<PluginManifest>(pluginManifestPath(pluginRoot));
}

export function readMarketplaceManifest(mktRoot: string): MarketplaceManifest | null {
  return readJsonIfExists<MarketplaceManifest>(marketplaceManifestPath(mktRoot));
}
