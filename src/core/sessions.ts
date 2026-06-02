// Session graph module — persisted record of agents belonging to one "effort".
//
// Files are the single source of truth. No in-memory registry. Atomic
// tmp+rename writes. Lock: mkdir-based (POSIX atomic on the same filesystem),
// 5s stale-steal, ~50ms busy spin, ~3s cap.
//
// Layout: ~/.crouter/<mangled-cwd>/sessions/<session_id>/session.json
//
// session.json shape:
//   { session_id, created, root_pane, tmux_session, agents: [...], nodes: [...], edges: [...] }
//
// The original pane is modeled as a host node; spawned agents are agent nodes.
// Legacy `agents[].parent` remains for current UIs, but graph topology is the
// nodes+edges set. Edge types distinguish provenance (`spawned_by`) from result
// routing (`reports_to`) and event interest (`subscribes_to`).
//
// Each legacy agent entry: { job_id, node_id, parent, report_to, subscribes_to,
//   name, agent, pane_id, cwd, created, title, host_session_id, status }
//
// Mutable per-agent state (status, telemetry) is NOT written back to
// session.json; it is joined at read time. session.json only changes on
// structural events (session/node/edge/agent appended), keeping lock contention
// near zero.

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readdirSync,
  readFileSync,
  statSync,
  rmdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { jobStatus, readTelemetry, livePanes, createJob, recordJobPane, writeMarkdownResult, type TelemetryRec } from './jobs.js';
import { general } from './errors.js';
import {
  sessionsRoot,
  sessionDir,
  sessionMetaPath,
  appendNodeEvent,
  readNodeInbox,
  type NodeEvent,
} from './inbox.js';

// Re-export the inbox + path primitives (moved to ./inbox.js to break the
// sessions<->jobs import cycle) so existing importers of sessions.js are
// unaffected.
export {
  sessionsRoot,
  sessionDir,
  appendNodeEvent,
  readNodeInbox,
  type NodeEvent,
};

// ---------------------------------------------------------------------------
// On-disk record types
// ---------------------------------------------------------------------------

export type SessionNodeKind = 'agent' | 'external';
export type SessionEdgeType = 'spawned_by' | 'reports_to' | 'subscribes_to' | 'handoff_to';

export interface SessionNode {
  node_id: string;
  kind: SessionNodeKind;
  created: string;
  job_id?: string;
  pane_id?: string;
  host_session_id?: string | null;
  cwd?: string;
  label?: string;
}

export interface SessionEdge {
  edge_id: string;
  type: SessionEdgeType;
  from: string;
  to: string;
  created: string;
}

interface AgentRecord {
  job_id: string;
  node_id?: string;
  parent: string | null;
  report_to?: string[];
  subscribes_to?: string[];
  name: string;
  agent: string;
  pane_id: string;
  cwd: string;
  created: string;
  title: string;
  host_session_id: string | null;
  status: 'running' | 'done' | 'failed' | 'closed' | 'canceled' | 'superseded';
}

interface SessionRecord {
  session_id: string;
  created: string;
  root_pane: string;
  tmux_session: string;
  /** The pi conversation that owns this top-level session (stable across
   *  /reload, new on /new). Absent on legacy records and spawned-agent
   *  sessions, which fall back to the pane-based host node. */
  pi_session_id?: string | null;
  /** Node id of the current root job. Replaces the implicit
   *  "host node = root_pane/pi" rule. Phase 3+. Absent on legacy records;
   *  synthesized at read time by normalizeSessionRecord. */
  root_node_id?: string;
  agents: AgentRecord[];
  nodes?: SessionNode[];
  edges?: SessionEdge[];
}

// ---------------------------------------------------------------------------
// Public view types (reconciled + telemetry-joined)
// ---------------------------------------------------------------------------

export interface AgentView {
  job_id: string;
  node_id: string;
  parent: string | null;
  report_to: string[];
  subscribes_to: string[];
  name: string;
  agent: string;
  pane_id: string;
  cwd: string;
  created: string;
  title: string;
  host_session_id: string | null;
  status: string;
  age_s: number;
  telemetry: TelemetryRec | null;
}

