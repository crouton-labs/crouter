// gate.ts — gate evaluation. A document's optional `gate` predicate decides
// whether it is ELIGIBLE to surface at all for a given node (orthogonal to the
// rung, which decides how much). See design-substrate.md §4 + §6. Pure function
// over (parsed doc, assembled subject); the matcher engine in predicate.ts does
// the actual matching — we do NOT reimplement it here.

import { evalCondition } from '../predicate.js';
import type { SubstrateDoc } from './schema.js';
import type { NodeConfigSubject } from './subject.js';

/** Does `doc` pass its gate for `subject`?
 *
 *  - No gate (field absent) ⇒ `true`: always eligible (the common case).
 *  - A gate present ⇒ the matcher engine's verdict. An empty `gate: {}` is inert
 *    and returns `false` (never matches) per design §4 — so an author cannot
 *    write an always-eligible-via-empty-predicate doc.
 *
 *  Eligibility only. A failing gate excludes the doc from BOTH automatic hooks
 *  for this node; it remains findable by `crtr memory find` (search ignores
 *  gate + rung). */
export function gatePasses(doc: SubstrateDoc, subject: NodeConfigSubject): boolean {
  if (doc.gate === undefined) return true;
  return evalCondition(doc.gate, subject as unknown as Record<string, unknown>);
}
