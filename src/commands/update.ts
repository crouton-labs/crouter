import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import type { Scope } from '../types.js';
import { out, err, warn, handleError } from '../core/output.js';
import { projectScopeRoot } from '../core/scope.js';
import { updateState } from '../core/config.js';
import { listAllPlugins, listAllMarketplaces } from '../core/resolver.js';
import { pull, fetch, currentSha, remoteSha } from '../core/git.js';
import { nowIso } from '../core/fs-utils.js';
import { network, general } from '../core/errors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PKG_ROOT = join(__dirname, '..', '..', '..');
const PACKAGE_JSON_PATH = join(PKG_ROOT, 'package.json');

function currentVersion(): string {
  const raw = readFileSync(PACKAGE_JSON_PATH, 'utf8');
  const parsed = JSON.parse(raw) as { version: string };
  return parsed.version;
}

function selfUpdate(): void {
  const res = spawnSync('npm', ['i', '-g', '@crouton-kit/crtr@latest'], { stdio: 'inherit' });
  if (res.status !== 0) {
    throw general('npm install failed');
  }
}

function selfCheck(): void {
  const res = spawnSync('npm', ['view', '@crouton-kit/crtr', 'version'], { encoding: 'utf8' });
  if (res.status !== 0) {
    warn('could not check for crtr updates (network unavailable)');
    return;
  }
  const latest = (res.stdout as string).trim();
  const current = currentVersion();
  if (latest !== current) {
    err(`crtr: v${latest} available (current ${current}) — run \`crtr update --self\``);
  }
}

function contentUpdate(): void {
  const marketplaces = listAllMarketplaces();
  for (const mkt of marketplaces) {
    const res = pull(mkt.root);
    if (res.status !== 0) {
      throw network(`git pull failed for marketplace ${mkt.name}: ${res.stderr.trim()}`);
    }
    updateState(mkt.scope, (s) => {
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

function contentCheck(): void {
  const marketplaces = listAllMarketplaces();
  for (const mkt of marketplaces) {
    const fetchRes = fetch(mkt.root, mkt.ref);
    if (fetchRes.status !== 0) {
      warn(`could not fetch ${mkt.name} (network unavailable)`);
      continue;
    }
    const head = currentSha(mkt.root);
    const remote = remoteSha(mkt.root, mkt.ref);
    if (head !== null && remote !== null && head !== remote) {
      err(`crtr: marketplace ${mkt.name} has updates available — run \`crtr update --content\``);
    }
  }

  const plugins = listAllPlugins();
  for (const plugin of plugins) {
    if (!plugin.enabled) continue;
    if (plugin.sourceMarketplace) continue;
    const ref = 'main';
    const fetchRes = fetch(plugin.root, ref);
    if (fetchRes.status !== 0) {
      warn(`could not fetch ${plugin.name} (network unavailable)`);
      continue;
    }
    const head = currentSha(plugin.root);
    const remote = remoteSha(plugin.root, ref);
    if (head !== null && remote !== null && head !== remote) {
      err(`crtr: plugin ${plugin.name} has updates available — run \`crtr plugin update ${plugin.name}\``);
    }
  }
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('update crtr itself and/or installed plugins and marketplaces')
    .option('--self', 'update crtr binary via npm')
    .option('--content', 'pull updates for all installed plugins and marketplaces')
    .option('--check', 'check for updates without applying them')
    .action(async (opts: { self?: boolean; content?: boolean; check?: boolean }) => {
      try {
        const runSelf = opts.self === true;
        const runContent = opts.content === true;
        const runBoth = !runSelf && !runContent;

        if (opts.check) {
          if (runSelf || runBoth) selfCheck();
          if (runContent || runBoth) contentCheck();
          return;
        }

        if (runSelf || runBoth) {
          selfUpdate();
          const scopes: Scope[] = ['user'];
          if (projectScopeRoot()) scopes.unshift('project');
          for (const scope of scopes) {
            updateState(scope, (s) => {
              s.last_self_check = nowIso();
            });
          }
        }

        if (runContent || runBoth) {
          contentUpdate();
        }
      } catch (e) {
        handleError(e);
      }
    });
}
