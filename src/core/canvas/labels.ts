// labels.ts — human-facing node labels derived from a node's meta.
//
// One source of truth for "what do we call this node on screen". `fullName`
// combines the node's explicit handle (meta.name) with the pi-generated
// description of its first task (meta.description) — the same string the editor
// label, the canvas dashboard tree, the nav spine, and the tmux window tab all
// render, so a node reads identically everywhere it appears.

import type { NodeMeta } from './types.js';

/** The minimal shape `fullName` needs — satisfied by NodeMeta and by anything
 *  else carrying name + kind (description optional). */
export interface NamedNode {
  name: string;
  kind: string;
  description?: string;
}

/** A node's human label: its explicit handle plus the pi-generated description
 *  of its first task, e.g. `fix-auth refactor-login-flow`. The handle is
 *  dropped when it's just the kind default (non-informative, and the kind is
 *  surfaced elsewhere), so a default-named node reads as its description alone
 *  (`refactor-login-flow`). Falls back to the bare name when no description
 *  exists yet (a node not yet named, e.g. a bare root before its first
 *  message). Never empty. */
export function fullName(node: NamedNode): string {
  const desc = (node.description ?? '').trim();
  const handle = node.name && node.name !== node.kind ? node.name : '';
  const combined = [handle, desc].filter((s) => s !== '').join(' ');
  return combined !== '' ? combined : node.name;
}

/** The pi session display name — the editor label in the top-left. Format is
 *  `<kind> (<mode>) <fullName> <cycle>` where `<fullName>` is the node's handle
 *  plus the pi-generated description of its first task (see fullName) and
 *  `<cycle>` is the revive count (meta.cycles). So `developer (orchestrator)
 *  fix-auth refactor-auth-flow 2` reads as a developer orchestrator on its 2nd
 *  cycle working the auth refactor. The name segment is omitted while it
 *  collapses to the bare kind (a bare root before its first message is named).
 *  Recomputed from meta on every revive (and pushed live via pi.setSessionName
 *  when a bare root is named mid-session), so a base→orchestrator polymorph, a
 *  fresh cycle, or a first-message naming all update the label. */
export function editorLabel(meta: NodeMeta): string {
  const base = `${meta.kind} (${meta.mode})`;
  const full = fullName(meta);
  const cycle = meta.cycles ?? 0;
  return full !== '' && full !== meta.kind ? `${base} ${full} ${cycle}` : `${base} ${cycle}`;
}
