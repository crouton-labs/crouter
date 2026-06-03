// Default stdout rendering: the result a leaf returns is written FOR the model
// to act on, not as data to parse. Output is a continuation of the agent's
// prompt — light XML fences around markdown, prose where prose belongs. The
// raw JSON object is still available behind the `--json` global for tooling.
//
// A leaf may hand `defineLeaf` a bespoke `render(result)` for instruction-shaped
// output (see `node new`, `push`, `feed read`). Everything else falls through to
// the schema-driven generic renderer here, so every command obeys the paradigm
// without a hand-written renderer.

import type { LeafHelp } from './help.js';
import type { ErrorPayload } from './io.js';

// Field names whose value is prose the agent reads, not a scalar it keys on —
// these always render as their own fenced block, never as a tag attribute.
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

/** Short, space-free scalars ride as attributes on the open tag (ids, statuses,
 *  counts); everything else that isn't prose lists as a markdown bullet. */
function isAttr(v: unknown): boolean {
  if (typeof v === 'number' || typeof v === 'boolean') return true;
  return typeof v === 'string' && v.length <= 40 && !v.includes(' ') && !v.includes('\n');
}

/** Root element name = the command path with spaces hyphenated. */
function rootTag(help: LeafHelp): string {
  return help.name.trim().split(/\s+/).join('-').replace(/[^a-zA-Z0-9_-]/g, '') || 'result';
}

function renderArray(name: string, arr: unknown[]): string {
  if (arr.length === 0) return `<${name} count="0"></${name}>`;
  const allObjects = arr.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x));
  if (allObjects) {
    const rows = arr as Record<string, unknown>[];
    const cols: string[] = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const head = `| ${cols.join(' | ')} |`;
    const sep = `| ${cols.map(() => '---').join(' | ')} |`;
    const body = rows.map((r) => `| ${cols.map((c) => scalarStr(r[c])).join(' | ')} |`).join('\n');
    return `<${name} count="${arr.length}">\n${head}\n${sep}\n${body}\n</${name}>`;
  }
  const items = arr.map((x) => `- ${scalarStr(x)}`).join('\n');
  return `<${name} count="${arr.length}">\n${items}\n</${name}>`;
}

/** Schema-driven fallback: turn a result object into agent-ready XML+markdown.
 *  Field order follows the leaf's declared output schema; any extra keys append
 *  after. Scalars become attributes or a bullet list, prose and collections
 *  become their own fenced blocks. */
export function renderResult(result: Record<string, unknown>, help: LeafHelp): string {
  const order: string[] = help.output.map((f) => f.name);
  for (const k of Object.keys(result)) if (!order.includes(k)) order.push(k);

  const attrs: string[] = [];
  const bullets: string[] = [];
  const blocks: string[] = [];

  for (const name of order) {
    const v = result[name];
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) { blocks.push(renderArray(name, v)); continue; }
    if (typeof v === 'object') { blocks.push(`<${name}>\n${JSON.stringify(v, null, 2)}\n</${name}>`); continue; }
    if (isProse(name, v)) { blocks.push(`<${name}>\n${v}\n</${name}>`); continue; }
    if (isAttr(v)) { attrs.push(`${name}="${attrEsc(v)}"`); continue; }
    bullets.push(`- ${name}: ${scalarStr(v)}`);
  }

  const tag = rootTag(help);
  const open = attrs.length > 0 ? `<${tag} ${attrs.join(' ')}>` : `<${tag}>`;
  const parts: string[] = [];
  if (bullets.length > 0) parts.push(bullets.join('\n'));
  if (blocks.length > 0) parts.push(blocks.join('\n\n'));
  const inner = parts.join('\n\n');
  return inner !== '' ? `${open}\n${inner}\n</${tag}>` : `${open}</${tag}>`;
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
