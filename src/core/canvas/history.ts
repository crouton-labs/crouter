// canvas history — the scan-first engine over the per-cwd episodic record.
//
// The canvas accumulates a high-signal corpus per cwd: every node that ran
// there plus the artifacts it left — its `reports/` (append-only push history:
// final/update/urgent outcome summaries) and `context/` docs (specs, designs,
// roadmaps, findings). This module is the ONE place that scans that corpus; it
// lives in the canvas data-access layer, so it resolves every node + path
// through canvas.ts + paths.ts and never hand-joins. No persistent index —
// node facets (cwd/kind/status) are filtered cheaply against the db FIRST, then
// only the surviving nodes' artifact files are read. FTS5/bm25 is the future
// upgrade; the surface above is backend-independent.

import { statSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { getNode, listNodes, view } from './canvas.js';
import { contextDir, reportsDir, nodeDir } from './paths.js';
import type { NodeRow, NodeStatus } from './types.js';
import { readTextIfExists, walkFiles, pathExists } from '../fs-utils.js';
import { parseFrontmatterGeneric } from '../frontmatter.js';

export type HistorySource = 'report' | 'doc' | 'roadmap' | 'meta';

/** One searchable unit of the episodic record: a report, a context doc, a
 *  node's roadmap, or a node's meta (name/description/kind). */
export interface HistoryArtifact {
  /** Stable handle passed verbatim to `history read` — `<node-id>:<relpath>`. */
  ref: string;
  nodeId: string;
  /** Path under the node dir (`reports/x.md`, `context/design.md`) or `meta`. */
  relpath: string;
  source: HistorySource;
  /** final | update | urgent — reports only. */
  reportKind?: string;
  /** ISO 8601 artifact timestamp. */
  ts: string;
  /** Sort key: epoch ms of ts. */
  tsMs: number;
  /** Report title / doc first heading / node name. */
  title: string;
  nodeName: string;
  nodeKind: string;
  nodeStatus: NodeStatus;
  nodeCwd: string;
  nodeDesc: string;
  /** Absolute file path; null for the synthetic `meta` artifact. */
  path: string | null;
  /** Frontmatter-stripped body, loaded once and cached. Empty on read error. */
  loadBody: () => string;
}

export interface ScopeFilter {
  /** A specific cwd. Default (all flags absent) = the caller's cwd. */
  cwd?: string;
  /** Every cwd on the canvas. */
  allCwds?: boolean;
  /** A node and its subscription descendants (one initiative / sub-DAG). */
  under?: string;
  /** Explicit node ids. */
  nodes?: string[];
}

export interface CorpusFilter {
  types?: HistorySource[];
  /** Narrow reports to one report-kind (final | update). Implies type report. */
  reportKind?: string;
  /** Node kinds (developer, spec, …). */
  kinds?: string[];
  /** Node lifecycle statuses. */
  statuses?: NodeStatus[];
  /** Inclusive lower / upper bound on artifact ts, epoch ms. */
  sinceMs?: number;
  untilMs?: number;
}

/** The cwd the caller means by default: the calling node's cwd (resolved from
 *  CRTR_NODE_ID via the canvas data layer), falling back to the process cwd
 *  when not run as a node. */
export function callerCwd(): string {
  const id = process.env['CRTR_NODE_ID'];
  if (id !== undefined && id !== '') {
    const node = getNode(id);
    if (node !== null) return node.cwd;
  }
  return process.cwd();
}

/** Compact report stamp `20260607T075536` → `2026-06-07T07:55:36`. */
function compactToIso(stamp: string): string {
  const m = stamp.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (m === null) return stamp;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}

function toMs(ts: string): number {
  const n = Date.parse(ts);
  return Number.isNaN(n) ? 0 : n;
}

/** First markdown heading (`# …`) or first non-empty line, trimmed. */
function firstHeading(body: string): string {
  const lines = body.split('\n');
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('#')) return t.replace(/^#+\s*/, '').trim();
  }
  for (const l of lines) {
    const t = l.trim();
    if (t !== '') return t.length > 120 ? t.slice(0, 120) : t;
  }
  return '';
}

