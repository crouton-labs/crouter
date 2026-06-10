// ceiling.ts — INDEX.md dir-level entries and the subtree rung ceiling.
//
// A directory under a memory store may carry an `INDEX.md` with the SAME
// substrate frontmatter as any doc. That file makes the directory a first-class
// substrate entry: it renders as ONE entry at dir level (headed by the dir
// name, not `…/INDEX`), and its rung is a CEILING for everything in its subtree.
//
//   effective rung of a descendant = min(own rung, every ancestor INDEX's rung)
//
// So a dir's INDEX at `preview` lets its files surface at most at `preview`; an
// INDEX at `none` hides the whole subtree. This is the single, explicit
// mechanism for collapsing a directory in agent-facing surfaces (boot render +
// on-read) — there is no parallel auto-hiding heuristic. See design taste:
// `crtr memory read taste/document-substrate`.

import { rungRank, type Rung, type SubstrateDoc } from './schema.js';

/** The reserved basename (no extension) that marks a directory's index doc. */
export const INDEX_NAME = 'INDEX';

/** Does this path-derived name denote a directory INDEX (`taste/INDEX`, or a
 *  top-level `INDEX`)? */
export function isIndexName(name: string): boolean {
  return name === INDEX_NAME || name.endsWith('/' + INDEX_NAME);
}

/** The directory an INDEX doc represents: `taste/INDEX` → `taste`, `INDEX` → ''. */
export function indexDirOf(name: string): string {
  return name === INDEX_NAME ? '' : name.slice(0, name.length - INDEX_NAME.length - 1);
}

/** The name a doc renders under in agent-facing surfaces: an INDEX doc renders
 *  under its directory name (the dir entry); every other doc keeps its name. */
export function displayName(name: string): string {
  return isIndexName(name) ? indexDirOf(name) : name;
}

/** The two visibility surfaces an INDEX can cap. */
export type Surface = 'systemPromptVisibility' | 'fileReadVisibility';

/** Build the dir → governing-INDEX map. Precedence is first-occurrence-wins, so
 *  callers MUST pass docs precedence-ordered (project > user > builtin) — the
 *  highest-precedence INDEX governs a dir, mirroring the memory resolver. */
export function buildCeilingIndex(docs: SubstrateDoc[]): Map<string, SubstrateDoc> {
  const m = new Map<string, SubstrateDoc>();
  for (const d of docs) {
    if (!isIndexName(d.name)) continue;
    const dir = indexDirOf(d.name);
    if (!m.has(dir)) m.set(dir, d);
  }
  return m;
}

function minRung(a: Rung, b: Rung): Rung {
  return rungRank(a) <= rungRank(b) ? a : b;
}

/** Ancestor directory names of a doc, nearest-last: `a/b/c` → [`a/b`, `a`];
 *  `a` → []. An INDEX doc's OWN dir is included (a self-cap is a no-op), so a
 *  nested INDEX still inherits its parents' ceilings. */
function ancestorDirs(name: string): string[] {
  const parts = name.split('/');
  parts.pop(); // drop the leaf
  const out: string[] = [];
  for (let i = parts.length; i > 0; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}

/** A doc's effective rung on `surface` after applying every ancestor INDEX
 *  ceiling: min(own rung, each ancestor INDEX's rung). A `none` ancestor INDEX
 *  hides the whole subtree (min with none = none). */
export function effectiveRung(
  doc: SubstrateDoc,
  ceil: Map<string, SubstrateDoc>,
  surface: Surface,
): Rung {
  let rung = doc[surface];
  for (const dir of ancestorDirs(doc.name)) {
    const idx = ceil.get(dir);
    if (idx) rung = minRung(rung, idx[surface]);
  }
  return rung;
}
