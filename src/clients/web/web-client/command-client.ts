// command-client.ts — the browser's bridge-native data layer (design §"Client
// adapter rewrite"). Every read/write is a sanctioned `crtr … --json` subprocess
// the bridge runs: the browser POSTs a SourceRequest to /__crtr/source, the
// bridge runs `crtr …` in the server's cwd, and that subprocess is the one
// sanctioned writer. The browser never talks to REST or WS; in-conversation
// driving rides broker frames through `useBroker`, while graph mutations
// (spawn/msg/revive/close), reads (canvas/node/snapshot/views), and file peeks
// all flow through here.

import type { RawResponse, SourceRequest } from '../../../core/view/contract.js';
import type {
  CanvasSnapshot,
  CloseResponse,
  Command,
  MessageRequest,
  MessageResponse,
  NodeDetail,
  ReviveRequest,
  ReviveResponse,
  SpawnRequest,
  SpawnResponse,
} from '@/shared/protocol.js';
import type { BrokerSnapshot } from './protocol.js';

// ---------------------------------------------------------------------------
// Low-level bridge transport
// ---------------------------------------------------------------------------

export async function sourceRequest(req: SourceRequest): Promise<RawResponse> {
  try {
    const res = await fetch('/__crtr/source', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
    });
    if (!res.ok) return { ok: false, stdout: '', stderr: `bridge ${res.status} ${res.statusText}` };
    return (await res.json()) as RawResponse;
  } catch (e) {
    return { ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) };
  }
}

/** Run `crtr <args>` through the bridge, optionally feeding `stdin`. Returns the
 *  RawResponse the bridge ran on our behalf (never throws — a transport failure
 *  comes back as ok:false). */
export async function crtrCommand(args: string[], stdin?: string): Promise<RawResponse> {
  const req: SourceRequest = { kind: 'exec', bin: 'crtr', args, ...(stdin !== undefined ? { stdin } : {}) };
  return sourceRequest(req);
}

// ---------------------------------------------------------------------------
// Command error
// ---------------------------------------------------------------------------

/** A `crtr` command that ran but failed — carries the structured `error` code a
 *  `--json` leaf emits (e.g. `not_found`, `already_resolved`, `claimed`) so
 *  callers can branch on the deck-gone race without a separate route taxonomy. A bare
 *  transport/parse failure surfaces as code `bridge`. */
export class CommandError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CommandError';
    this.code = code;
  }
}

/** A `--json` leaf signals failure as `{error:<code>, message:<text>}` on stdout
 *  with a non-zero exit. Parse that envelope (else null). */
function parseCommandError(raw: RawResponse): { code: string; message: string } | null {
  const text = raw.stdout.trim();
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.error === 'string' && typeof parsed.message === 'string') {
      return { code: parsed.error, message: parsed.message };
    }
  } catch {
    // not a structured error
  }
  return null;
}

/** Run `crtr <args> --json` and parse the structured result, throwing a
 *  `CommandError` on any transport/command/parse failure. The single read/write
 *  helper every typed function below is built on. */
export async function crtrJson<T>(args: string[], stdin?: string): Promise<T> {
  const raw = await crtrCommand(args, stdin);
  if (!raw.ok) throw new CommandError('bridge', raw.stderr || 'bridge request failed');
  const structured = parseCommandError(raw);
  if (structured !== null) throw new CommandError(structured.code, structured.message);
  if (raw.exitCode !== undefined && raw.exitCode !== 0) {
    throw new CommandError('bridge', raw.stderr || `crtr ${args.join(' ')} failed (${raw.exitCode})`);
  }
  if (raw.stdout.trim() === '') return undefined as T;
  try {
    return JSON.parse(raw.stdout) as T;
  } catch (e) {
    throw new CommandError('bridge', e instanceof Error ? e.message : String(e));
  }
}

// ---------------------------------------------------------------------------
// Canvas / node reads
// ---------------------------------------------------------------------------

