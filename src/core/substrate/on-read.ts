// on-read.ts — the file-read-visibility render for the document substrate.
//
// When a `read` tool call returns, the canvas-doc-substrate pi extension calls
// renderOnReadDocs() to surface the substrate docs that should appear ALONGSIDE
// the file just read — each at its FILE-READ-VISIBILITY rung (NOT the
// system-prompt rung the boot render uses). Two independent triggers decide
// which docs surface (design §4/§6; plan-substrate.md track D1):
//
//   • POSITIONAL — walk the read file's ancestor dirs; any doc living in an
//     ancestor's `.crouter/memory/` surfaces (a doc surfaces when a file
//     beside/under its own scope dir is read). This mirrors nested-context's
//     `.claude/rules` ancestor walk, but keyed on `.crouter/memory/`.
//   • applies-to GLOB — any RESOLVED substrate doc (user/project/builtin scope)
//     whose `appliesTo` glob matches the read file path surfaces, regardless of
//     where the read file sits relative to the doc.
//
// Each candidate runs the substrate pipeline at its fileReadVisibility rung:
//   parse → gatePasses(doc, assembleNodeSubject(nodeId)) → render
//   (content → body, preview → previewLine, name → bare tag, none → skip).
// The result is the faithful envelope (verdict n1):
//   <auto-loaded-context file="…">
//   <doc kind="…" name="…" src="…" triggered-by="…">…body/preview…</doc>
//   </auto-loaded-context>
// Returns '' when nothing surfaces.
//
// Pure + defensive: reads disk + the resolver + canvas-db subject assembly; no
// writes, no side effects. Every disk/parse/glob step is wrapped so one bad doc
// can never throw the whole render (the extension is additionally inert on
// error). The CALLER owns the per-session `seen` realpath set (cleared on
// session_start) and threads it in, so a given doc is injected at most once per
// session across repeated reads.

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, matchesGlob, parse, relative, sep } from 'node:path';
import { CRTR_DIR_NAME, type Scope } from '../../types.js';
import { pathExists, readText, walkFiles } from '../fs-utils.js';
import { parseFrontmatterGeneric } from '../frontmatter.js';
import { listAllMemoryDocs } from '../memory-resolver.js';
import {
  assembleNodeSubject,
  buildCeilingIndex,
  displayName,
  effectiveRung,
  gatePasses,
  parseSubstrateDoc,
  parseSubstrateFrontmatter,
  previewLine,
  type NodeConfigSubject,
  type SubstrateDoc,
} from './index.js';
import { cachedSubstrateDocs } from './session-cache.js';

// Ancestor dirs we never look inside for a `.crouter/memory/` store (the read
// file may live under a build/dependency tree; `.crouter` is NOT junk here — it
// is the segment we explicitly join onto each surviving ancestor).
const JUNK_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', '.yalc']);

