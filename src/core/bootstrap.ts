import { homedir } from 'node:os';
import { join } from 'node:path';
import { findProjectScopeRoot, resetScopeCache, userScopeRoot } from './scope.js';
import { ensureDir, pathExists, removePath, nowIso } from './fs-utils.js';
import { readConfig, readState, updateConfig, updateState, ensureScopeInitialized } from './config.js';
import { clone } from './git.js';
import { readMarketplaceManifest } from './manifest.js';
import { CRTR_DIR_NAME } from '../types.js';

export const OFFICIAL_MARKETPLACE_NAME = 'crouter-official-marketplace';
export const OFFICIAL_MARKETPLACE_URL =
  'https://github.com/crouton-labs/crouter-official-marketplace.git';
export const OFFICIAL_MARKETPLACE_REF = 'main';

const SKIP_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
]);

function shouldSkipForArgv(argv: string[]): boolean {
  const sub = argv[2];
  if (sub === undefined) return true;
  return SKIP_SUBCOMMANDS.has(sub);
}

export function ensureOfficialMarketplace(argv: string[]): void {
  try {
    if (process.env.CRTR_NO_BOOTSTRAP === '1') return;
    if (shouldSkipForArgv(argv)) return;

    const state = readState('user');
    if (state.bootstrap_done === true) return;

    const cfg = readConfig('user');
    if (cfg.marketplaces[OFFICIAL_MARKETPLACE_NAME] !== undefined) {
      updateState('user', (s) => {
        s.bootstrap_done = true;
      });
      return;
    }

    const root = userScopeRoot();
    ensureScopeInitialized('user', root);

    const mktsDir = join(root, 'marketplaces');
    ensureDir(mktsDir);
    const dest = join(mktsDir, OFFICIAL_MARKETPLACE_NAME);

    if (pathExists(dest)) {
      removePath(dest);
    }

    clone(OFFICIAL_MARKETPLACE_URL, dest, { depth: 1, ref: OFFICIAL_MARKETPLACE_REF });

    const manifest = readMarketplaceManifest(dest);
    if (manifest === null) {
      removePath(dest);
      return;
    }

    updateConfig('user', (c) => {
      c.marketplaces[OFFICIAL_MARKETPLACE_NAME] = {
        url: OFFICIAL_MARKETPLACE_URL,
        ref: OFFICIAL_MARKETPLACE_REF,
        installed_at: nowIso(),
      };
    });

    updateState('user', (s) => {
      s.bootstrap_done = true;
    });
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: bootstrap error: ${msg}\n`);
    }
  }
}

export function ensureProjectScope(argv: string[]): void {
  try {
    if (process.env.CRTR_NO_AUTO_INIT === '1') return;
    if (shouldSkipForArgv(argv)) return;

    // Already inside a project scope (here or in an ancestor) — nothing to do.
    if (findProjectScopeRoot() !== null) return;

    const cwd = process.cwd();

    // Never auto-init at $HOME — that path is reserved for the user scope.
    if (cwd === homedir()) return;

    const projectRoot = join(cwd, CRTR_DIR_NAME);
    if (projectRoot === userScopeRoot()) return;

    ensureScopeInitialized('project', projectRoot);
    resetScopeCache();
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: project-init error: ${msg}\n`);
    }
  }
}
