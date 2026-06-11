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
  YELLOW, RESET,
} from '../../core/canvas/nav-model.js';
import type { AttachPalette } from './config-load.js';

export interface CanvasPanelLines {
  /** Above-editor manager line(s) — empty for a root node (no manager). */
  managers: string[];
  /** Below-editor report row(s) + self's trailing ⚑ asks line — empty when none. */
  reports: string[];
}

/** Column widths for the aligned panel rows (visible columns). name is sized to
 *  the widest label across BOTH panels (capped); kind is wide enough for the
 *  longest persona kind (`orchestrator` = 12) so real kinds never truncate;
 *  tokens is fixed. Both panels share one grid. */
const KIND_W = 12;
const TOK_W = 6;
const NAME_CAP = 22;

/** Pad to `w`, or ellipsize with `…` when longer (plain text — callers pass
 *  un-styled labels). */
function nameCell(s: string, w: number): string {
  return s.length > w ? `${s.slice(0, w - 1)}…` : s + ' '.repeat(w - s.length);
}
function padStartVisible(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s;
}

/** Build the BASE panel line stacks for `nodeId` from canvas.db (ported verbatim
 *  from canvas-nav.ts renderBase). `asks` is the per-node pending-ask map the
 *  caller polls; pass `{}` to omit the ⚑ badges. `palette` (the live theme)
 *  drives the headers + dim cells; omit it and the panels render uncolored. */
export function buildCanvasPanelLines(
  nodeId: string,
  asks: Record<string, number>,
  palette?: AttachPalette,
): CanvasPanelLines {
  // Fresh snapshot: drop the previous build's memoized reads so this pass sees
  // current disk+db state, then read-once within it.
  beginFrame();

  // Styling: theme-driven when a palette is passed, plain otherwise (so the
  // panels still build for a non-attach caller / a test).
  const muted = palette?.muted ?? ((s: string) => s);
  const faint = palette?.faint ?? ((s: string) => s);
  const header = (s: string): string => (palette ? palette.accent(s) : s);

  // One subtree-activity pass (rooted at the ancestry root) feeds the ⇣N
  // live-work-below badge on both the manager line and every report row.
  const activity = computeSubtreeActivity(climbRoot(nodeId), nodeId);

  // One shared name-column width across BOTH panels so the grids line up.
  const mgr = managerOf(nodeId);
  const live = liveReports(nodeId);
  const gridIds = [...(mgr !== undefined ? [mgr] : []), ...live];
  const nameW = gridIds.length > 0
    ? Math.min(NAME_CAP, Math.max(...gridIds.map((id) => navLabel(cNode(id), id).length)))
    : NAME_CAP;

  // A node row laid out on the shared grid: glyph · name · kind · tokens · badges.
  const row = (id: string): string => {
    const n = cNode(id);
    const name = nameCell(navLabel(n, id), nameW);
    const kind = faint(nameCell(n?.kind ?? '', KIND_W));
    const tokens = muted(padStartVisible(tokensCell(id), TOK_W));
    const badges = `${cycleBadge(n)}${childBadge(n)}${liveBelowBadge(n, activity.activeBelow)}${askBadge(id, asks)}${activityCell(id, n)}`;
    return truncate(` ${coloredGlyph(n)} ${name}  ${kind} ${tokens}${badges}`);
  };

  // --- managers panel (↑) ---
  const managers: string[] = [];
  if (mgr !== undefined) {
    managers.push(header('↑ manager'));
    managers.push(row(mgr));
  }

  // --- reports panel (↓) ---
  const reports: string[] = [];
  if (live.length > 0) {
    reports.push(header('↓ reports') + muted(` · ${live.length}`));
    for (const id of live) reports.push(row(id));
  }
  // Self's own pending asks (no self row in BASE) → a trailing inline line.
  const selfAsks = asks[nodeId] ?? 0;
  if (selfAsks > 0) reports.push(` ${YELLOW}⚑ ${selfAsks} pending${RESET}`);

  return { managers, reports };
}
