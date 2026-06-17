/*
 * Phase-4 deletion seam only.
 *
 * Temporary source-compatible adapter for the folded crouter-web client. This
 * file is allowed to exist only while the moved pages/stores are being rewired
 * onto the in-tree bridge and broker primitives. It must not fetch bridge/* or
 * open socket/*; all reads/writes go through /__crtr/source and the existing crtr
 * command bridge.
 */

import type {
  CanvasSnapshot,
  CloseResponse,
  Command,
  DeckDetail,
  DeckInteraction,
  DeckKind,
  DeckOption,
  DeckSummary,
  MessageRequest,
  MessageResponse,
  NodeDetail,
  ResolveDeckRequest,
  ResolveDeckResponse,
  ReviveRequest,
  ReviveResponse,
  RestErrorCode,
  SpawnRequest,
  SpawnResponse,
} from '@/shared/protocol.js';
import { crtrCommand, sourceRequest } from '../command-client.js';
import type { BrokerSnapshot } from '../protocol.js';
import type { RawResponse } from '../../../../core/view/contract.js';

export class RestError extends Error {
  readonly code: RestErrorCode;
  constructor(code: RestErrorCode, message: string) {
    super(message);
    this.name = 'RestError';
    this.code = code;
  }
}

export interface NodeSnapshotResponse {
  node_id: string;
  snapshot: BrokerSnapshot;
  commands: Command[];
}

/** A view roster entry — the in-tree core-contract manifest shape surfaced by
 *  `crtr view list --json` (and the bundled builtin registry). Builtin views are
 *  not node-authored, so there is no `built_by`/`status`/`tabs` here. */
export interface ViewSummary {
  id: string;
  title: string;
  description?: string;
  scope?: string;
}

type ViewListResponse = { views?: ViewSummary[] } | ViewSummary[];
type DeckListResponse = { items?: unknown[]; decks?: unknown[] } | unknown[];
type DeckDetailResponse = {
  id?: string;
  job_id?: string;
  title?: string | null;
  kind?: string | null;
  blocked_since?: string | null;
  asking_node_id?: string;
  asking_node_name?: string;
  conversation_id?: string;
  conversation_title?: string;
  interaction_count?: number;
  interactions?: Array<{
    id: string;
    kind?: string | null;
    prompt?: string;
    title?: string;
    options?: Array<{ id: string; label: string; description?: string }>;
    multiSelect?: boolean;
    allow_freetext?: boolean;
    default_option_id?: string;
  }>;
};

type ResolveResult = { resolved?: boolean; job_id?: string; delivered?: boolean; reason?: string };

function asRestError(err: unknown, fallback: RestErrorCode = 'bad_request'): RestError {
  if (err instanceof RestError) return err;
  return new RestError(fallback, err instanceof Error ? err.message : String(err));
}

function unwrap<T>(value: T | { ok?: boolean; error?: { code?: RestErrorCode; message?: string } }): T {
  if (value && typeof value === 'object' && 'error' in value && value.error) {
    throw new RestError(value.error.code ?? 'bad_request', value.error.message ?? 'request failed');
  }
  if (value && typeof value === 'object' && 'ok' in value && value.ok === false) {
    throw new RestError('bad_request', 'request failed');
  }
  return value as T;
}

async function commandJson<T>(args: string[], stdin?: string, mapErrorCode?: (code: string) => RestErrorCode): Promise<T> {
  try {
    const raw = await crtrCommand(args, stdin);
    if (!raw.ok) throw new RestError('bad_request', raw.stderr || 'bridge request failed');
    const structuredError = parseCommandError(raw);
    if (structuredError !== null) {
      const code = mapErrorCode?.(structuredError.code);
      throw new RestError(code ?? (REST_ERROR_CODES.has(structuredError.code as RestErrorCode) ? (structuredError.code as RestErrorCode) : 'bad_request'), structuredError.message);
    }
    if (raw.exitCode !== undefined && raw.exitCode !== 0) {
      throw new RestError('bad_request', raw.stderr || `crtr ${args.join(' ')} failed (${raw.exitCode})`);
    }
    if (raw.stdout.trim() === '') return undefined as T;
    return unwrap(JSON.parse(raw.stdout) as T);
  } catch (err) {
    throw asRestError(err);
  }
}

async function sourceFile(path: string): Promise<RawResponse> {
  return sourceRequest({ kind: 'file', path });
}

