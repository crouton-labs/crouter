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

/** Seed a fresh roadmap SCAFFOLD. No goal is required — promotion lays this
 *  down so the file exists for a refresh, and the owner authors the goal +
 *  body as its next act (guided by its kind's roadmap skill). `goal`/
 *  `exitCriteria` are optional overrides. Idempotent only if you intend it —
 *  call sites guard on hasRoadmap to avoid clobbering an evolved map. */
export function seedRoadmap(nodeId: string, opts: { goal?: string; exitCriteria?: string } = {}): string {
  const dir = contextDir(nodeId);
  mkdirSync(dir, { recursive: true });
  const body = `# Roadmap

<!-- frozen core: set once, rarely changes -->
## Goal
${opts.goal?.trim() ?? '- (state the high-level goal you now own — write this as your first act)'}

## Exit criteria
${opts.exitCriteria?.trim() ?? '- (define what "done" looks like)'}

<!-- evolving body: keep this current as you learn scope + intent -->
## Scope assumptions / non-goals
- (record what's out of scope and what's settled — e.g. "reuse existing auth", "security isn't a concern here" — so children inherit the framing)

## Strategy / phases
- (your high-level shape of how you reach the goal; the ordered phases from here to done, the current one carrying a one-line status. Each phase can become a child whose own roadmap is that phase)

## Active context
- (the context/ files currently relevant to the work, by path; none yet)
`;
  writeFileSync(roadmapPath(nodeId), body);
  return body;
}