// ---------------------------------------------------------------------------
// Small path helpers (mirror the on-read precedent — nested-context /
// frontmatter-rules — so the injected envelope matches their faithful shape).
// ---------------------------------------------------------------------------

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Escape a value for an XML-ish attribute in the injected envelope. */
function attr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Nearest enclosing git repo root for a path (walk up looking for `.git`). */
function gitRootOf(p: string): string | null {
  let d = p;
  const root = parse(d).root;
  while (true) {
    if (pathExists(join(d, '.git'))) return d;
    if (d === root) return null;
    const parent = dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

/** Display a path relative to its nearest git repo root, else absolute. */
function disp(p: string): string {
  const root = gitRootOf(p);
  if (!root) return p;
  const rel = relative(root, p);
  return rel === '' ? '.' : rel;
}

function isJunkAncestor(dir: string): boolean {
  return dir.split(sep).some((seg) => JUNK_DIRS.has(seg));
}

// ---------------------------------------------------------------------------
// Candidate collection.
// ---------------------------------------------------------------------------

interface Candidate {
  doc: SubstrateDoc;
  /** realpath of the doc file — the dedup key (within-call ∪ caller's session). */
  realpath: string;
  /** Sort key: positional docs carry their ancestor depth (0 = nearest); the
   *  applies-to set carries -1 so it sorts after all positional docs. */
  order: number;
}

/** Load one positionally-discovered `.crouter/memory/` file into a SubstrateDoc,
 *  or null when it is not a substrate doc / unreadable. `scope` is cosmetic here
 *  (gate eval keys off the NODE subject, render off name/body/rung). */
function loadPositionalDoc(file: string, memDir: string, scope: Scope): SubstrateDoc | null {
  try {
    const name = relative(memDir, file)
      .replace(/\.md$/i, '')
      .split(sep)
      .join('/');
    if (name === '') return null;
    const { data, body } = parseFrontmatterGeneric(readText(file));
    const schema = parseSubstrateFrontmatter(data);
    if (schema === null) return null;
    return { ...schema, name, scope, path: file, body };
  } catch {
    return null;
  }
}

function safeWalkMd(dir: string): string[] {
  try {
    return walkFiles(dir, (n) => n.toLowerCase().endsWith('.md'));
  } catch {
    return [];
  }
}

/** POSITIONAL trigger: every substrate doc in an ancestor dir's
 *  `.crouter/memory/`, walking from the read file up to $HOME (or the
 *  filesystem root for a read outside $HOME), skipping junk ancestors. */
function positionalCandidates(absReadFile: string): Candidate[] {
  const out: Candidate[] = [];
  const seenDocPaths = new Set<string>();
  const home = homedir();
  const fsRoot = parse(absReadFile).root;

  let dir = dirname(absReadFile);
  let depth = 0;
  while (true) {
    if (!isJunkAncestor(dir)) {
      const memDir = join(dir, CRTR_DIR_NAME, 'memory');
      if (pathExists(memDir)) {
        const scope: Scope = dir === home ? 'user' : 'project';
        for (const file of safeWalkMd(memDir)) {
          const real = realpathOrSelf(file);
          if (seenDocPaths.has(real)) continue;
          seenDocPaths.add(real);
          const doc = loadPositionalDoc(file, memDir, scope);
          if (doc) out.push({ doc, realpath: real, order: depth });
        }
      }
    }
    if (dir === home || dir === fsRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth += 1;
  }
  return out;
}

/** The user/project scope root that owns a resolved doc: `<root>/.crouter/memory/…`
 *  → `<root>`. Builtin docs (no `.crouter` segment) return null. Used to test an
 *  `appliesTo` glob against a read path RELATIVE to the doc's own project root. */
function owningRootOf(doc: SubstrateDoc): string | null {
  const parts = doc.path.split(sep);
  const idx = parts.lastIndexOf(CRTR_DIR_NAME);
  if (idx <= 0) return null;
  return parts.slice(0, idx).join(sep) || sep;
}

function globMatches(glob: string, absReadFile: string, owningRoot: string | null): boolean {
  const targets = [absReadFile, basename(absReadFile)];
  if (owningRoot) targets.push(relative(owningRoot, absReadFile));
  return targets.some((t) => {
    try {
      return matchesGlob(t, glob);
    } catch {
      return false; // an invalid glob never matches
    }
  });
}

/** applies-to GLOB trigger: every RESOLVED substrate doc whose `appliesTo` glob
 *  matches the read path. `taken` carries the realpaths already claimed by the
 *  positional pass, so a doc found both ways is not double-counted.
 *  Uses the per-session cache so the corpus is not re-walked+re-parsed on every
 *  read tool call (O(reads × corpus) without the cache). */
function appliesToCandidates(absReadFile: string, taken: Set<string>): Candidate[] {
  let docs: SubstrateDoc[];
  try {
    docs = cachedSubstrateDocs(listAllMemoryDocs, parseSubstrateDoc);
  } catch {
    return [];
  }
  const out: Candidate[] = [];
  for (const doc of docs) {
    const globs = doc.appliesTo;
    if (!globs || globs.length === 0) continue;
    const real = realpathOrSelf(doc.path);
    if (taken.has(real)) continue;
    if (!globs.some((g) => globMatches(g, absReadFile, owningRootOf(doc)))) continue;
    taken.add(real);
    out.push({ doc, realpath: real, order: -1 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Per-doc envelope render.
// ---------------------------------------------------------------------------

/** One doc as a `<doc …>` element at its fileReadVisibility rung, or null when
 *  that rung is `none`. `content` → full body; `preview` → the routing line;
 *  `name` → a bare self-closed tag (the `name=` attribute IS the surface). */
function renderDocEnvelope(doc: SubstrateDoc, absReadFile: string): string | null {
  const rung = doc.fileReadVisibility;
  if (rung === 'none') return null;
  let body = '';
  if (rung === 'content') body = doc.body.trim();
  else if (rung === 'preview') body = previewLine(doc);
  // 'name' → body stays '' (the tag's name attribute is the whole surface).
  const attrs =
    `kind="${attr(doc.kind)}" name="${attr(doc.name)}" ` +
    `src="${attr(disp(doc.path))}" triggered-by="${attr(disp(absReadFile))}"`;
  return body === '' ? `<doc ${attrs} />` : `<doc ${attrs}>\n${body}\n</doc>`;
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

/**
 * Render the substrate docs that should surface alongside a just-read file.
 *
 * @param nodeId        the canvas node whose subject gates the docs.
 * @param readFilePath  the path the `read` tool returned (absolute or not — it
 *                      is resolved to a realpath internally).
 * @param seen          the CALLER-owned, per-session set of already-injected
 *                      doc realpaths. Docs already present are skipped; newly
 *                      injected docs are added. Pass the same set across reads
 *                      within a session (clear it on session_start) to get the
 *                      once-per-session dedup; omit it for a standalone render.
 * @returns the `<auto-loaded-context>` envelope, or '' when nothing surfaces.
 */
export function renderOnReadDocs(
  nodeId: string,
  readFilePath: string,
  seen: Set<string> = new Set(),
): string {
  let subject: NodeConfigSubject | null;
  try {
    subject = assembleNodeSubject(nodeId);
  } catch {
    return '';
  }
  if (subject === null) return '';

  const absReadFile = realpathOrSelf(readFilePath);

  let candidates: Candidate[];
  try {
    const positional = positionalCandidates(absReadFile);
    const taken = new Set<string>(positional.map((c) => c.realpath));
    const byGlob = appliesToCandidates(absReadFile, taken);
    candidates = [...positional, ...byGlob];
  } catch {
    return '';
  }

  // Outermost-first: the nearest/most-specific doc reads last — closest to the
  // file content that follows it (the applies-to set, order -1, trails).
  candidates.sort((a, b) => b.order - a.order);

  // INDEX ceiling: build the dir → governing-INDEX map over the whole resolved
  // corpus PLUS the candidate docs, so a dir's INDEX caps (or `none`-hides) its
  // subtree on-read exactly as it does at boot. The candidate's own
  // fileReadVisibility and name are overridden by the effective rung / dir entry.
  let ceil: Map<string, SubstrateDoc>;
  try {
    const resolved = cachedSubstrateDocs(listAllMemoryDocs, parseSubstrateDoc);
    ceil = buildCeilingIndex([...resolved, ...candidates.map((c) => c.doc)]);
  } catch {
    ceil = buildCeilingIndex(candidates.map((c) => c.doc));
  }

  const rendered: string[] = [];
  for (const c of candidates) {
    // Never re-surface the doc the agent is literally reading.
    if (c.realpath === absReadFile) continue;
    // Once-per-session dedup (caller-owned set).
    if (seen.has(c.realpath)) continue;
    let block: string | null;
    try {
      if (!gatePasses(c.doc, subject)) continue; // gated out for this node
      const rung = effectiveRung(c.doc, ceil, 'fileReadVisibility');
      const doc: SubstrateDoc =
        rung === c.doc.fileReadVisibility && displayName(c.doc.name) === c.doc.name
          ? c.doc
          : { ...c.doc, fileReadVisibility: rung, name: displayName(c.doc.name) };
      block = renderDocEnvelope(doc, absReadFile);
    } catch {
      continue; // a single bad doc never breaks the read
    }
    if (block === null) continue; // fileReadVisibility 'none' — not a read surface
    seen.add(c.realpath); // mark injected only once it actually surfaces
    rendered.push(block);
  }

  if (rendered.length === 0) return '';
  return `<auto-loaded-context file="${attr(disp(absReadFile))}">\n${rendered.join('\n')}\n</auto-loaded-context>`;
}
