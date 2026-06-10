// Default stdout rendering: the result a leaf returns is written FOR the model
// to act on, not as data to parse. Output is a continuation of the agent's
// prompt — PLAIN MARKDOWN, no XML wrapper. Scalars list as `- name: value`
// bullets in output-schema order, prose fields render as paragraphs, and arrays
// become a count lead-in plus a markdown table (objects) or bullets (scalars).
// The raw JSON object is still available behind the `--json` global for tooling.
//
// A leaf may hand `defineLeaf` a bespoke `render(result)` for instruction-shaped
// output that leads with the outcome (see `node new`, `push`, `feed read`).
// Everything else falls through to the schema-driven generic renderer here, so
// every command obeys the markdown paradigm without a hand-written renderer.
// `renderError` is the one sanctioned exception: a failure is a different domain
// from a result, so it keeps its `<error>` block.

import type { LeafHelp } from './help.js';
import type { ErrorPayload } from './io.js';

// Field names whose value is prose the agent reads, not a scalar it keys on —
// these always render as their own paragraph, never as a `- name: value` bullet.
const PROSE_FIELDS = new Set([
  'follow_up', 'digest', 'message', 'next', 'result', 'content', 'body', 'guide',
  'summary', 'note', 'reason', 'detail', 'details', 'hint', 'instruction',
  'instructions', 'prompt', 'roadmap', 'report', 'answer', 'response', 'text',
]);

/** Minimal attribute-value sanitization: values here are controlled (ids,
 *  statuses, counts), so collapse quotes rather than entity-escape. */
function attrEsc(s: unknown): string {
  return String(s).replace(/"/g, "'").replace(/\n/g, ' ');
}

function scalarStr(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(scalarStr).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** A string field is prose when it is named as such, spans lines, or is long
 *  enough that it reads as a sentence rather than an identifier. */
function isProse(name: string, v: unknown): v is string {
  if (typeof v !== 'string') return false;
  if (PROSE_FIELDS.has(name)) return true;
  return v.includes('\n') || v.length > 80;
}

/** Keep a value safe inside a markdown table cell: pipes would split columns,
 *  newlines would break the row. */
function cellEsc(v: unknown): string {
  return scalarStr(v).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/** An array renders as a count lead-in followed by the collection: a markdown
 *  table when every element is an object, plain bullets otherwise. */
function renderArray(name: string, arr: unknown[]): string {
  if (arr.length === 0) return `0 ${name}.`;
  const lead = `${arr.length} ${name}:`;
  const allObjects = arr.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  if (allObjects) {
    const rows = arr as Record<string, unknown>[];
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const head = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const body = rows.map((r) => `| ${cols.map((c) => cellEsc(r[c])).join(' | ')} |`).join('\n');
    return `${lead}\n\n${head}\n${sep}\n${body}`;
  }
  const items = arr.map((x) => `- ${scalarStr(x)}`).join('\n');
  return `${lead}\n${items}`;
}

/** Schema-driven fallback: turn a result object into agent-ready plain markdown.
 *  Field order follows the leaf's declared output schema; any extra keys append
 *  after. Scalars (and nested objects) list as `- name: value` bullets, prose
 *  fields render as paragraphs, and arrays become a count lead-in plus a table
 *  or bullets. No root tag — the result is read as a continuation of the prompt. */
export function renderResult(result: Record<string, unknown>, help: LeafHelp): string {
  const order: string[] = help.output.map((f) => f.name);
  for (const k of Object.keys(result)) if (!order.includes(k)) order.push(k);

  const bullets: string[] = [];
  const proseFields: { name: string; text: string }[] = [];
  const arrays: string[] = [];

  for (const name of order) {
    const v = result[name];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { arrays.push(renderArray(name, v)); continue; }
    if (isProse(name, v)) { proseFields.push({ name, text: v }); continue; }
    // Scalars and nested objects alike list as a bullet (objects via compact JSON).
    bullets.push(`- ${name}: ${scalarStr(v)}`);
  }

  const parts: string[] = [];
  if (bullets.length > 0) parts.push(bullets.join('\n'));
  // Label prose only when more than one block would otherwise blur together.
  const labelProse = proseFields.length > 1;
  for (const { name, text } of proseFields) {
    parts.push(labelProse ? `**${name}:** ${text}` : text);
  }
  for (const block of arrays) parts.push(block);

  return parts.join('\n\n');
}

/** Render a structured failure as an instruction-shaped block: what broke, what
 *  was received, and the recovery road sign — the same recovery info the JSON
 *  payload carries, shaped for the model to act on. */
export function renderError(p: ErrorPayload): string {
  const lines: string[] = [p.message];
  if (p.received !== undefined && p.received !== null && p.received !== '') {
    lines.push(`received: ${scalarStr(p.received)}`);
  }
  if (p.field !== undefined) lines.push(`field: ${p.field}`);
  lines.push(`Next: ${p.next}`);
  return `<error code="${attrEsc(p.error)}">\n${lines.join('\n')}\n</error>`;
}