export interface SessionView {
  session_id: string;
  created: string;
  root_pane: string;
  tmux_session: string;
  pi_session_id: string | null;
  /** Node id of the current root job. Set for all sessions after Phase 3;
   *  synthesized from the host node id for legacy records. */
  root_node_id?: string;
  nodes: SessionNode[];
  edges: SessionEdge[];
  agents: AgentView[];
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Allocate a fresh session id. Shape mirrors generateJobId in jobs.ts but is a
 * distinct value: `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`.
 */
export function mintSessionId(): string {
  const ts = Date.now().toString(36);
  const rnd = randomBytes(4).toString('hex');
  return `${ts}-${rnd}`;
}

/**
 * Read CRTR_SESSION_ID and CRTR_PARENT_JOB_ID (or CRTR_JOB_ID as fallback)
 * from the environment. Returns null for each when the var is absent.
 */
export function currentSessionContext(): {
  sessionId: string | null;
  parentJobId: string | null;
} {
  return {
    sessionId: process.env['CRTR_SESSION_ID'] ?? null,
    parentJobId:
      process.env['CRTR_PARENT_JOB_ID'] ?? process.env['CRTR_JOB_ID'] ?? null,
  };
}

/** Canonical node id for a host/origin tmux pane. */
export function hostPaneNodeId(paneId: string): string {
  return `pane:${paneId}`;
}

/**
 * @deprecated Use `view.root_node_id` directly in new code. Kept as a shim for
 * one release for legacy path fallbacks and tests.
 *
 * Canonical host node id for a session record. When bound to a pi conversation
 * (top-level), the host node is `pi:<pi_session_id>` so identity follows the
 * conversation, not the recycled tmux pane number. Legacy / spawned-agent
 * sessions (no `pi_session_id`) keep the pane node.
 */
export function hostNodeIdFor(rec: {
  pi_session_id?: string | null;
  root_pane: string;
}): string {
  return rec.pi_session_id != null && rec.pi_session_id !== ''
    ? `pi:${rec.pi_session_id}`
    : hostPaneNodeId(rec.root_pane);
}

/**
 * Canonical root node id for a session view (Phase 4+). Authoritative accessor
 * that replaces the deprecated `hostNodeIdFor`/`hostPaneNodeId` pattern.
 */
export function rootNodeId(view: { root_node_id?: string }): string | undefined {
  return view.root_node_id;
}

function edgeId(type: SessionEdgeType, from: string, to: string): string {
  return `${type}:${from}->${to}`;
}

function addNode(record: SessionRecord, node: SessionNode): void {
  record.nodes ??= [];
  if (record.nodes.some((n) => n.node_id === node.node_id)) return;
  record.nodes.push(node);
}

function addEdge(
  record: SessionRecord,
  type: SessionEdgeType,
  from: string,
  to: string,
  created: string,
): void {
  record.edges ??= [];
  const id = edgeId(type, from, to);
  if (record.edges.some((e) => e.edge_id === id)) return;
  record.edges.push({ edge_id: id, type, from, to, created });
}

function normalizeRefs(refs: string[] | undefined): string[] {
  if (refs === undefined) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const ref = raw.trim();
    if (ref === '' || seen.has(ref)) continue;
    seen.add(ref);
    out.push(ref);
  }
  return out;
}

/**
 * Bring older session.json files forward in memory. New writers persist this
 * shape; readers also normalize so pre-graph session records remain usable.
 *
 * Phase 4.1: retype any on-disk 'host' nodes to 'external' (read-time migration).
 * Phase 4.1 / 3.2: if root_node_id is absent, synthesize it from hostNodeIdFor()
 * and add an 'external' placeholder node (no job backing — legacy/claude origin).
 */
function normalizeSessionRecord(record: SessionRecord): SessionRecord {
  record.nodes ??= [];
  record.edges ??= [];

  // Phase 4.1: retype any on-disk 'host' kind to 'external' (forward migration).
  for (const node of record.nodes) {
    if ((node.kind as string) === 'host') {
      node.kind = 'external';
    }
  }

  // Synthesize root_node_id for legacy records (pre-Phase-3) that don't have one.
  // The synthesized id matches the old host node id; we add an 'external' node
  // (no job backing) as the placeholder root for those records.
  if (!record.root_node_id) {
    const legacyRootId = hostNodeIdFor(record);
    record.root_node_id = legacyRootId;
    addNode(record, {
      node_id: legacyRootId,
      kind: 'external',
      pane_id: record.root_pane,
      created: record.created,
      label: 'origin',
    });
  }

  for (const agent of record.agents) {
    agent.node_id ??= agent.job_id;
    agent.report_to = normalizeRefs(agent.report_to);
    agent.subscribes_to = normalizeRefs(agent.subscribes_to);

    addNode(record, {
      node_id: agent.node_id,
      kind: 'agent',
      job_id: agent.job_id,
      pane_id: agent.pane_id,
      cwd: agent.cwd,
      created: agent.created,
      host_session_id: agent.host_session_id,
      label: agent.name,
    });

    // Use root_node_id as the default spawned_by target (always set after
    // the synthesis above). Falls back to hostNodeIdFor for type safety only.
    const rootId = record.root_node_id ?? hostNodeIdFor(record);
    addEdge(record, 'spawned_by', agent.node_id, agent.parent ?? rootId, agent.created);
    for (const target of agent.report_to) addEdge(record, 'reports_to', agent.node_id, target, agent.created);
    for (const target of agent.subscribes_to) addEdge(record, 'subscribes_to', agent.node_id, target, agent.created);
  }

  return record;
}