export function getCanvas(): Promise<CanvasSnapshot> {
  return crtrJson<CanvasSnapshot>(['canvas', 'snapshot', '--json']);
}

interface InspectShowResponse {
  node: NodeDetail;
  reports: unknown[];
  managers: unknown[];
}

export function getNode(id: string): Promise<NodeDetail> {
  return crtrJson<InspectShowResponse>(['node', 'inspect', 'show', id, '--json']).then((body) => body.node);
}

/** Read-only dormant session snapshot (`crtr node snapshot`). `snapshot` is the
 *  broker-protocol `BrokerSnapshot`, fed through the same `applySnapshot` path as
 *  a live `welcome` frame. */
export interface NodeSnapshotResponse {
  node_id: string;
  snapshot: BrokerSnapshot;
  commands: Command[];
}

export function getNodeSnapshot(id: string): Promise<NodeSnapshotResponse> {
  return crtrJson<NodeSnapshotResponse>(['node', 'snapshot', id, '--json']);
}

// ---------------------------------------------------------------------------
// Graph writes — sanctioned `crtr` subprocesses (the only browser mutators)
// ---------------------------------------------------------------------------

/** Spawn a node: `crtr node new` with the first message on stdin. */
export function spawnNode(req: SpawnRequest): Promise<SpawnResponse> {
  const args = ['node', 'new', '--kind', req.kind];
  if (req.mode) args.push('--mode', req.mode);
  if (req.root) args.push('--root');
  if (req.cwd?.trim()) args.push('--cwd', req.cwd.trim());
  if (req.name?.trim()) args.push('--name', req.name.trim());
  if (req.model?.trim()) args.push('--model', req.model.trim());
  if (req.parent?.trim()) args.push('--parent', req.parent.trim());
  args.push('--json');
  return crtrJson<SpawnResponse>(args, req.prompt);
}

/** Inbox message: `crtr node msg <id>` with the body on stdin and tier as a flag. */
export function messageNode(id: string, req: MessageRequest): Promise<MessageResponse> {
  const args = ['node', 'msg', id];
  if (req.tier?.trim()) args.push('--tier', req.tier.trim());
  args.push('--json');
  return crtrJson<MessageResponse>(args, req.body);
}

/** Wake a dormant node: `crtr canvas revive <id>` → headless broker. */
export function reviveNode(id: string, req: ReviveRequest = {}): Promise<ReviveResponse> {
  const args = ['canvas', 'revive', id];
  if (req.fresh) args.push('--fresh');
  args.push('--json');
  return crtrJson<ReviveResponse>(args);
}

export function closeNode(id: string): Promise<CloseResponse> {
  return crtrJson<CloseResponse>(['node', 'close', '--node', id, '--json']);
}

// ---------------------------------------------------------------------------
// File peek — bridge file transport, not a node-scoped route
// ---------------------------------------------------------------------------

export interface FilePeekResponse {
  path: string;
  content: string;
  truncated: boolean;
}

export async function peekFile(_nodeId: string, filePath: string): Promise<FilePeekResponse> {
  const res = await sourceRequest({ kind: 'file', path: filePath });
  if (!res.ok) throw new CommandError('bridge', res.stderr || `failed to read ${filePath}`);
  return { path: filePath, content: res.stdout, truncated: false };
}

// ---------------------------------------------------------------------------
// Views — `crtr view list --json` (in-browser ViewHost renders the page itself)
// ---------------------------------------------------------------------------

/** A view roster entry — the in-tree core-contract manifest shape surfaced by
 *  `crtr view list --json` (and the bundled builtin registry). */
export interface ViewSummary {
  id: string;
  title: string;
  description?: string;
  scope?: string;
}

type ViewListResponse = { views?: ViewSummary[] } | ViewSummary[];

export async function listViews(): Promise<ViewSummary[]> {
  const body = await crtrJson<ViewListResponse>(['view', 'list', '--json']);
  const rows = Array.isArray(body) ? body : body.views ?? [];
  return rows.map((r) => ({ id: r.id, title: r.title, description: r.description, scope: r.scope }));
}
