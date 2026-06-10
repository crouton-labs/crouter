// injected-store.ts — durable per-node dedup set for on-read doc injection.
//
// The on-read substrate hook (canvas-doc-substrate.ts → renderOnReadDocs) dedups
// so a given doc surfaces at most once per conversation. That set USED to live
// only in the pi process heap, cleared on session_start. But a node's logical
// session — the .jsonl transcript — spans MULTIPLE pi processes: a dormancy →
// revive(resume) cycle exits the old process and launches a fresh `pi --session`
// that REUSES the same transcript. The fresh process started with an empty set,
// so any doc already injected before dormancy got injected AGAIN on the next
// read — the "fires a second time per session" bug.
//
// This module persists the set to `nodes/<id>/injected-docs.json` so the resumed
// process rehydrates it and skips docs already present in the transcript. The
// launch paths that begin a FRESH transcript (reviveNode resume=false,
// reviveInPlace, relaunchRootInPane — all in runtime/revive.ts) call
// clearInjectedDocs(), so a new conversation starts with an empty set.
//
// All ops are best-effort: a failed read/write degrades to a possible re-inject,
// never a crash — a dedup miss must never break a read or a revive.

import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { injectedDocsPath } from '../canvas/paths.js';

/** Rehydrate a node's on-read dedup set from disk. Returns an empty set when the
 *  file is absent, unreadable, or malformed (a fresh transcript, or a node that
 *  has not yet surfaced any on-read doc). */
export function loadInjectedDocs(nodeId: string): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(injectedDocsPath(nodeId), 'utf8')) as unknown;
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === 'string'));
  } catch {
    return new Set();
  }
}

/** Persist a node's on-read dedup set. Called after each read that surfaced a
 *  new doc, so the grown set survives a later dormancy. */
export function saveInjectedDocs(nodeId: string, seen: Set<string>): void {
  try {
    writeFileSync(injectedDocsPath(nodeId), JSON.stringify([...seen]));
  } catch {
    // best-effort — a failed persist only risks a re-inject, never a crash
  }
}

/** Drop a node's persisted dedup set. Called by the launch paths that start a
 *  FRESH transcript, so the new conversation surfaces docs from scratch. */
export function clearInjectedDocs(nodeId: string): void {
  try {
    rmSync(injectedDocsPath(nodeId), { force: true });
  } catch {
    // ignore — absence is the desired state anyway
  }
}
