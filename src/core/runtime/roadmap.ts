// The roadmap — one document, two temperatures. A small frozen core (goal +
// exit criteria) and an evolving body (scope, strategy, progress) the owner
// keeps current. It is what lets a resident node survive a refresh-yield:
// revive with no memory, re-read the map, continue.
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

/** Seed a fresh roadmap. `goal` is the frozen core; the rest is scaffold the
 *  owner fills in as scope clarifies. Idempotent only if you intend it — call
 *  sites guard on hasRoadmap to avoid clobbering an evolved map. */
export function seedRoadmap(nodeId: string, goal: string, exitCriteria?: string): string {
  const dir = contextDir(nodeId);
  mkdirSync(dir, { recursive: true });
  const body = `# Roadmap

<!-- frozen core: set once, rarely changes -->
## Goal
${goal.trim()}

## Exit criteria
${exitCriteria?.trim() ?? '- (define what "done" looks like)'}

<!-- evolving body: keep this current as you learn scope + intent -->
## Scope assumptions / non-goals
- (record what's out of scope and what's settled — e.g. "reuse existing auth", "security isn't a concern here" — so children inherit the framing)

## Strategy / phases
- (your high-level shape of work; each phase can become a child whose own roadmap is that phase)

## Progress log
- ${new Date().toISOString()} — promoted to resident orchestrator; roadmap seeded
`;
  writeFileSync(roadmapPath(nodeId), body);
  return body;
}

/** Append a dated line to the progress log (best-effort; appends to the file
 *  end if the section anchor isn't found). */
export function logProgress(nodeId: string, line: string): void {
  const p = roadmapPath(nodeId);
  if (!existsSync(p)) return;
  const stamp = `- ${new Date().toISOString()} — ${line.trim()}\n`;
  const cur = readFileSync(p, 'utf8');
  writeFileSync(p, cur.endsWith('\n') ? cur + stamp : `${cur}\n${stamp}`);
}
