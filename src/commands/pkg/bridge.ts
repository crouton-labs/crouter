// `crtr pkg bridge` — generate crouter substrate docs from a Claude skills root
// and file-level reconcile the bridge plugin (design §2). The mapping lives in
// core/bridge-map.ts (one testable source of truth); the extension shells to
// this command rather than duplicating the transform.

import { join, basename, dirname, isAbsolute } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { defineBranch, defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import { userScopeRoot } from '../../core/scope.js';
import {
  ensureDir,
  writeJson,
  writeText,
  readText,
  removePath,
  walkFiles,
} from '../../core/fs-utils.js';
import { parseFrontmatter, parseFrontmatterGeneric } from '../../core/frontmatter.js';
import { buildBridgeDoc } from '../../core/bridge-map.js';
import { PLUGIN_MANIFEST_DIR, PLUGIN_MANIFEST_FILE } from '../../types.js';

/** Enumerate `<source>/**\/SKILL.md`, stopping recursion at the first SKILL.md
 *  on any branch — a dir that holds SKILL.md is a skill; its subdirs are assets,
 *  not nested skills. */
function enumerateSkillFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    const hasSkill = entries.some((e) => e.isFile() && e.name === 'SKILL.md');
    if (hasSkill) {
      out.push(join(dir, 'SKILL.md'));
      continue; // stop descent — deeper dirs are assets
    }
    for (const e of entries) if (e.isDirectory()) stack.push(join(dir, e.name));
  }
  return out;
}

const bridgeSync = defineLeaf({
  name: 'sync',
  description: 'generate substrate docs from a Claude skills root',
  whenToUse: 'mirroring a Claude Code skills directory into a crtr bridge plugin: maps each SKILL.md to a substrate memory doc and file-level reconciles the plugin (regenerate, prune stale, preserve hand-authored leaves + INDEX)',
  help: {
    name: 'pkg bridge sync',
    summary: 'mirror a Claude skills root into a crtr bridge plugin (idempotent reconcile)',
    guide: 'Each <source>/skills/<skillname>/SKILL.md becomes ~/.crouter/plugins/<name>/memory/<skillname>.md, stamped generator:claude-bridge. Stamped leaves whose source skill is gone are pruned; hand-authored leaves and any INDEX.md are never touched.',
    params: [
      { kind: 'flag', name: 'source', type: 'path', required: true, constraint: 'Absolute path to a Claude skills root (a dir whose <skillname>/SKILL.md leaves are bridged; recursion stops at the first SKILL.md).' },
      { kind: 'flag', name: 'name', type: 'string', required: true, constraint: 'Bridge plugin name. Dest plugin dir is ~/.crouter/plugins/<name>/.' },
      { kind: 'flag', name: 'source-desc', type: 'string', required: false, constraint: 'Optional plugin description written into the generated plugin.json.' },
    ],
    output: [
      { name: 'plugin', type: 'string', required: true, constraint: 'Bridge plugin name.' },
      { name: 'path', type: 'string', required: true, constraint: 'Absolute path to the bridge plugin directory.' },
      { name: 'written', type: 'number', required: true, constraint: 'Count of substrate leaves generated from source SKILL.md files.' },
      { name: 'pruned', type: 'number', required: true, constraint: 'Count of stale generator:claude-bridge leaves deleted (source skill gone).' },
      { name: 'preserved', type: 'number', required: true, constraint: 'Count of untouched protected leaves (INDEX.md or unstamped hand-authored docs).' },
    ],
    outputKind: 'object',
    effects: ['Writes ~/.crouter/plugins/<name>/.crouter-plugin/plugin.json and memory/*.md. Deletes stale generator:claude-bridge leaves. Never writes or deletes INDEX.md or unstamped docs.'],
  },
  run: async (input) => {
    const source = input['source'] as string;
    const name = input['name'] as string;
    const sourceDesc = input['sourceDesc'] as string | undefined;

    if (!isAbsolute(source)) {
      throw usage(`--source must be an absolute path: ${source}`);
    }
    if (!existsSync(source)) {
      throw usage(`--source does not exist: ${source}`);
    }

    const destRoot = join(userScopeRoot(), 'plugins', name);
    const memoryDir = join(destRoot, 'memory');

    // 1. Ensure the bridge plugin manifest.
    const manifestDir = join(destRoot, PLUGIN_MANIFEST_DIR);
    ensureDir(manifestDir);
    const manifest: Record<string, unknown> = {
      name,
      version: '0.0.0',
      ...(sourceDesc !== undefined ? { description: sourceDesc } : {}),
      source,
      generator: 'claude-bridge',
    };
    writeJson(join(manifestDir, PLUGIN_MANIFEST_FILE), manifest);

    // 2 + 3. Regenerate one stamped leaf per source skill.
    ensureDir(memoryDir);
    const writtenPaths = new Set<string>();
    for (const file of enumerateSkillFiles(source)) {
      const skillName = basename(dirname(file));
      const parsed = parseFrontmatter(readText(file));
      const doc = buildBridgeDoc({
        name: parsed.data?.name ?? skillName,
        description: parsed.data?.description ?? '',
        body: parsed.body,
      });
      const dest = join(memoryDir, `${skillName}.md`);
      writeText(dest, doc);
      writtenPaths.add(dest);
    }
    const written = writtenPaths.size;

    // 4. Reconcile: prune stale stamped leaves; never touch INDEX.md or
    //    unstamped (hand-authored) leaves.
    let pruned = 0;
    let preserved = 0;
    for (const f of walkFiles(memoryDir, (n) => n.endsWith('.md'))) {
      if (writtenPaths.has(f)) continue; // just regenerated → counted in `written`
      if (basename(f) === 'INDEX.md') {
        preserved++;
        continue;
      }
      const generator = parseFrontmatterGeneric(readText(f)).data?.['generator'];
      if (generator === 'claude-bridge') {
        removePath(f);
        pruned++;
      } else {
        preserved++;
      }
    }

    return { plugin: name, path: destRoot, written, pruned, preserved };
  },
});

export const bridgeBranch = defineBranch({
  name: 'bridge',
  description: 'mirror Claude skills into crtr bridge plugins',
  whenToUse: 'generating a crtr bridge plugin from a Claude Code skills root — the substrate-doc mapping and file-level reconcile invoked by the pi bridge extension',
  help: {
    name: 'pkg bridge',
    summary: 'mirror Claude skills roots into crtr bridge plugins',
    model: 'A bridge plugin is a generator:claude-bridge plugin whose memory/ docs are generated from a Claude skills root. Hand-authored leaves and INDEX ceilings are preserved across syncs.',
  },
  children: [bridgeSync],
});