function interactionDirToCwd(dir: string): string {
  const marker = '/.crouter/interactions/';
  const idx = dir.indexOf(marker);
  return idx >= 0 ? dir.slice(0, idx) : dir;
}

function splitPrompt(prompt: string | undefined): { title: string; body?: string } {
  if (prompt === undefined || prompt.trim() === '') return { title: '' };
  const m = prompt.match(/^\s*#{1,6}\s+(.+?)\s*(?:\n|$)/);
  if (!m) return { title: prompt.trim(), body: prompt.trim() };
  return { title: m[1], body: prompt.slice(m[0].length).trim() || undefined };
}

function normalizeDeckKind(kind: string | null | undefined): DeckKind {
  switch (kind) {
    case 'notify':
    case 'validation':
    case 'decision':
    case 'context':
    case 'error':
      return kind;
    default:
      return 'context';
  }
}

function normalizeResolveResponses(responses: ResolveDeckRequest['responses']): ResolveDeckRequest['responses'] {
  return responses.map((response) => {
    if (response.selectedOptionIds !== undefined) return response;
    if (response.selectedOptionId === undefined) return response;
    const { selectedOptionId, ...rest } = response;
    return { ...rest, selectedOptionIds: [selectedOptionId] };
  });
}

const REST_ERROR_CODES = new Set<RestErrorCode>([
  'bad_request',
  'node_not_found',
  'not_enterable',
  'no_command_source',
  'spawn_failed',
  'revive_failed',
  'close_failed',
  'message_failed',
  'deck_not_found',
  'deck_already_resolved',
  'resolve_failed',
]);

type ParsedCommandError = { code: string; message: string };

function parseCommandError(raw: RawResponse): ParsedCommandError | null {
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

type DeckInteractionResponse = NonNullable<DeckDetailResponse['interactions']>[number];

function mapDeckInteraction(item: DeckInteractionResponse): DeckInteraction {
  const prompt = item.prompt ?? item.title ?? '';
  const { title, body } = splitPrompt(prompt);
  return {
    id: item.id,
    title: title || item.kind || item.id,
    body,
    kind: normalizeDeckKind(item.kind),
    options: (item.options ?? []).map((o): DeckOption => ({
      id: o.id,
      label: o.label,
      ...(o.description !== undefined ? { description: o.description } : {}),
    })),
    multiSelect: item.multiSelect ?? false,
    allowFreetext: item.allow_freetext ?? false,
  };
}

function mapDeckSummary(raw: unknown): DeckSummary | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as {
    id?: string;
    job_id?: string;
    title?: string | null;
    kind?: string | null;
    blocked_since?: string | null;
    asking_node_id?: string;
    asking_node_name?: string;
    conversation_id?: string;
    conversation_title?: string;
    interaction_count?: number;
    dir?: string;
  };
  if (typeof item.id !== 'string' || typeof item.job_id !== 'string' || typeof item.blocked_since !== 'string') return null;
  const title = item.title ?? item.kind ?? item.id;
  const askingNodeId = item.asking_node_id ?? item.id;
  const askingNodeName = item.asking_node_name ?? item.id;
  const conversationId = item.conversation_id ?? askingNodeId;
  const conversationTitle = item.conversation_title ?? item.asking_node_name ?? item.title ?? item.id;
  const cwd = item.dir !== undefined ? interactionDirToCwd(item.dir) : '';
  return {
    id: item.id,
    job_id: item.job_id,
    kind: normalizeDeckKind(item.kind),
    title,
    blocked_since: item.blocked_since,
    conversation_id: conversationId,
    conversation_title: conversationTitle,
    asking_node_id: askingNodeId,
    asking_node_name: askingNodeName,
    cwd,
    interaction_count: item.interaction_count ?? 0,
  };
}

function mapDeckDetail(raw: DeckDetailResponse, cwd: string): DeckDetail {
  const first = raw.interactions?.[0];
  const title = raw.title ?? first?.title ?? first?.prompt ?? raw.id ?? '';
  const kind = normalizeDeckKind(raw.kind ?? first?.kind);
  const askingNodeId = raw.asking_node_id ?? raw.id ?? '';
  const askingNodeName = raw.asking_node_name ?? askingNodeId;
  const conversationId = raw.conversation_id ?? askingNodeId;
  const conversationTitle = raw.conversation_title ?? raw.title ?? askingNodeName;
  const interactions = (raw.interactions ?? []).map(mapDeckInteraction);
  const jobId = raw.job_id ?? raw.id ?? askingNodeId;
  return {
    id: raw.id ?? jobId,
    job_id: jobId,
    kind,
    title,
    subtitle: undefined,
    blocked_since: raw.blocked_since ?? '',
    conversation_id: conversationId,
    conversation_title: conversationTitle,
    asking_node_id: askingNodeId,
    asking_node_name: askingNodeName,
    cwd,
    interaction_count: raw.interaction_count ?? interactions.length,
    interactions,
  };
}

export async function getCanvas(): Promise<CanvasSnapshot> {
  return commandJson<CanvasSnapshot>(['canvas', 'snapshot', '--json']);
}

export async function getNode(id: string): Promise<NodeDetail> {
  return commandJson<NodeDetail>(['node', 'inspect', 'show', id, '--json']);
}

export async function getNodeSnapshot(id: string): Promise<NodeSnapshotResponse> {
  return commandJson<NodeSnapshotResponse>(['node', 'snapshot', id, '--json']);
}

export function spawnNode(req: SpawnRequest): Promise<SpawnResponse> {
  const args = ['node', 'new', '--kind', req.kind, '--json'];
  if (req.name?.trim()) args.splice(4, 0, '--name', req.name.trim());
  if (req.cwd?.trim()) args.splice(4, 0, '--cwd', req.cwd.trim());
  return commandJson<SpawnResponse>(args, req.prompt);
}

export function messageNode(id: string, req: MessageRequest): Promise<MessageResponse> {
  return commandJson<MessageResponse>(['node', 'msg', id, '--json'], JSON.stringify(req));
}

export function reviveNode(id: string, req: ReviveRequest = {}): Promise<ReviveResponse> {
  return commandJson<ReviveResponse>(['canvas', 'revive', id, '--json'], Object.keys(req).length ? JSON.stringify(req) : undefined);
}

export function closeNode(id: string): Promise<CloseResponse> {
  return commandJson<CloseResponse>(['node', 'close', '--node', id, '--json']);
}

export async function getDecks(): Promise<DeckSummary[]> {
  const body = await commandJson<DeckListResponse>(['human', 'list', '--json']);
  const items = Array.isArray(body) ? body : body.items ?? body.decks ?? [];
  return items.map(mapDeckSummary).filter((item): item is DeckSummary => item !== null);
}

export async function getDeck(id: string): Promise<DeckDetail> {
  const raw = await commandJson<DeckDetailResponse>(['human', 'deck', id, '--json'], undefined, (code) => {
    switch (code) {
      case 'not_found': return 'deck_not_found';
      case 'already_resolved':
      case 'claimed': return 'deck_already_resolved';
      default: return 'bad_request';
    }
  });
  const cwd = raw.asking_node_id ? (await getNode(raw.asking_node_id)).cwd : '';
  return mapDeckDetail(raw, cwd);
}

export function resolveDeck(id: string, req: ResolveDeckRequest): Promise<ResolveDeckResponse> {
  const body = JSON.stringify({ responses: normalizeResolveResponses(req.responses) });
  return commandJson<ResolveResult>(['human', 'resolve', id, '--json'], body, (code) => {
    switch (code) {
      case 'not_found': return 'deck_not_found';
      case 'already_resolved':
      case 'claimed': return 'deck_already_resolved';
      default: return 'bad_request';
    }
  }).then((result) => {
    if (result.resolved !== true) {
      throw new RestError('deck_already_resolved', result.reason === 'claimed' ? 'That request is already being handled.' : 'That request was already handled.');
    }
    return { resolved: true, job_id: result.job_id ?? id, delivered: result.delivered ?? true };
  });
}

export interface FilePeekResponse {
  path: string;
  content: string;
  truncated: boolean;
}

export async function peekFile(nodeId: string, filePath: string): Promise<FilePeekResponse> {
  const res = await sourceFile(filePath);
  if (!res.ok) throw new RestError('bad_request', res.stderr || `failed to read ${filePath}`);
  return { path: filePath, content: res.stdout, truncated: false };
}

export async function listViews(): Promise<ViewSummary[]> {
  const body = await commandJson<ViewListResponse>(['view', 'list', '--json']);
  const rows = Array.isArray(body) ? body : body.views ?? [];
  return rows.map((r) => ({ id: r.id, title: r.title, description: r.description, scope: r.scope }));
}
