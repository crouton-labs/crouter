// The roadmap — one document, two temperatures. A small frozen core (goal +
// exit criteria) and an evolving body (scope, strategy, active context) the
// owner keeps current. It holds how you intend to reach the goal and where you
// are right now — not a journal of what you did or a queue of what's next. It
// is what lets a resident node survive a refresh-yield: revive with no memory,
// re-read the map, continue.
//
// Written at resident-promotion (a born-resident root, or a spawned node's
// first refresh-with-open-work). Leaf/terminal workers write nothing.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { contextDir } from '../canvas/index.js';

export function roadmapPath(nodeId: string): string {
  return join(contextDir(nodeId), 'roadmap.md');
}

export function hasRoadmap(nodeId: string): boolean {
  return existsSync(roadmapPath(nodeId));
}

export function readRoadmap(nodeId: string): string | null {
  const p = roadmapPath(nodeId);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

/** Seed a fresh, EXTREMELY BAREBONES roadmap scaffold — just the section
 *  skeleton with one-line prompts. Promotion lays this down so the file exists
 *  for a refresh; the owner fleshes it out as its next act (guided by its
 *  roadmap memory doc). `goal`/`exitCriteria` pre-fill those sections when
 *  known (e.g. from the node's goal doc). Idempotent only if you intend it —
 *  call sites guard on hasRoadmap to avoid clobbering an evolved map. */
export function seedRoadmap(nodeId: string, opts: { goal?: string; exitCriteria?: string } = {}): string {
  const dir = contextDir(nodeId);
  mkdirSync(dir, { recursive: true });
  const body = `# Roadmap

## Goal
${opts.goal?.trim() ?? '(the goal you now own)'}

## Exit criteria
${opts.exitCriteria?.trim() ?? '(what "done" looks like)'}

## Phases
(ordered phases from here to done; the current one carries a one-line status)
`;
  writeFileSync(roadmapPath(nodeId), body);
  return body;
}
