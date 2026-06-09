// session-cache.ts — a per-session parse cache for the document substrate.
//
// Both substrate hooks (boot render in render.ts, on-read in on-read.ts) re-walk
// and re-YAML-parse the full corpus on every invocation without memoization.  At
// the two highest-frequency hook sites this is O(reads × corpus) and O(turns ×
// corpus) respectively.  This module provides a single session-scoped cache that
// the hooks read from, so the corpus is scanned and parsed AT MOST ONCE per
// session turn/read burst.
//
// Lifecycle:
//   • clearSessionCache() — called on every `session_start` by canvas-doc-
//     substrate.ts.  It does NOT need to be called before the first use: a
//     cold cache (null) triggers a fresh scan on the next read.
//   • All getters lazily populate on first call after a clear.
//   • The cache is a module-level singleton (one JS module instance per pi
//     process, and each pi process hosts exactly one canvas node session).
//
// Cached entries:
//   • allMemoryDocs    — the full listAllMemoryDocs() corpus (parsed MemoryDocs,
//                        already YAML-parsed by the resolver).  Shared by both
//                        render.ts and on-read.ts so each session call site only
//                        pays the filesystem walk+parse ONCE.
//   • substrateDocs    — allMemoryDocs mapped through parseSubstrateDoc and
//                        null-filtered.  Used by render.ts's resolverDocs and
//                        on-read.ts's appliesToCandidates.
//   • allPlugins       — listAllPlugins() result.  renderSkillCatalog was calling
//                        listAllPlugins() twice per turn (once via listAllSkills,
//                        once directly for descriptions).
//   • nodeSubjects     — assembleNodeSubject() result keyed by nodeId.  The three
//                        boot-render functions each call it; caching avoids the
//                        meta.json read + sqlite spine-walk happening 2-3x per turn.

import type { MemoryDoc } from '../memory-resolver.js';
import type { SubstrateDoc } from './schema.js';

// Lazy import: pull in the real implementations only when the cache is populated.
// This avoids circular-import issues at module load time (render.ts imports us,
// and listAllMemoryDocs / parseSubstrateDoc are in sibling modules that also
// import from substrate/).

type ListAllMemoryDocsFn = () => MemoryDoc[];
type ParseSubstrateDocFn = (doc: MemoryDoc) => SubstrateDoc | null;
type ListAllPluginsFn = () => { name: string; manifest: { description?: string } }[];
type AssembleNodeSubjectFn = (id: string) => import('./subject.js').NodeConfigSubject | null;

interface SessionCache {
  allMemoryDocs: MemoryDoc[] | null;
  substrateDocs: SubstrateDoc[] | null;
  allPlugins: { name: string; manifest: { description?: string } }[] | null;
  nodeSubjects: Map<string, import('./subject.js').NodeConfigSubject | null>;
}

const _cache: SessionCache = {
  allMemoryDocs: null,
  substrateDocs: null,
  allPlugins: null,
  nodeSubjects: new Map(),
};

/** Called by canvas-doc-substrate.ts on every `session_start`.
 *  Resets all cached values so the next access triggers a fresh scan.  */
export function clearSessionCache(): void {
  _cache.allMemoryDocs = null;
  _cache.substrateDocs = null;
  _cache.allPlugins = null;
  _cache.nodeSubjects.clear();
}

/** All memory docs (listAllMemoryDocs()), scanned once per session.
 *  `listFn` is injected by the caller to avoid circular imports at module init. */
export function cachedAllMemoryDocs(listFn: ListAllMemoryDocsFn): MemoryDoc[] {
  if (_cache.allMemoryDocs === null) {
    _cache.allMemoryDocs = listFn();
  }
  return _cache.allMemoryDocs;
}

/** allMemoryDocs mapped through parseSubstrateDoc + null-filtered.
 *  Both render.ts and on-read.ts consume this. */
export function cachedSubstrateDocs(
  listFn: ListAllMemoryDocsFn,
  parseFn: ParseSubstrateDocFn,
): SubstrateDoc[] {
  if (_cache.substrateDocs === null) {
    _cache.substrateDocs = cachedAllMemoryDocs(listFn)
      .map(parseFn)
      .filter((d): d is SubstrateDoc => d !== null);
  }
  return _cache.substrateDocs;
}

/** listAllPlugins() result, cached per session. */
export function cachedAllPlugins(
  listFn: ListAllPluginsFn,
): { name: string; manifest: { description?: string } }[] {
  if (_cache.allPlugins === null) {
    _cache.allPlugins = listFn();
  }
  return _cache.allPlugins;
}

/** assembleNodeSubject(nodeId), cached per (session × nodeId). */
export function cachedNodeSubject(
  nodeId: string,
  assembleFn: AssembleNodeSubjectFn,
): import('./subject.js').NodeConfigSubject | null {
  if (!_cache.nodeSubjects.has(nodeId)) {
    _cache.nodeSubjects.set(nodeId, assembleFn(nodeId));
  }
  return _cache.nodeSubjects.get(nodeId) ?? null;
}
