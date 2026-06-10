// render.ts — the pure boot-render functions for the document substrate.
//
// Two boot targets, three functions:
//   • the SYSTEM-PROMPT half — `## Skills` (renderSkillsSection) + `## Preferences`
//     (renderPreferencesSection) — strings the D2 `before_agent_start` extension
//     splices into the system prompt (built by a sibling AFTER this module);
//   • the `<crtr-context>` half — `## References` (renderReferencesBlock) — the
//     string wired into bearings.ts's session_start message.
//
// Every doc flows through the same pipeline (design §4/§6/§9):
//   MemoryDoc → parseSubstrateDoc → (null-filter non-substrate) →
//   gatePasses(doc, assembleNodeSubject(nodeId)) → render at the doc's
//   `system-prompt-visibility` rung.
//
// Pure + defensive: reads the resolver, canvas-db (subject assembly), and the
// node-local memory dir; performs no writes and no side effects. A single
// malformed doc must never throw the whole render — parseSubstrateDoc returns
// null for a non-substrate doc and is `.filter()`ed out; per-file loads are
// wrapped so one bad file is skipped, not fatal.

import { relative, sep } from 'node:path';
import { type Scope } from '../../types.js';
import { listAllPlugins } from '../resolver.js';
import { renderCatalogSection } from '../../commands/skill/shared.js';
import { listAllMemoryDocs } from '../memory-resolver.js';
import { parseFrontmatterGeneric } from '../frontmatter.js';
import { pathExists, readText, walkFiles } from '../fs-utils.js';
import { memoryDir } from '../runtime/memory.js';
import {
  applyCeilings,
  assembleNodeSubject,
  gatePasses,
  isIndexName,
  parseSubstrateDoc,
  parseSubstrateFrontmatter,
  previewLine,
  type DocKind,
  type NodeConfigSubject,
  type SubstrateDoc,
} from './index.js';
import {
  cachedAllPlugins,
  cachedNodeSubject,
  cachedSubstrateDocs,
} from './session-cache.js';

// ---------------------------------------------------------------------------
// The shared per-doc pipeline.
// ---------------------------------------------------------------------------

/** The resolver-provided substrate docs of one `kind`, eligible at boot for
 *  `subject`: parsed (non-substrate docs null-filtered), gate-passed, and at a
 *  system-prompt rung above `none`. Resolver = user + project + builtin scopes
 *  (precedence-ordered); node-local is loaded separately (see nodeLocalDocs).
 *  Uses the per-session cache so the full corpus is scanned+parsed at most once
 *  per session across the three boot-render calls.
 *
 *  Ceilings are applied over the WHOLE corpus (cross-kind) BEFORE the kind
 *  filter: an INDEX.md renders as its dir entry (`taste`, not `taste/INDEX`) at
 *  its own rung, and every descendant's rung is capped by its ancestor INDEX
 *  rungs — a `none` dir hides its whole subtree. */
function resolverDocs(subject: NodeConfigSubject, kind: DocKind): SubstrateDoc[] {
  let docs: SubstrateDoc[];
  try {
    docs = cachedSubstrateDocs(listAllMemoryDocs, parseSubstrateDoc);
  } catch {
    return [];
  }
  return applyCeilings(docs, 'systemPromptVisibility')
    .filter((d) => d.kind === kind)
    .filter((d) => gatePasses(d, subject))
    .filter((d) => d.systemPromptVisibility !== 'none')
    // Re-sort after the INDEX rename (taste/INDEX → taste) so a dir entry sorts
    // immediately BEFORE its children, keeping scope precedence (project > user
    // > builtin) intact.
    .sort((a, b) => scopeRank(a.scope) - scopeRank(b.scope) || a.name.localeCompare(b.name));
}

function scopeRank(scope: Scope): number {
  return scope === 'project' ? 0 : scope === 'user' ? 1 : 2;
}

/** The node-local memory docs eligible at boot. Node-local memory lives in the
 *  canvas home (`nodes/<id>/context/memory/`) and is OUTSIDE the scope resolver,
 *  so it is loaded directly here, its raw frontmatter run through
 *  parseSubstrateFrontmatter (mirroring the resolver pipeline), then gate-passed.
 *  Non-substrate files (those with no `kind`) parse to null and drop out.
 *  Returned across ALL kinds — node-local is the catch-all this-node store and
 *  rides into the references block.
 *
 *  IMPORTANT: node-local docs are NOT filtered by `systemPromptVisibility` rung.
 *  A migrated node-local reference defaults to rung `none`, which would make it
 *  invisible — but the design explicitly says "node-local rides into references"
 *  without qualification.  Suppressing them by rung contradicts that contract.
 *  A `none`-rung node-local doc renders as a `### <name>` title stub (the `name`
 *  rung fallback in renderSubSection), which is the minimum meaningful surface.
 *  Only gate evaluation removes a node-local doc from the block. */