// ---------------------------------------------------------------------------
// Locking — mkdir-based, sync busy-spin
// ---------------------------------------------------------------------------

const LOCK_SPIN_MS = 50;
const LOCK_STALE_MS = 5000;
const LOCK_CAP_MS = 3000;

function busySpin(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
}

/**
 * Acquire a mutex over `dir` via `mkdir <dir>/.lock` (POSIX atomic), run `fn`,
 * then release. On EEXIST: steal if mtime >5s; else spin ~50ms and retry.
 * Throws `general` if the lock cannot be acquired within ~3s.
 */
function withSessionLock<T>(dir: string, fn: () => T): T {
  const lockDir = join(dir, '.lock');
  const deadline = Date.now() + LOCK_CAP_MS;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      mkdirSync(lockDir);
      break; // acquired
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'EEXIST') throw e;

      // Check for stale lock
      let lockMtime = 0;
      try {
        lockMtime = statSync(lockDir).mtimeMs;
      } catch {
        // Lock dir disappeared — retry immediately
        continue;
      }

      if (Date.now() - lockMtime > LOCK_STALE_MS) {
        // Steal
        try { rmdirSync(lockDir); } catch { /* concurrently stolen — that's fine */ }
        continue;
      }

      if (Date.now() >= deadline) {
        throw general('could not acquire session lock within 3s', { dir });
      }
      busySpin(LOCK_SPIN_MS);
    }
  }

  try {
    return fn();
  } finally {
    try { rmdirSync(lockDir); } catch { /* noop */ }
  }
}

// ---------------------------------------------------------------------------
// Reconciliation + read model helpers
// ---------------------------------------------------------------------------

/**
 * Derive the effective status for an agent at read time.
 * 1) If the job reached a terminal state (done|failed|canceled|closed|superseded) — that wins.
 * 2) If the stored status is 'running' but the pane is gone — 'closed'.
 * 3) Otherwise return the stored status.
 */
export function reconcileStatus(
  rec: AgentRecord,
  panes: Set<string>,
): AgentView['status'] {
  let state: string;
  try {
    state = jobStatus(rec.job_id).state;
  } catch {
    // If job meta is unreadable, fall through to pane check
    state = 'live';
  }
  if (state !== 'live') return state;
  if (rec.status === 'running' && !panes.has(rec.pane_id)) return 'closed';
  return rec.status;
}

function toAgentView(rec: AgentRecord, panes: Set<string>): AgentView {
  return {
    job_id: rec.job_id,
    node_id: rec.node_id ?? rec.job_id,
    parent: rec.parent,
    report_to: normalizeRefs(rec.report_to),
    subscribes_to: normalizeRefs(rec.subscribes_to),
    name: rec.name,
    agent: rec.agent,
    pane_id: rec.pane_id,
    cwd: rec.cwd,
    created: rec.created,
    title: rec.title,
    host_session_id: rec.host_session_id,
    status: reconcileStatus(rec, panes),
    age_s: (Date.now() - Date.parse(rec.created)) / 1000,
    telemetry: readTelemetry(rec.job_id),
  };
}

// ---------------------------------------------------------------------------
// Graph mutation
// ---------------------------------------------------------------------------

/**
 * Ensure a session record exists for `sessionId`. Creates the directory and
 * writes a fresh session.json if absent. Idempotent: existing records are
 * untouched.
 */
export function ensureSession(opts: {
  sessionId: string;
  rootPane: string;
  tmuxSession: string;
  cwd?: string;
  /** Bind this top-level session to a pi conversation; makes the host node
   *  `pi:<id>`. Omit for spawned-agent / legacy sessions. */
  piSessionId?: string | null;
  /** Node id of the root job for this session (Phase 3+). Stored so readers
   *  resolve root_node_id without a scan. */
  rootNodeId?: string;
}): void {
  const dir = sessionDir(opts.sessionId, opts.cwd);
  mkdirSync(dir, { recursive: true });

  const mp = sessionMetaPath(opts.sessionId, opts.cwd);
  if (existsSync(mp)) return; // fast-path: already exists

  withSessionLock(dir, () => {
    if (existsSync(mp)) return; // re-check inside lock
    const created = new Date().toISOString();
    const piSessionId = opts.piSessionId ?? null;
    // Phase 4.1: no synthetic host node — start with empty nodes/edges.
    // Readers call normalizeSessionRecord which synthesizes an 'external' root
    // for legacy records, or resolves the job-backed root from root_node_id.
    const record: SessionRecord = {
      session_id: opts.sessionId,
      created,
      root_pane: opts.rootPane,
      tmux_session: opts.tmuxSession,
      pi_session_id: piSessionId,
      ...(opts.rootNodeId !== undefined ? { root_node_id: opts.rootNodeId } : {}),
      agents: [],
      nodes: [],
      edges: [],
    };
    const tmp = join(dir, '.session.tmp');
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, mp);
  });
}

