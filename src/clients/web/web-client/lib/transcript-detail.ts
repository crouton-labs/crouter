/**
 * Transcript-detail store (design contract §4) — the in-console "Detail" axis,
 * distinct from profile `density` (app-chrome layout). One operator preference,
 * GLOBAL across nodes: a standalone localStorage-backed module store (no React
 * provider) so the con-head control (S2, node-page.tsx) and the stream blocks
 * (S3) read/write the same value.
 *
 * Levels — what each shows (see the §4 table; consumed by tool cards, thinking
 * blocks, and prose spacing):
 *   focused  — tool cards one-line, thinking hidden, prose tight
 *   standard — current behavior (default)
 *   verbose  — tool cards expanded, thinking inline, prose generous
 */

import { useSyncExternalStore } from 'react';

export type TranscriptDetail = 'focused' | 'standard' | 'verbose';

const KEY = 'crtr:transcript-detail';
const ORDER: TranscriptDetail[] = ['focused', 'standard', 'verbose'];

function read(): TranscriptDetail {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'focused' || v === 'standard' || v === 'verbose') return v;
  } catch {
    // localStorage unavailable
  }
  return 'standard';
}

let current: TranscriptDetail = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Set the global detail level; persists and notifies all subscribers. */
export function setTranscriptDetail(d: TranscriptDetail): void {
  if (d === current) return;
  current = d;
  try {
    localStorage.setItem(KEY, d);
  } catch {
    // localStorage unavailable
  }
  emit();
}

/** Cycle focused → standard → verbose → (wrap). */
export function cycleTranscriptDetail(): void {
  const i = ORDER.indexOf(current);
  setTranscriptDetail(ORDER[(i + 1) % ORDER.length]!);
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// Cross-tab / cross-node sync: another node writing the key updates us live.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    const v = read();
    if (v !== current) {
      current = v;
      emit();
    }
  });
}

/** Reactive read of the current global detail level. */
export function useTranscriptDetail(): TranscriptDetail {
  return useSyncExternalStore(subscribe, () => current, () => current);
}