function nodeLocalDocs(nodeId: string, subject: NodeConfigSubject): SubstrateDoc[] {
  const dir = memoryDir(nodeId);
  if (!pathExists(dir)) return [];
  const out: SubstrateDoc[] = [];
  for (const file of walkFiles(dir, (n) => n.endsWith('.md'))) {
    const name = relative(dir, file).replace(/\.md$/i, '').split(sep).join('/');
    if (!name) continue;
    try {
      const { data, body } = parseFrontmatterGeneric(readText(file));
      const schema = parseSubstrateFrontmatter(data);
      if (schema === null) continue;
      // node-local is NOT a resolver scope; `scope` is a placeholder never read
      // by gate eval (keyed off the NODE subject, not the doc) nor by the
      // renderers (keyed off name / body / rung).
      out.push({ ...schema, name, scope: 'user' as Scope, path: file, body });
    } catch {
      // A single malformed file is skipped, never fatal to the render.
      continue;
    }
  }
  // Gate-filter only: rung is NOT filtered (see comment above).
  return out.filter((d) => gatePasses(d, subject));
}

// ---------------------------------------------------------------------------
// Sub-section render (preview / content / name) — the per-doc `###` block used
// by every kind EXCEPT name-rung skills (those fold into the compact catalog).
// ---------------------------------------------------------------------------

/** One doc rendered as its own `### <name>` sub-section, at its system-prompt
 *  rung: `preview` → the generated routing line; `content` → the full body;
 *  `name` → the title alone (`none` is filtered upstream, never reaches here). */
function renderSubSection(d: SubstrateDoc): string {
  const header = `### ${d.name}`;
  switch (d.systemPromptVisibility) {
    case 'preview':
      return `${header}\n${previewLine(d)}`;
    case 'content': {
      const body = d.body.trim();
      return body === '' ? header : `${header}\n${body}`;
    }
    default: // 'name'
      return header;
  }
}

// ---------------------------------------------------------------------------
// 1. Skills section — `## Skills` (system prompt).
// ---------------------------------------------------------------------------

/** The compact, group-collapsed `name`-rung catalog of substrate `skill` docs.
 *  Every leaf is a migrated/generated substrate doc (native, builtin, or a
 *  plugin's `<pluginName>/` subtree) — there is no second, resolver-provided
 *  skill corpus. Each doc self-groups by its top-dir segment: a name with a
 *  slash sources to its top segment (the plugin name); a bare name sources to
 *  '' (a scope-local native/builtin skill). A plugin whose INDEX is elevated to
 *  preview/content renders as its own `### <plugin>` subsection, so its catalog
 *  group is dropped here (via `elevatedSources`) to avoid a double render.
 *  Reuses skill/shared.ts's renderCatalogSection group-collapse. Returns ''
 *  when nothing is in the catalog. */
function renderSkillCatalog(
  nameRungSkillDocs: SubstrateDoc[],
  elevatedSources: ReadonlySet<string>,
): string {
  type Source = { scope: Scope; plugin: string; roots: string[] };
  const bySource = new Map<string, Source>();
  for (const d of nameRungSkillDocs) {
    // INDEX docs are structural ceilings (already renamed to their dir entry by
    // applyCeilings), never catalog leaves — drop defensively.
    if (isIndexName(d.name)) continue;
    const slash = d.name.indexOf('/');
    const plugin = slash === -1 ? '' : d.name.slice(0, slash);
    const leaf = slash === -1 ? d.name : d.name.slice(slash + 1);
    // A plugin represented by its own elevated ### subsection is dropped from the
    // catalog so it is not rendered twice.
    if (plugin !== '' && elevatedSources.has(plugin)) continue;
    const key = `${d.scope}\t${plugin}`;
    const src = bySource.get(key);
    if (src) src.roots.push(leaf);
    else bySource.set(key, { scope: d.scope, plugin, roots: [leaf] });
  }
  if (bySource.size === 0) return '';

  const projectSources: { plugin: string; roots: string[] }[] = [];
  const userSources: { plugin: string; roots: string[] }[] = [];
  for (const { scope, plugin, roots } of bySource.values()) {
    // Drop nested children so each source contributes only its top-level skills.
    const top = roots
      .filter((n) => !roots.some((m) => m !== n && n.startsWith(m + '/')))
      .sort();
    if (top.length === 0) continue;
    (scope === 'project' ? projectSources : userSources).push({ plugin, roots: top });
  }

  const descriptions = new Map<string, string>();
  try {
    for (const p of cachedAllPlugins(listAllPlugins)) {
      if (p.manifest.description) descriptions.set(p.name, p.manifest.description);
    }
  } catch {
    // descriptions are an optional suffix; render without them on failure.
  }

  const body: string[] = [];
  renderCatalogSection('Project', projectSources, descriptions, body);
  renderCatalogSection('User', userSources, descriptions, body);
  // renderCatalogSection leads each section with a blank separator; drop it so
  // the catalog starts on its first real line.
  while (body.length > 0 && body[0] === '') body.shift();
  return body.length === 0 ? '' : body.join('\n');
}

