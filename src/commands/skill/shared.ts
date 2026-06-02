import { stateBlock } from '../../core/help.js';
import { usage } from '../../core/errors.js';
import { SCOPE_SKILL_PLUGIN } from '../../types.js';
import type { Skill, Scope } from '../../types.js';
import {
  listSkillSiblings,
  listSkillChildren,
  listAllSkills,
  listAllPlugins,
} from '../../core/resolver.js';
import { resolveScopeArg, projectScopeRoot } from '../../core/scope.js';

// ---------------------------------------------------------------------------
// Neighbors section (ported from old impl)
// ---------------------------------------------------------------------------

export function formatNeighborQualifier(s: Skill): string {
  return s.plugin === SCOPE_SKILL_PLUGIN
    ? `${s.scope}/${s.name}`
    : `${s.plugin}/${s.name}`;
}

export function formatNeighborKeywords(s: Skill): string {
  const kw = s.frontmatter.keywords;
  if (!kw || kw.length === 0) return '';
  return ` — [${kw.join(', ')}]`;
}

export function buildNeighborsSection(skill: Skill): string | null {
  const siblings = listSkillSiblings(skill);
  const children = listSkillChildren(skill);
  if (siblings.length === 0 && children.length === 0) return null;

  const lines: string[] = [
    '## Neighbors',
    '*Auto-discovered from filesystem. Run `crtr skill read <name>` for full description + body.*',
    '',
  ];
  if (siblings.length > 0) {
    lines.push('**Siblings:**');
    for (const s of siblings) {
      lines.push(`- \`${formatNeighborQualifier(s)}\`${formatNeighborKeywords(s)}`);
    }
    if (children.length > 0) lines.push('');
  }
  if (children.length > 0) {
    lines.push('**Nested:**');
    for (const s of children) {
      lines.push(`- \`${formatNeighborQualifier(s)}\`${formatNeighborKeywords(s)}`);
    }
  }
  return lines.join('\n');
}

export function appendNeighbors(skill: Skill, body: string): string {
  const section = buildNeighborsSection(skill);
  if (section === null) return body;
  const sep = body.endsWith('\n') ? '\n' : '\n\n';
  return body + sep + `<neighbors>\n${section}\n</neighbors>\n`;
}

// ---------------------------------------------------------------------------
// Resolve scope for enable/disable/scaffold
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
// Loaded-skills catalog (dynamicState for `skill -h`)
// ---------------------------------------------------------------------------

// Sections: Project first (most relevant to cwd), then User (folding user-
// and builtin-scope plugins together). Within a section, sentinel-plugin
// skills list bare; named plugins render inline unless they have 2+ distinct
// top-level subcategories — those break into a subcategory tree. Forest-root
// skills only (nested children stay discoverable via `skill find list`).
type CatalogSource = { plugin: string; roots: string[] };

const CATALOG_T = 5;

/** The skill subtree's live state: the loaded-skills catalog as a self-named
 *  `<skills count="N">` element. The tag carries the label and the count is an
 *  attribute, so the body is the grouped tree alone — no "Loaded skills (N)"
 *  header to duplicate. Returns null (block omitted) when discovery fails or
 *  nothing is loaded. */
export function buildSkillCatalog(): string | null {
  let skills: Skill[];
  try {
    skills = listAllSkills().filter((s) => s.enabled);
  } catch {
    return null;
  }
  if (skills.length === 0) return null;

  const pluginDescriptions = new Map<string, string>();
  for (const p of listAllPlugins()) {
    if (p.manifest.description) pluginDescriptions.set(p.name, p.manifest.description);
  }

  const bySource = new Map<string, Skill[]>();
  for (const s of skills) {
    const key = `${s.scope}\t${s.plugin}`;
    const arr = bySource.get(key);
    if (arr) arr.push(s);
    else bySource.set(key, [s]);
  }

  const projectSources: CatalogSource[] = [];
  const userSources: CatalogSource[] = [];
  for (const [key, group] of bySource) {
    const [scope, plugin] = key.split('\t');
    const names = group.map((g) => g.name);
    const roots = names
      .filter((n) => !names.some((m) => m !== n && n.startsWith(m + '/')))
      .sort();
    if (roots.length === 0) continue;
    (scope === 'project' ? projectSources : userSources).push({ plugin, roots });
  }

  const body: string[] = [];
  renderCatalogSection('Project', projectSources, pluginDescriptions, body);
  renderCatalogSection('User', userSources, pluginDescriptions, body);
  // renderCatalogSection leads each section with a blank separator; drop the
  // leading one so the element body starts on its first real line.
  while (body.length > 0 && body[0] === '') body.shift();
  body.push('');
  body.push(
    "Groups shown as `name/  N skills` are collapsed. Read the group to get its menu before assuming a skill is or isn't there: `crtr skill read <group>` (or `crtr skill find list --plugin <group>`). Search across everything with `crtr skill find search <topic>`.",
  );
  return stateBlock('skills', { count: skills.length }, body.join('\n'));
}

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

  const sentinel = sources.filter((s) => s.plugin === SCOPE_SKILL_PLUGIN);
  const named = sources
    .filter((s) => s.plugin !== SCOPE_SKILL_PLUGIN)
    .sort((a, b) => a.plugin.localeCompare(b.plugin));

  for (const s of sentinel) {
    if (s.roots.length > CATALOG_T) {
      out.push(`  (scope skills)  ${s.roots.length} skills`);
    } else {
      for (const n of s.roots) out.push(`  ${n}`);
    }
  }
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
