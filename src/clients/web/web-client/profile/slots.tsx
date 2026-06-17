/**
 * Slot/panel registry (design §3.3). A page is a layout with named slots, each
 * filled from a registry whose entries declare a required capability. The page
 * renders only the slots whose capability the active profile grants — so a
 * panel's PRESENCE is data (a grant table), not an `if` ladder. Adding a
 * "Reviewer" that sees chrome but cannot drive = grant node.internals, withhold
 * node.arbitration; zero component edits.
 */

import type { ReactNode } from 'react';
import type { Capability } from './types.js';
import { useCapability, useGrants } from './provider.js';

/** A panel registered against a slot. `cap` undefined ⇒ always present (shared
 *  substrate, e.g. the message stream and composer). */
export interface PanelEntry {
  cap?: Capability;
  render: () => ReactNode;
}

/** A page's slot→panel map. Partial: an unfilled slot renders nothing, which is
 *  how Phase-1 keeps the future rail/trace slots declared-but-empty. */
export type SlotRegistry<S extends string> = Partial<Record<S, PanelEntry>>;

/** Render one named slot from a registry, gated by its required capability. */
export function Slot<S extends string>(props: {
  reg: SlotRegistry<S>;
  name: S;
}): ReactNode {
  const entry = props.reg[props.name];
  const granted = useGrants();
  if (!entry) return null;
  if (entry.cap && !granted.has(entry.cap)) return null;
  return <>{entry.render()}</>;
}

/** Declarative capability gate. `<Can cap="node.internals">…</Can>`. */
export function Can(props: { cap: Capability; children: ReactNode }): ReactNode {
  return useCapability(props.cap) ? <>{props.children}</> : null;
}

/** Select the actions whose capability the grant set allows — so an action
 *  list's membership is data, not a chain of `if`s. Capability-free items
 *  (`cap` undefined) are always kept. */
export function actionsFor<T extends { cap?: Capability }>(
  items: T[],
  granted: Set<Capability>,
): T[] {
  return items.filter((item) => !item.cap || granted.has(item.cap));
}