/** The `## Skills` system-prompt section: every eligible `kind: skill` doc,
 *  rendered at its `system-prompt-visibility`. `name`-rung skills collapse into
 *  one compact, plugin-grouped catalog; `preview`/`content`-rung skills each get
 *  a `###` sub-section. Returns '' when nothing is eligible. */
export function renderSkillsSection(nodeId: string): string {
  const subject = cachedNodeSubject(nodeId, assembleNodeSubject);
  if (subject === null) return '';
  const skills = resolverDocs(subject, 'skill');

  const elevated = skills.filter((d) => d.systemPromptVisibility !== 'name');
  // A plugin whose INDEX is elevated surfaces as its own `### <plugin>`
  // subsection (its display name is the plugin/dir name after ceiling rename);
  // the catalog drops that plugin's group so it is not rendered twice.
  const elevatedSources = new Set(elevated.map((d) => d.name));
  const catalog = renderSkillCatalog(
    skills.filter((d) => d.systemPromptVisibility === 'name'),
    elevatedSources,
  );
  const elevatedBlocks = elevated.map(renderSubSection);

  const blocks = [catalog, ...elevatedBlocks].filter((s) => s !== '');
  if (blocks.length === 0) return '';
  return `## Skills\n\n${blocks.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// 2. Preferences section — `## Preferences` (system prompt).
// ---------------------------------------------------------------------------

/** The `## Preferences` system-prompt section: every eligible `kind: preference`
 *  doc as its own `###` sub-section, at its `system-prompt-visibility` (the
 *  preference default rung is `preview` → the routing line). Returns '' when
 *  nothing is eligible. */
export function renderPreferencesSection(nodeId: string): string {
  const subject = cachedNodeSubject(nodeId, assembleNodeSubject);
  if (subject === null) return '';
  const subs = resolverDocs(subject, 'preference')
    .map(renderSubSection)
    .filter((s) => s !== '');
  if (subs.length === 0) return '';
  return `## Preferences\n\n${subs.join('\n\n')}`;
}

// ---------------------------------------------------------------------------
// 3. References block — `## References` (inside the <crtr-context> message).
// ---------------------------------------------------------------------------

/** The `## References` block embedded INSIDE the `<crtr-context>` session_start
 *  message (the bearings caller pushes the returned string into the block, or
 *  drops it when ''). Holds every eligible `kind: reference` resolver doc at its
 *  `system-prompt-visibility` (reference boot default is `none`, so only
 *  author-promoted references show) PLUS the node-local memory docs (any kind),
 *  each a `###` sub-section. Returns '' when nothing is eligible.
 *
 *  DEFENSIVE: each doc is rendered in its own try/catch so a single malformed
 *  doc drops only itself (with a loud stderr warning naming the offending path),
 *  never silently swallowing the entire block (identity included).  Per the CTO
 *  ruling, strictness lives at the COLLECTION layer (memory-resolver.ts); this
 *  catch is error ISOLATION at the render layer, not a fallback parser. */
export function renderReferencesBlock(nodeId: string): string {
  const subject = cachedNodeSubject(nodeId, assembleNodeSubject);
  if (subject === null) return '';
  const docs = [...resolverDocs(subject, 'reference'), ...nodeLocalDocs(nodeId, subject)];
  const subs: string[] = [];
  for (const d of docs) {
    try {
      const rendered = renderSubSection(d);
      if (rendered !== '') subs.push(rendered);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
      process.stderr.write(`[crtr substrate] renderReferencesBlock: skipping doc "${d.path}": ${msg}\n`);
    }
  }
  if (subs.length === 0) return '';
  return `## References\n\n${subs.join('\n\n')}`;
}