/** A memoized body loader for a file artifact — reads + strips frontmatter once. */
function fileBodyLoader(absPath: string): { load: () => string; head: string } {
  let cached: string | null = null;
  const load = (): string => {
    if (cached !== null) return cached;
    const raw = readTextIfExists(absPath);
    cached = raw === null ? '' : parseFrontmatterGeneric(raw).body;
    return cached;
  };
  // Read the head eagerly for ts/title derivation (the file is small markdown).
  const raw = readTextIfExists(absPath);
  const head = raw === null ? '' : raw;
  if (raw !== null) cached = parseFrontmatterGeneric(raw).body;
  return { load, head };
}

function reportArtifact(row: NodeRow, desc: string, filename: string): HistoryArtifact | null {
  const abs = join(reportsDir(row.node_id), filename);
  const m = filename.match(/^([0-9]{8}T[0-9]{6})-(\w+)\.md$/);
  const { load, head } = fileBodyLoader(abs);
  const fm = parseFrontmatterGeneric(head).data;
  const reportKind =
    (typeof fm?.['kind'] === 'string' ? (fm['kind'] as string) : undefined) ?? (m ? m[2] : 'report');
  const ts =
    (typeof fm?.['ts'] === 'string' ? (fm['ts'] as string) : undefined) ??
    (m ? compactToIso(m[1]) : new Date(statSync(abs).mtimeMs).toISOString());
  const body = load();
  return {
    ref: `${row.node_id}:reports/${filename}`,
    nodeId: row.node_id,
    relpath: `reports/${filename}`,
    source: 'report',
    reportKind,
    ts,
    tsMs: toMs(ts),
    title: firstHeading(body),
    nodeName: row.name,
    nodeKind: row.kind,
    nodeStatus: row.status,
    nodeCwd: row.cwd,
    nodeDesc: desc,
    path: abs,
    loadBody: load,
  };
}