/**
 * Append an agent record to an existing session. Caller must have called
 * `ensureSession` first — throws `general` if session.json is absent.
 * The stored `status` is always `'running'`; readers reconcile.
 */
export function appendAgent(
  sessionId: string,
  cwd: string | undefined,
  rec: {
    job_id: string;
    node_id?: string;
    parent: string | null;
    report_to?: string[];
    subscribes_to?: string[];
    name: string;
    agent: string;
    pane_id: string;
    cwd: string;
    created: string;
    title: string;
    host_session_id: string | null;
    status: 'running';
  },
): void {
  const dir = sessionDir(sessionId, cwd);
  withSessionLock(dir, () => {
    const mp = sessionMetaPath(sessionId, cwd);
    if (!existsSync(mp)) {
      throw general(
        `session not found: ${sessionId} — call ensureSession first`,
        { session_id: sessionId },
      );
    }
    let session: SessionRecord;
    try {
      session = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
    } catch {
      throw general(`failed to parse session.json for ${sessionId}`, {
        session_id: sessionId,
      });
    }

    normalizeSessionRecord(session);

    const nodeId = rec.node_id ?? rec.job_id;
    const reportTo = normalizeRefs(rec.report_to);
    const subscribesTo = normalizeRefs(rec.subscribes_to);
    const agentRec: AgentRecord = {
      ...rec,
      node_id: nodeId,
      report_to: reportTo,
      subscribes_to: subscribesTo,
    };
    session.agents.push(agentRec);

    // Use root_node_id as the spawned_by default (always set after normalizeSessionRecord).
    const rootId = session.root_node_id ?? hostNodeIdFor(session);
    addNode(session, {
      node_id: nodeId,
      kind: 'agent',
      job_id: agentRec.job_id,
      pane_id: agentRec.pane_id,
      cwd: agentRec.cwd,
      created: agentRec.created,
      host_session_id: agentRec.host_session_id,
      label: agentRec.name,
    });
    addEdge(session, 'spawned_by', nodeId, agentRec.parent ?? rootId, agentRec.created);
    for (const target of reportTo) addEdge(session, 'reports_to', nodeId, target, agentRec.created);
    for (const target of subscribesTo) addEdge(session, 'subscribes_to', nodeId, target, agentRec.created);

    const tmp = join(dir, '.session.tmp');
    writeFileSync(tmp, JSON.stringify(session, null, 2), 'utf8');
    renameSync(tmp, mp);
  });
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/**
 * Load and reconcile a single session. Returns null when the session directory
 * or session.json is absent, or when session.json is unparseable.
 */
export function loadSessionView(
  sessionId: string,
  cwd?: string,
): SessionView | null {
  const mp = sessionMetaPath(sessionId, cwd);
  if (!existsSync(mp)) return null;
  let record: SessionRecord;
  try {
    record = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
  } catch {
    return null;
  }
  const normalized = normalizeSessionRecord(record);
  const panes = livePanes();
  return {
    session_id: normalized.session_id,
    created: normalized.created,
    root_pane: normalized.root_pane,
    tmux_session: normalized.tmux_session,
    pi_session_id: normalized.pi_session_id ?? null,
    root_node_id: normalized.root_node_id,
    nodes: normalized.nodes ?? [],
    edges: normalized.edges ?? [],
    agents: normalized.agents.map((a) => toAgentView(a, panes)),
  };
}

/**
 * List all sessions for the given cwd, sorted by `created` ascending. Skips
 * absent or corrupt records without throwing.
 */
export function listSessionViews(cwd?: string): SessionView[] {
  const root = sessionsRoot(cwd);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const views: SessionView[] = [];
  for (const entry of entries) {
    const view = loadSessionView(entry, cwd);
    if (view !== null) views.push(view);
  }
  views.sort((a, b) => a.created.localeCompare(b.created));
  return views;
}

/**
 * Resolve an agent within a session by `ref`:
 *  1. job_id exact match
 *  2. name exact match
 *  3. 1-based integer index
 * Returns null if the session does not exist or no agent matches.
 */
export function resolveAgent(
  sessionId: string,
  ref: string,
  cwd?: string,
): AgentView | null {
  const view = loadSessionView(sessionId, cwd);
  if (view === null) return null;
  const agents = view.agents;

  const byJobId = agents.find((a) => a.job_id === ref);
  if (byJobId !== undefined) return byJobId;

  const byName = agents.find((a) => a.name === ref);
  if (byName !== undefined) return byName;

  const idx = parseInt(ref, 10);
  if (Number.isInteger(idx) && idx >= 1 && idx <= agents.length) {
    return agents[idx - 1] ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Root job bootstrap (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Reap superseded top-level sessions on `pane` that belong to a DIFFERENT pi
 * conversation AND have no live non-root agent panes. Also finalizes (writes
 * `closed`) any still-live root job in those sessions so it stops being a
 * zombie — the pane is reused, so pane-death reaping would never close it.
 *
 * Called from ensureRootJob after the new root is established. Best-effort;
 * errors on individual sessions are swallowed.
 */
function reapSupersededRootSessions(
  pane: string,
  keepPiSessionId: string,
  cwd?: string,
): void {
  const root = sessionsRoot(cwd);
  if (!existsSync(root)) return;
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return;
  }
  const panes = livePanes();
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const mp = join(dir, 'session.json');
      if (!existsSync(mp)) continue;
      let rec: SessionRecord;
      try {
        rec = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
      } catch {
        continue;
      }
      if (rec.root_pane !== pane) continue;
      if ((rec.pi_session_id ?? null) === keepPiSessionId) continue;

      const normalized = normalizeSessionRecord(rec);
      const rootNodeId = normalized.root_node_id;

      // Spare the session if it still has live non-root agent panes.
      const hasLiveNonRoot = normalized.agents.some(
        (a) => a.job_id !== rootNodeId && panes.has(a.pane_id),
      );
      if (hasLiveNonRoot) continue;

      // Finalize the root job: if it is still live, write `closed` so it
      // stops being a zombie (the shared pane means reapIfPaneDead won't do it).
      if (rootNodeId !== undefined) {
        try {
          const { state } = jobStatus(rootNodeId);
          if (state === 'live') {
            writeMarkdownResult(rootNodeId, '', 'closed', 'superseded by new pi conversation');
          }
        } catch {
          /* rootNodeId is a legacy host node id, not a job id — skip */
        }
      }

      rmSync(dir, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
}

/**
 * Bootstrap the persistent root job for a top-level pi conversation.
 * Returns `{ sessionId, jobId }` where:
 *   - `sessionId` is deterministic: `pi-<piSessionId>` — the idempotency lever
 *     that makes create-or-resolve race-free without a scan.
 *   - `jobId` is the persistent root job id (pane-backed, no pid recorded).
 *
 * Idempotency matrix:
 *   - `/reload`: same piSessionId ⇒ same deterministic session ⇒ root job live ⇒ no-op.
 *   - `/new`: new piSessionId ⇒ new session + root job; reaps prior pane-sibling roots.
 *   - pane reuse: same as `/new`.
 *
 * CRITICAL: do NOT record `process.pid` for the root job. `process.pid` is the
 * transient `root-init` subprocess (exits immediately), so jobStatus's
 * `pid && !pidAlive(pid) ⇒ failed` check would instantly false-fail the root.
 * Rely SOLELY on pane-death reaping (reapIfPaneDead) for eventual finalization.
 */
export function ensureRootJob(opts: {
  piSessionId: string;
  rootPane: string;
  tmuxSession: string;
  cwd: string;
}): { sessionId: string; jobId: string } {
  const sessionId = `pi-${opts.piSessionId}`;
  const dir = sessionDir(sessionId, opts.cwd);
  mkdirSync(dir, { recursive: true });
  const mp = sessionMetaPath(sessionId, opts.cwd);

  const result = withSessionLock(dir, (): { sessionId: string; jobId: string } => {
    // Fast path: existing session with a live root job → /reload no-op.
    if (existsSync(mp)) {
      let existing: SessionRecord;
      try {
        existing = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
      } catch {
        existing = {
          session_id: sessionId,
          created: new Date().toISOString(),
          root_pane: opts.rootPane,
          tmux_session: opts.tmuxSession,
          pi_session_id: opts.piSessionId,
          agents: [],
        };
      }
      const normalized = normalizeSessionRecord(existing);
      const existingRootJobId = normalized.root_node_id;
      if (existingRootJobId !== undefined) {
        try {
          const { state } = jobStatus(existingRootJobId);
          if (state === 'live') {
            // Root job is still alive — idempotent return.
            return { sessionId, jobId: existingRootJobId };
          }
        } catch {
          /* job record missing or corrupt — create new root */
        }
      }
    }

    // Create a new persistent root job. DO NOT record pid.
    const { jobId } = createJob('pi-root', {
      cwd: opts.cwd,
      lifecycle: 'persistent',
      root: true,
      forward: false,
    });
    // Record pane so reapIfPaneDead can close the job when pi quits.
    recordJobPane(jobId, opts.rootPane);

    const created = new Date().toISOString();

    // Phase 4.1: no host node — root job is the job-backed 'agent' node.
    // Build the session record (create fresh or re-use existing skeleton).
    let record: SessionRecord;
    if (existsSync(mp)) {
      try {
        record = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
        normalizeSessionRecord(record);
      } catch {
        record = {
          session_id: sessionId,
          created,
          root_pane: opts.rootPane,
          tmux_session: opts.tmuxSession,
          pi_session_id: opts.piSessionId,
          agents: [],
          nodes: [],
          edges: [],
        };
      }
    } else {
      record = {
        session_id: sessionId,
        created,
        root_pane: opts.rootPane,
        tmux_session: opts.tmuxSession,
        pi_session_id: opts.piSessionId,
        agents: [],
        nodes: [],
        edges: [],
      };
    }

    // Update root_node_id to the new job.
    record.root_node_id = jobId;

    // Add the root job as a job-backed agent node (Phase 4: no separate host node).
    addNode(record, {
      node_id: jobId,
      kind: 'agent',
      job_id: jobId,
      pane_id: opts.rootPane,
      cwd: opts.cwd,
      created,
      label: 'pi-root',
    });

    // Register the root job in agents[] (job-backed, parent:null, report_to:[]).
    if (!record.agents.some((a) => a.job_id === jobId)) {
      record.agents.push({
        job_id: jobId,
        node_id: jobId,
        parent: null,
        report_to: [],
        subscribes_to: [],
        name: 'pi-root',
        agent: 'pi-root',
        pane_id: opts.rootPane,
        cwd: opts.cwd,
        created,
        title: 'pi root session',
        host_session_id: null,
        status: 'running',
      });
    }

    const tmp = join(dir, '.session.tmp');
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, mp);

    return { sessionId, jobId };
  });

  // Reap superseded same-pane sessions (best-effort, outside the lock).
  try {
    reapSupersededRootSessions(opts.rootPane, opts.piSessionId, opts.cwd);
  } catch {
    /* best-effort */
  }

  return result;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Reap sessions that no longer represent live work. A session is kept iff any
 * of its job nodes is live: `jobStatus(jobId).state === 'live'` AND its
 * `pane_id ∈ panes`. Otherwise the session is deleted.
 *
 * This subsumes the old (root_pane, pi_session_id) canonical-group rule: the
 * current conversation survives because its root job's pane (= the human pi
 * pane) is live and the job is live; when pi quits, reapIfPaneDead writes
 * `closed` → no live node → reapable. Sessions with no job nodes (legacy
 * records with only an external root) are always reaped.
 *
 * Errors on individual sessions are swallowed; the full sweep continues.
 */
export function reapDeadSessions(
  panes: Set<string>,
  cwd?: string,
): string[] {
  const root = sessionsRoot(cwd);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  // Load every readable session record.
  const records: Array<{ dir: string; rec: SessionRecord }> = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const mp = join(dir, 'session.json');
      if (!existsSync(mp)) continue;
      let raw: SessionRecord;
      try {
        raw = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
      } catch {
        continue;
      }
      records.push({ dir, rec: normalizeSessionRecord(raw) });
    } catch {
      continue;
    }
  }

  // Reap any session with no live job node.
  const reaped: string[] = [];
  for (const { dir, rec } of records) {
    try {
      const alive = rec.agents.some((a) => {
        if (!panes.has(a.pane_id)) return false;
        try {
          return jobStatus(a.job_id).state === 'live';
        } catch {
          return false;
        }
      });
      if (alive) continue;
      rmSync(dir, { recursive: true, force: true });
      reaped.push(rec.session_id);
    } catch {
      continue;
    }
  }
  return reaped;
}

/**
 * Reap sibling top-level sessions rooted at `pane` that belong to a DIFFERENT
 * (or no) pi conversation AND have no live non-root agent panes. Clears
 * legacy/stale sessions left by prior conversations on a still-live pane (the
 * pane-death reaper can never collect these because the pane stays alive).
 * Best-effort; errors on individual sessions are swallowed.
 *
 * Liveness excludes the root node: the shared pane is the root pane for these
 * sibling sessions, so checking the root job pane would always look alive and
 * reap nothing. We consider AGENT panes only where job_id !== root_node_id,
 * so a sibling with a still-running worker is spared.
 */
export function reapSupersededSessions(
  pane: string,
  keepPiSessionId: string,
  panes: Set<string>,
  cwd?: string,
): string[] {
  const root = sessionsRoot(cwd);
  if (!existsSync(root)) return [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const reaped: string[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    try {
      if (!statSync(dir).isDirectory()) continue;
      const mp = join(dir, 'session.json');
      if (!existsSync(mp)) continue;
      let rec: SessionRecord;
      try {
        rec = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
      } catch {
        continue;
      }
      if (rec.root_pane !== pane) continue;
      if ((rec.pi_session_id ?? null) === keepPiSessionId) continue;

      const normalized = normalizeSessionRecord(rec);
      // Exclude the root node (its pane = the shared pane). Spare only if a
      // non-root agent job still has a live pane.
      const rootNodeId = normalized.root_node_id;
      const liveNonRoot = normalized.agents.some(
        (a) => a.job_id !== rootNodeId && panes.has(a.pane_id),
      );
      if (!liveNonRoot) {
        rmSync(dir, { recursive: true, force: true });
        reaped.push(rec.session_id);
      }
    } catch {
      continue;
    }
  }
  return reaped;
}

// ---------------------------------------------------------------------------
// Node resolution
// ---------------------------------------------------------------------------

/**
 * Find the session whose root pane equals `pane`, for the given cwd. Used to
 * resolve the top-level (human-driven) session from its originating tmux pane
 * when CRTR_SESSION_ID is not present in the environment. Returns the session
 * id or null.
 */
export function findSessionByRootPane(
  pane: string,
  cwd?: string,
): string | null {
  for (const view of listSessionViews(cwd)) {
    if (view.root_pane === pane) return view.session_id;
  }
  return null;
}

/**
 * Find the crtr session bound to a pi conversation (top-level), for the given
 * cwd. This is the pane-reuse-proof replacement for `findSessionByRootPane`:
 * each pi conversation owns exactly one session, so a new conversation in a
 * reused pane never resolves a prior conversation's session. Returns the
 * session id or null.
 */
export function findSessionByPiSession(
  piSessionId: string,
  cwd?: string,
): string | null {
  for (const view of listSessionViews(cwd)) {
    if (view.pi_session_id === piSessionId) return view.session_id;
  }
  return null;
}

/**
 * Locate the session containing a node ref (node_id, job_id, agent name, or
 * 1-based index) and return the resolved node id. Searches the given session
 * first, then every session for the cwd. Returns null when no node matches.
 */
export function findNode(
  ref: string,
  opts: { sessionId?: string; cwd?: string } = {},
): { sessionId: string; nodeId: string } | null {
  const cwd = opts.cwd;
  const search = (view: SessionView): string | null => {
    const node = view.nodes.find((n) => n.node_id === ref);
    if (node !== undefined) return node.node_id;
    const agent = resolveAgent(view.session_id, ref, cwd);
    if (agent !== null) return agent.node_id;
    return null;
  };

  if (opts.sessionId !== undefined) {
    const view = loadSessionView(opts.sessionId, cwd);
    if (view !== null) {
      const nodeId = search(view);
      if (nodeId !== null) return { sessionId: view.session_id, nodeId };
    }
  }

  for (const view of listSessionViews(cwd)) {
    if (view.session_id === opts.sessionId) continue;
    const nodeId = search(view);
    if (nodeId !== null) return { sessionId: view.session_id, nodeId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Promotion (Phase 5)
// ---------------------------------------------------------------------------

/**
 * Atomically promote a new root (B) into the session, stepping down the old
 * root (A). All mutations happen under a SINGLE `withSessionLock` so a child
 * spawned mid-promotion cannot report to the wrong root.
 *
 * Under the lock:
 *  1. Append B's node (`kind:'agent'`, job-backed) and add B to `agents[]`
 *     with `parent = oldRootJobId` (A literally ran the spawn — provenance).
 *  2. Add `spawned_by B→A` edge (immutable provenance).
 *  3. Set `record.root_node_id = B`.
 *  4. Re-point every `reports_to X→A` edge to `X→B` and update each
 *     affected agent's `report_to` array A→B. `spawned_by` / other edge
 *     types are left intact.
 *  5. Add `handoff_to A→B` edge (records the promotion).
 *
 * Returns `{ rePointedChildren }` — the list of children whose `report_to`
 * was updated (jobId + new array). The caller MUST call `recordJobReportTo`
 * for each to keep the job-layer routing in sync with the graph (Step 5.2).
 *
 * @param sessionId  Session to mutate.
 * @param cwd        Session namespace cwd (same as the spawner's sessionCwd).
 * @param opts.newRoot  B's job data needed to append the node + agent record.
 * @param opts.oldRootJobId  A's job id (current root being stepped down).
 */
export function promoteRoot(
  sessionId: string,
  cwd: string | undefined,
  opts: {
    newRoot: {
      job_id: string;
      pane_id: string;
      cwd: string;
      name: string;
      agent: string;
      host_session_id: string | null;
      title?: string;
      created?: string;
    };
    oldRootJobId: string;
  },
): { rePointedChildren: Array<{ jobId: string; newReportTo: string[] }> } {
  const dir = sessionDir(sessionId, cwd);
  return withSessionLock(dir, (): { rePointedChildren: Array<{ jobId: string; newReportTo: string[] }> } => {
    const mp = sessionMetaPath(sessionId, cwd);
    if (!existsSync(mp)) {
      throw general(
        `session not found: ${sessionId} — call ensureSession first`,
        { session_id: sessionId },
      );
    }
    let record: SessionRecord;
    try {
      record = JSON.parse(readFileSync(mp, 'utf8')) as SessionRecord;
    } catch {
      throw general(`failed to parse session.json for ${sessionId}`, { session_id: sessionId });
    }

    normalizeSessionRecord(record);

    const bJobId = opts.newRoot.job_id;
    const aJobId = opts.oldRootJobId;
    const created = opts.newRoot.created ?? new Date().toISOString();
    const title = opts.newRoot.title ?? opts.newRoot.name;

    // 1. Append B's node (kind:'agent', job-backed).
    addNode(record, {
      node_id: bJobId,
      kind: 'agent',
      job_id: bJobId,
      pane_id: opts.newRoot.pane_id,
      cwd: opts.newRoot.cwd,
      created,
      host_session_id: opts.newRoot.host_session_id,
      label: opts.newRoot.name,
    });

    // Add B to agents[] — root has no report_to targets (forward:false).
    if (!record.agents.some((a) => a.job_id === bJobId)) {
      record.agents.push({
        job_id: bJobId,
        node_id: bJobId,
        parent: aJobId,     // A literally ran the spawn — provenance
        report_to: [],      // B is the new root: forwards to no one
        subscribes_to: [],
        name: opts.newRoot.name,
        agent: opts.newRoot.agent,
        pane_id: opts.newRoot.pane_id,
        cwd: opts.newRoot.cwd,
        created,
        title,
        host_session_id: opts.newRoot.host_session_id,
        status: 'running',
      });
    }

    // 2. Add spawned_by B→A edge (B was spawned by A; provenance, immutable).
    addEdge(record, 'spawned_by', bJobId, aJobId, created);

    // 3. Promote B to root.
    record.root_node_id = bJobId;

    // 4. Re-point every reports_to X→A edge to X→B.
    //    Also update each affected agent's in-memory report_to array A→B.
    //    spawned_by / subscribes_to / handoff_to edges are left intact.
    record.edges ??= [];
    const rePointedChildren: Array<{ jobId: string; newReportTo: string[] }> = [];
    const newEdges: SessionEdge[] = [];
    const seenEdgeIds = new Set<string>();

    for (const edge of record.edges) {
      if (edge.type === 'reports_to' && edge.to === aJobId) {
        // Re-point to B (deduplicate in case the array already has both variants).
        const newId = edgeId('reports_to', edge.from, bJobId);
        if (!seenEdgeIds.has(newId)) {
          seenEdgeIds.add(newId);
          newEdges.push({ edge_id: newId, type: 'reports_to', from: edge.from, to: bJobId, created: edge.created });
        }
        // Update the corresponding agent's report_to array.
        const agent = record.agents.find(
          (a) => (a.node_id ?? a.job_id) === edge.from,
        );
        if (agent !== undefined) {
          agent.report_to = (agent.report_to ?? []).map((t) => (t === aJobId ? bJobId : t));
          rePointedChildren.push({ jobId: agent.job_id, newReportTo: [...agent.report_to] });
        }
      } else {
        if (!seenEdgeIds.has(edge.edge_id)) {
          seenEdgeIds.add(edge.edge_id);
          newEdges.push(edge);
        }
      }
    }
    record.edges = newEdges;

    // 5. Add handoff_to A→B (records the promotion without losing that A preceded B).
    addEdge(record, 'handoff_to', aJobId, bJobId, created);

    const tmp = join(dir, '.session.tmp');
    writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    renameSync(tmp, mp);

    return { rePointedChildren };
  });
}

// Re-export TelemetryRec so consumers that import from sessions.ts don't also
// need to import from jobs.ts for the type.
export type { TelemetryRec };
