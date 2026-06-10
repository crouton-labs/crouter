import { usage } from '../../core/errors.js';
import type { Scope } from '../../types.js';
import { resolveScopeArg, projectScopeRoot } from '../../core/scope.js';

// ---------------------------------------------------------------------------
// Resolve scope for scaffold
// ---------------------------------------------------------------------------

export function resolveWriteScope(scopeStr: string | undefined): Scope {
  if (scopeStr !== undefined) {
    const resolved = resolveScopeArg(scopeStr);
    if (resolved === 'all') {
      throw usage('scope must be user or project, not all');
    }
    return resolved;
  }
  return projectScopeRoot() !== null ? 'project' : 'user';
}

// ---------------------------------------------------------------------------
// Valid skill types (used by author sub-branch)
// ---------------------------------------------------------------------------

export const VALID_TYPES = ['playbook', 'primer', 'reference', 'runbook', 'freeform'] as const;

// ---------------------------------------------------------------------------
// Skill catalog rendering (used by the substrate boot renderer)
// ---------------------------------------------------------------------------

export type CatalogSource = { plugin: string; roots: string[] };

const CATALOG_T = 5;

export function renderCatalogSection(
  label: string,
  sources: CatalogSource[],
  descriptions: Map<string, string>,
  out: string[],
): void {
  if (sources.length === 0) return;
  const count = sources.reduce((n, s) => n + s.roots.length, 0);
  out.push('');
  out.push(`${label} (${count})`);

  const named = [...sources].sort((a, b) => a.plugin.localeCompare(b.plugin));
  if (named.length === 0) return;

  type Classified = {
    plugin: string;
    roots: string[];
    subcats: Map<string, string[]>;
    bare: string[];
  };
  const classified: Classified[] = named.map((s) => {
    const subcats = new Map<string, string[]>();
    const bare: string[] = [];
    for (const n of s.roots) {
      const slash = n.indexOf('/');
      if (slash === -1) {
        bare.push(n);
      } else {
        const sub = n.slice(0, slash);
        const rest = n.slice(slash + 1);
        const arr = subcats.get(sub);
        if (arr) arr.push(rest);
        else subcats.set(sub, [rest]);
      }
    }
    return { plugin: s.plugin, roots: s.roots, subcats, bare };
  });

  const descSuffix = (plugin: string): string => {
    const d = descriptions.get(plugin);
    if (!d) return '';
    return ` — ${d.length > 80 ? d.slice(0, 77) + '…' : d}`;
  };

  // inlineW aligns the count column for collapsed + inline-enumerated plugins
  // (nested plugins render their own header line, don't use this width)
  const inlineW = classified
    .filter((p) => {
      const direct = p.subcats.size + p.bare.length;
      return direct > CATALOG_T || p.subcats.size < 2;
    })
    .reduce((m, p) => Math.max(m, p.plugin.length + 1), 0);

  for (const p of classified) {
    // Bare native/builtin skills (no plugin namespace) carry sourceKey ''.
    // Render them as flat lines, never under a stray '/' header.
    if (p.plugin === '') {
      for (const r of [...p.roots].sort()) out.push(`  ${r}`);
      continue;
    }
    const direct = p.subcats.size + p.bare.length;
    if (direct > CATALOG_T) {
      out.push(`  ${(p.plugin + '/').padEnd(inlineW)}  ${p.roots.length} skills${descSuffix(p.plugin)}`);
      continue;
    }
    if (p.subcats.size >= 2) {
      out.push(`  ${p.plugin}/`);
      if (p.bare.length > 0) {
        out.push(`    ${[...p.bare].sort().join(', ')}`);
      }
      const subKeys = [...p.subcats.keys()].sort();
      const subW = subKeys
        .map((k) => `${k}/`)
        .reduce((m, l) => (l.length > m ? l.length : m), 0);
      for (const subKey of subKeys) {
        const children = p.subcats.get(subKey)!.sort();
        if (children.length > CATALOG_T) {
          out.push(`    ${(subKey + '/').padEnd(subW)}  ${children.length} skills`);
        } else {
          out.push(`    ${(subKey + '/').padEnd(subW)}  ${children.join(', ')}`);
        }
      }
    } else {
      out.push(`  ${(p.plugin + '/').padEnd(inlineW)}  ${[...p.roots].sort().join(', ')}`);
    }
  }
}