function docArtifact(row: NodeRow, desc: string, abs: string): HistoryArtifact {
  const rel = relative(nodeDir(row.node_id), abs).split(sep).join('/');
  const isRoadmap = rel === 'context/roadmap.md';
  const { load } = fileBodyLoader(abs);
  let ts: string;
  try {
    ts = new Date(statSync(abs).mtimeMs).toISOString();
  } catch {
    ts = row.created;
  }
  const body = load();
  return {
    ref: `${row.node_id}:${rel}`,
    nodeId: row.node_id,
    relpath: rel,
    source: isRoadmap ? 'roadmap' : 'doc',
    ts,
    tsMs: toMs(ts),
    title: firstHeading(body) || rel.replace(/^context\//, ''),
    nodeName: row.name,
    nodeKind: row.kind,
    nodeStatus: row.status,
    nodeCwd: row.cwd,
    nodeDesc: desc,
    path: abs,
    loadBody: load,
  };
}

function metaArtifact(row: NodeRow, desc: string): HistoryArtifact {
  const body = `${row.name}\n${desc}\n${row.kind}`;
  return {
    ref: `${row.node_id}:meta`,
    nodeId: row.node_id,
    relpath: 'meta',
    source: 'meta',
    ts: row.created,
    tsMs: toMs(row.created),
    title: row.name,
    nodeName: row.name,
    nodeKind: row.kind,
    nodeStatus: row.status,
    nodeCwd: row.cwd,
    nodeDesc: desc,
    path: null,
    loadBody: () => body,
  };
}

/** List the markdown reports a node left, newest filename first. */
function listReportFiles(nodeId: string): string[] {
  const dir = reportsDir(nodeId);
  if (!pathExists(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}

/** Enumerate every context markdown doc a node left (recursive). */
function listDocFiles(nodeId: string): string[] {
  const dir = contextDir(nodeId);
  if (!pathExists(dir)) return [];
  try {
    return walkFiles(dir, (name) => name.endsWith('.md'));
  } catch {
    return [];
  }
}

/** The node desc lives in meta.json, not the row — read it once per survivor. */
function nodeDescOf(nodeId: string): string {
  const n = getNode(nodeId);
  return n?.description ?? '';
}

/** Build the searchable artifact set for a scope + corpus filter. Node facets
 *  are applied against the db rows first (cheap); only surviving nodes' files
 *  are read. */
export function buildCorpus(scope: ScopeFilter, corpus: CorpusFilter): HistoryArtifact[] {
  const rows = scopedRows(scope);

  // Node-facet narrowing (cheap, on the row).
  const kinds = corpus.kinds;
  const statuses = corpus.statuses;
  const survivors = rows.filter((r) => {
    if (kinds !== undefined && kinds.length > 0 && !kinds.includes(r.kind)) return false;
    if (statuses !== undefined && statuses.length > 0 && !statuses.includes(r.status)) return false;
    return true;
  });

  // --report-kind implies type=report.
  const wantReportKind = corpus.reportKind;
  const types =
    corpus.types !== undefined && corpus.types.length > 0
      ? corpus.types
      : wantReportKind !== undefined
        ? (['report'] as HistorySource[])
        : (['report', 'doc', 'roadmap', 'meta'] as HistorySource[]);
  const want = new Set<HistorySource>(types);

  const out: HistoryArtifact[] = [];
  for (const row of survivors) {
    const desc = want.has('meta') || want.has('report') || want.has('doc') || want.has('roadmap')
      ? nodeDescOf(row.node_id)
      : '';

    if (want.has('meta')) out.push(metaArtifact(row, desc));

    if (want.has('report')) {
      for (const f of listReportFiles(row.node_id)) {
        const a = reportArtifact(row, desc, f);
        if (a === null) continue;
        if (wantReportKind !== undefined && a.reportKind !== wantReportKind) continue;
        out.push(a);
      }
    }

    if (want.has('doc') || want.has('roadmap')) {
      for (const abs of listDocFiles(row.node_id)) {
        const a = docArtifact(row, desc, abs);
        if (a.source === 'roadmap' && !want.has('roadmap')) continue;
        if (a.source === 'doc' && !want.has('doc')) continue;
        out.push(a);
      }
    }
  }

  // Time window on artifact ts.
  return out.filter((a) => {
    if (corpus.sinceMs !== undefined && a.tsMs < corpus.sinceMs) return false;
    if (corpus.untilMs !== undefined && a.tsMs > corpus.untilMs) return false;
    return true;
  });
}

/** Resolve the scope to the node rows in play. */
function scopedRows(scope: ScopeFilter): NodeRow[] {
  const all = listNodes();
  const byId = new Map(all.map((r) => [r.node_id, r] as const));

  if (scope.nodes !== undefined && scope.nodes.length > 0) {
    return scope.nodes.map((id) => byId.get(id)).filter((r): r is NodeRow => r !== undefined);
  }
  if (scope.under !== undefined && scope.under !== '') {
    const ids = [scope.under, ...view(scope.under)];
    return ids.map((id) => byId.get(id)).filter((r): r is NodeRow => r !== undefined);
  }
  if (scope.allCwds === true) return all;
  const cwd = scope.cwd !== undefined && scope.cwd !== '' ? scope.cwd : callerCwd();
  return all.filter((r) => r.cwd === cwd);
}

export interface ResolvedRef {
  nodeId: string;
  relpath: string;
  source: HistorySource;
  reportKind?: string;
  ts: string;
  nodeName: string;
  /** Frontmatter-stripped body. */
  body: string;
  /** Raw file content (frontmatter included); null for meta. */
  raw: string | null;
  path: string | null;
}

/** Resolve a `<node-id>:<relpath>` handle to its content. Returns null when the
 *  node is unknown or the artifact does not exist. Throws on path traversal. */
export function resolveRef(ref: string): ResolvedRef | null {
  const idx = ref.indexOf(':');
  if (idx === -1) return null;
  const nodeId = ref.slice(0, idx);
  const relpath = ref.slice(idx + 1);
  const node = getNode(nodeId);
  if (node === null) return null;

  if (relpath === 'meta') {
    const body = `# ${node.name}\n\n- kind: ${node.kind}\n- status: ${node.status}\n- cwd: ${node.cwd}\n- created: ${node.created}\n\n${node.description ?? ''}`;
    return {
      nodeId,
      relpath,
      source: 'meta',
      ts: node.created,
      nodeName: node.name,
      body,
      raw: null,
      path: null,
    };
  }

  if (relpath.includes('..') || relpath.startsWith('/')) {
    throw new Error(`illegal relpath in ref: ${relpath}`);
  }
  const abs = join(nodeDir(nodeId), relpath);
  const raw = readTextIfExists(abs);
  if (raw === null) return null;
  const { body, data: fm } = parseFrontmatterGeneric(raw);
  const isReport = relpath.startsWith('reports/');
  const isRoadmap = relpath === 'context/roadmap.md';
  let ts: string;
  if (typeof fm?.['ts'] === 'string') ts = fm['ts'] as string;
  else {
    try {
      ts = new Date(statSync(abs).mtimeMs).toISOString();
    } catch {
      ts = node.created;
    }
  }
  return {
    nodeId,
    relpath,
    source: isReport ? 'report' : isRoadmap ? 'roadmap' : 'doc',
    reportKind: isReport && typeof fm?.['kind'] === 'string' ? (fm['kind'] as string) : undefined,
    ts,
    nodeName: node.name,
    body,
    raw,
    path: abs,
  };
}

/** Enumerate one node's artifacts (for `history show`). */
export function nodeArtifacts(nodeId: string, types?: HistorySource[]): HistoryArtifact[] {
  const node = getNode(nodeId);
  if (node === null) return [];
  const row: NodeRow = {
    node_id: node.node_id,
    name: node.name,
    kind: node.kind,
    mode: node.mode,
    lifecycle: node.lifecycle,
    status: node.status,
    cwd: node.cwd,
    host_kind: node.host_kind ?? null,
    parent: node.parent ?? null,
    created: node.created,
    intent: node.intent ?? null,
    pi_pid: node.pi_pid ?? null,
    window: node.window ?? null,
    tmux_session: node.tmux_session ?? null,
    pane: node.pane ?? null,
  };
  const want = new Set<HistorySource>(types !== undefined && types.length > 0 ? types : ['report', 'doc', 'roadmap']);
  const desc = node.description ?? '';
  const out: HistoryArtifact[] = [];
  if (want.has('report')) {
    for (const f of listReportFiles(nodeId)) {
      const a = reportArtifact(row, desc, f);
      if (a !== null) out.push(a);
    }
  }
  if (want.has('doc') || want.has('roadmap')) {
    for (const abs of listDocFiles(nodeId)) {
      const a = docArtifact(row, desc, abs);
      if (a.source === 'roadmap' && !want.has('roadmap')) continue;
      if (a.source === 'doc' && !want.has('doc')) continue;
      out.push(a);
    }
  }
  return out;
}

export interface CorpusStats {
  cwd: string;
  nodes: number;
  reports: number;
  docs: number;
  /** ISO date min → max across all artifacts, or null when empty. */
  span: { from: string; to: string } | null;
}

/** Bounded per-cwd aggregate for the branch `-h` `<corpus>` block. Counts files
 *  on disk without reading bodies. */
export function corpusStats(cwd: string): CorpusStats {
  const rows = listNodes().filter((r) => r.cwd === cwd);
  let reports = 0;
  let docs = 0;
  let min = Infinity;
  let max = -Infinity;
  for (const row of rows) {
    const cMs = toMs(row.created);
    if (cMs > 0) {
      if (cMs < min) min = cMs;
      if (cMs > max) max = cMs;
    }
    for (const f of listReportFiles(row.node_id)) {
      reports++;
      const m = f.match(/^([0-9]{8}T[0-9]{6})-/);
      if (m !== null) {
        const t = toMs(compactToIso(m[1]));
        if (t > 0) {
          if (t < min) min = t;
          if (t > max) max = t;
        }
      }
    }
    docs += listDocFiles(row.node_id).length;
  }
  const span =
    min !== Infinity && max !== -Infinity
      ? { from: new Date(min).toISOString().slice(0, 10), to: new Date(max).toISOString().slice(0, 10) }
      : null;
  return { cwd, nodes: rows.length, reports, docs, span };
}
