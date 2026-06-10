// `canvas history` — search and recall the canvas's record of past work in a
// cwd. The accumulated episodic record of every node that ran here and the
// artifacts it left: its reports (final/update/urgent outcome summaries) and
// context docs (specs, designs, roadmaps, findings). Distinct from `crtr
// memory`, which is curated semantic knowledge held independent of any episode.
// This branch owns CONTENT; it never duplicates the graph (use `canvas revive`
// to reopen a found node, `node inspect show` for its topology).

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { searchLeaf } from './canvas-history/search.js';
import { readLeaf } from './canvas-history/read.js';
import { showLeaf } from './canvas-history/show.js';
import { callerCwd, corpusStats } from '../core/canvas/index.js';

/** The bounded per-cwd `<corpus>` aggregate for the branch -h — pre-empts a
 *  `search` call just to gauge the corpus (cli-design §15: aggregate, never
 *  enumerate). Soft-fails to omission if the db is unreachable. */
function corpusBlock(): string | null {
  const cwd = callerCwd();
  const s = corpusStats(cwd);
  const span = s.span !== null ? `${s.span.from} → ${s.span.to}` : 'n/a';
  return `<corpus cwd="${cwd}" nodes="${s.nodes}" reports="${s.reports}" docs="${s.docs}" span="${span}"/>`;
}

export const historyBranch: BranchDef = defineBranch({
  name: 'history',
  description: 'search and recall the canvas\'s record of past work in this cwd',
  whenToUse:
    'you want to find or re-read what was DONE in a cwd — a past design, a final report, a roadmap, a finding — across every node that ran there. Use it when picking up prior work ("that caching work from last week"), recovering an artifact, or surveying a project\'s history. Distinct from `crtr memory` (curated semantic knowledge, not episodes) and from `canvas dashboard`/`node inspect` (graph topology, not content).',
  help: {
    name: 'canvas history',
    summary: 'search and recall the canvas\'s record of past work in this cwd',
    model:
      'The accumulated record of every node that ran in a cwd and the artifacts it left — its reports (final/update outcome summaries) and context docs (specs, designs, roadmaps, findings). `search` finds by content (ranked, filtered, sorted; omit the query to browse by recency); `read` pulls one hit\'s full body by its <node-id>:<relpath> ref; `show` lists everything one node left. This is the episodic record of what was DONE — distinct from `crtr memory`, which is curated semantic knowledge. To reopen a node you found, use `canvas revive`; for its place in the graph, `node inspect show`.',
    dynamicState: corpusBlock,
  },
  children: [searchLeaf, readLeaf, showLeaf],
});
