// canvas-panels.ts — the subscribed-node panel for `crtr attach` (Unit Q).
//
// Native reimplementation of canvas-nav.ts's BASE chrome (renderBase), reading
// the subscription graph DIRECTLY from canvas.db via the shared nav-model layer
// (no pi extension host, no broker frame). Produces the two line stacks the
// viewer paints into Containers around the editor:
//   managers  → ABOVE the editor: this node's manager (its first subscriber).
//   reports   → BELOW the editor: this node's live reports (active|idle
//               subscriptions), plus a trailing ⚑ line for self's own asks.
//
// Pure: given a node id + the per-node ask map it returns ANSI strings; the
// caller owns the Containers and the refresh trigger. beginFrame() memoizes the
// canvas.db reads for this one build pass (mirrors canvas-nav's per-frame cache),
// so a whole panel rebuild is a single fan-out of disk/db reads.

import {
  beginFrame, cNode, managerOf, liveReports, climbRoot, computeSubtreeActivity,
  navLabel, coloredGlyph, truncate, tokensCell, cycleBadge, childBadge,
  liveBelowBadge, askBadge, activityCell,
  DIM, RESET, YELLOW,
} from '../../core/canvas/nav-model.js';

export interface CanvasPanelLines {
  /** Above-editor manager line(s) — empty for a root node (no manager). */
  managers: string[];
  /** Below-editor report row(s) + self's trailing ⚑ asks line — empty when none. */
  reports: string[];
}

/** Build the BASE panel line stacks for `nodeId` from canvas.db (ported verbatim
 *  from canvas-nav.ts renderBase). `asks` is the per-node pending-ask map the
 *  caller polls; pass `{}` to omit the ⚑ badges. */
export function buildCanvasPanelLines(nodeId: string, asks: Record<string, number>): CanvasPanelLines {
  // Fresh snapshot: drop the previous build's memoized reads so this pass sees
  // current disk+db state, then read-once within it.
  beginFrame();

  // One subtree-activity pass (rooted at the ancestry root) feeds the ⇣N
  // live-work-below badge on both the manager line and every report row.
  const activity = computeSubtreeActivity(climbRoot(nodeId), nodeId);

  const managers: string[] = [];
  const mgr = managerOf(nodeId);
  if (mgr !== undefined) {
    const mn = cNode(mgr);
    const name = navLabel(mn, mgr);
    managers.push(
      truncate(
        `↑ ${name} ${coloredGlyph(mn)} ${DIM}${mn?.kind ?? ''}${RESET} ${DIM}${tokensCell(mgr)}${RESET}${cycleBadge(mn)}${childBadge(mn)}${liveBelowBadge(mn, activity.activeBelow)}${askBadge(mgr, asks)}${activityCell(mgr, mn)}`,
      ),
    );
  }

  const reports: string[] = [];
  const live = liveReports(nodeId);
  if (live.length > 0) {
    const nameW = Math.min(20, Math.max(...live.map((id) => navLabel(cNode(id), id).length)));
    for (const id of live) {
      const n = cNode(id);
      const name = navLabel(n, id).padEnd(nameW);
      const kind = `${DIM}${(n?.kind ?? '').padEnd(6)}${RESET}`;
      const tokens = `${DIM}${tokensCell(id).padStart(5)}${RESET}`;
      reports.push(
        truncate(
          `  ${coloredGlyph(n)} ${name} ${kind} ${tokens}${cycleBadge(n)}${childBadge(n)}${liveBelowBadge(n, activity.activeBelow)}${askBadge(id, asks)}${activityCell(id, n)}`,
        ),
      );
    }
  }
  // Self's own pending asks (no self row in BASE) → a trailing inline line.
  const selfAsks = asks[nodeId] ?? 0;
  if (selfAsks > 0) reports.push(`${YELLOW}⚑${selfAsks}${RESET}`);

  return { managers, reports };
}
