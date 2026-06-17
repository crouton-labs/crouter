// decks.ts — the bridge-native humanloop deck data layer (design §"Deck list,
// detail, and resolve"). Reads/writes go through `crtr human list/deck/resolve
// --json`; this module maps command output onto the UI's DeckSummary /
// DeckDetail shapes. The deck-gone race (resolved elsewhere) surfaces as a
// CommandError with code `not_found` | `already_resolved` | `claimed` — callers
// self-clear on it.

import type {
  DeckDetail,
  DeckInteraction,
  DeckKind,
  DeckOption,
  DeckSummary,
  ResolveDeckRequest,
  ResolveDeckResponse,
} from '@/shared/protocol.js';
import { CommandError, crtrJson, getNode } from '../command-client.js';

/** True for the deck-gone race: an ask resolved/claimed elsewhere. Callers
 *  self-clear instead of erroring. */
export function isDeckGone(err: unknown): boolean {
  return (
    err instanceof CommandError &&
    (err.code === 'not_found' || err.code === 'already_resolved' || err.code === 'claimed')
  );
}

// ---------------------------------------------------------------------------
// Command output shapes (humanloop → web)
// ---------------------------------------------------------------------------

interface DeckListItemResponse {
  id: string;
  job_id: string;
  title: string;
  kind: string;
  blocked_since: string;
  asking_node_id: string;
  asking_node_name: string;
  conversation_id: string;
  conversation_title: string;
  interaction_count: number;
  dir: string;
}

type DeckListResponse = { items: DeckListItemResponse[] };

interface DeckDetailResponse {
  id: string;
  job_id?: string;
  title: string;
  kind: string;
  blocked_since: string;
  asking_node_id: string;
  asking_node_name: string;
  conversation_id: string;
  conversation_title: string;
  interaction_count: number;
  interactions: Array<{
    id: string;
    kind: string;
    prompt: string;
    options: Array<{ id: string; label: string; description?: string }>;
    multiSelect: boolean;
    allow_freetext: boolean;
  }>;
}

type DeckInteractionResponse = DeckDetailResponse['interactions'][number];

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function interactionDirToCwd(dir: string): string {
  const marker = '/.crouter/interactions/';
  const idx = dir.indexOf(marker);
  return idx >= 0 ? dir.slice(0, idx) : dir;
}

function splitPrompt(prompt: string): { title: string; body?: string } {
  if (prompt.trim() === '') return { title: '' };
  const m = prompt.match(/^\s*#{1,6}\s+(.+?)\s*(?:\n|$)/);
  if (!m) return { title: prompt.trim(), body: prompt.trim() };
  return { title: m[1], body: prompt.slice(m[0].length).trim() || undefined };
}

function normalizeDeckKind(kind: string): DeckKind {
  switch (kind) {
    case 'notify':
    case 'validation':
    case 'decision':
    case 'context':
    case 'error':
      return kind;
  }
  throw new Error(`Unknown deck kind: ${kind}`);
}

function mapDeckInteraction(item: DeckInteractionResponse): DeckInteraction {
  const { title, body } = splitPrompt(item.prompt);
  return {
    id: item.id,
    title: title || item.id,
    body,
    kind: normalizeDeckKind(item.kind),
    options: item.options.map((o): DeckOption => ({
      id: o.id,
      label: o.label,
      ...(o.description !== undefined ? { description: o.description } : {}),
    })),
    multiSelect: item.multiSelect,
    allowFreetext: item.allow_freetext,
  };
}

function mapDeckSummary(raw: DeckListItemResponse): DeckSummary {
  return {
    id: raw.id,
    job_id: raw.job_id,
    kind: normalizeDeckKind(raw.kind),
    title: raw.title,
    blocked_since: raw.blocked_since,
    conversation_id: raw.conversation_id,
    conversation_title: raw.conversation_title,
    asking_node_id: raw.asking_node_id,
    asking_node_name: raw.asking_node_name,
    cwd: interactionDirToCwd(raw.dir),
    interaction_count: raw.interaction_count,
  };
}

function mapDeckDetail(raw: DeckDetailResponse, cwd: string): DeckDetail {
  return {
    id: raw.id,
    job_id: raw.job_id ?? raw.id,
    kind: normalizeDeckKind(raw.kind),
    title: raw.title,
    blocked_since: raw.blocked_since,
    conversation_id: raw.conversation_id,
    conversation_title: raw.conversation_title,
    asking_node_id: raw.asking_node_id,
    asking_node_name: raw.asking_node_name,
    cwd,
    interaction_count: raw.interaction_count,
    interactions: raw.interactions.map(mapDeckInteraction),
  };
}

// ---------------------------------------------------------------------------
// Data access — `crtr human list/deck/resolve --json`
// ---------------------------------------------------------------------------

export async function getDecks(): Promise<DeckSummary[]> {
  const body = await crtrJson<DeckListResponse>(['human', 'list', '--json']);
  return body.items.map(mapDeckSummary);
}

export async function getDeck(id: string): Promise<DeckDetail> {
  const raw = await crtrJson<DeckDetailResponse>(['human', 'deck', id, '--json']);
  const cwd = (await getNode(raw.asking_node_id)).cwd;
  return mapDeckDetail(raw, cwd);
}

type ResolveResult = { resolved?: boolean; job_id?: string; delivered?: boolean; reason?: string };

export async function resolveDeck(id: string, req: ResolveDeckRequest): Promise<ResolveDeckResponse> {
  const body = JSON.stringify({ responses: req.responses });
  const result = await crtrJson<ResolveResult>(['human', 'resolve', id, '--json'], body);
  if (result.resolved !== true) {
    throw new CommandError(
      result.reason === 'claimed' ? 'claimed' : 'already_resolved',
      result.reason === 'claimed' ? 'That request is already being handled.' : 'That request was already handled.',
    );
  }
  return { resolved: true, job_id: result.job_id ?? id, delivered: result.delivered ?? true };
}
