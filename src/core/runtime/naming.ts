// Session naming — turn a node's first prompt into a short, human-readable
// handle for the editor label.
//
// A node's editor label is `<kind> (<mode>) <name> <cycle>` (see editorLabel in
// launch.ts). The `<name>` is a 3-8 word kebab-case "description" derived from
// the first prompt by asking pi headlessly (`pi -p`), persisted on the node's
// meta so it survives revives and shows in every cycle.
//
// Two entry points:
//   • generateSessionName  — synchronous (spawnSync). For the CLI spawn paths
//     (spawnChild / bootRoot) that run outside any pi event loop, where a brief
//     block before launching the worker is fine and lets the FIRST pi session
//     already carry the name.
//   • generateAndPersistName — async (execFile, non-blocking). For the bare-root
//     case where the prompt only arrives as the first interactive message inside
//     a live pi process; it must never block the event loop. Persists the name
//     to meta so the label picks it up on the next cycle.
//
// Both are best-effort: a failed/slow/garbled pi call falls back to a local slug
// of the prompt, so a node always gets a sane name.

import { spawnSync, execFile } from 'node:child_process';
import { getNode, updateNode } from '../canvas/index.js';
import type { NodeMeta } from '../canvas/index.js';

/** Cap on prompt text fed to the namer — a name needs only the gist. */
const PROMPT_CAP = 2000;

/** Wall-clock budget for the headless pi call before we fall back to a slug. */
const NAME_TIMEOUT_MS = 20_000;

const NAME_SYSTEM_PROMPT =
  'You name coding-agent work sessions. This name is a label used to identify the ' +
  'session at a glance among many other concurrent programming sessions, so it must ' +
  'describe what the task is about. Reply with ONLY a concise 3-8 word name in ' +
  'kebab-case: lowercase words joined by single hyphens (e.g. `refactor-auth-token-flow`, ' +
  '`add-csv-export-endpoint`). No punctuation, quotes, prose, or trailing text. ' +
  'Output JUST the name, nothing else.';

/** Put the raw task text FIRST in a delimited block, then the instruction, so the
 *  model reads the content before being told what to do and never mistakes the
 *  prompt's own text for the instruction. The prompt is capped first, so the
 *  closing tag is always present. */
function nameUserPrompt(prompt: string): string {
  return `<prompt>\n${prompt.slice(0, PROMPT_CAP)}\n</prompt>\n\nName this session based on the task above. The name should describe what the task is about, so it can be identified among many other programming sessions. Output JUST the name, nothing else.`;
}

/** A short stop-word set so the local-slug fallback skips filler words. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'as', 'at', 'by', 'from', 'into',
  'please', 'can', 'you', 'i', 'we', 'my', 'our', 'me', 'so', 'then',
]);

/** Coerce arbitrary text into a 3-8 word kebab-case name, or '' if nothing
 *  usable survives. Lowercases, keeps [a-z0-9], collapses everything else to a
 *  single hyphen, and clamps to the first 8 words. */
export function sanitizeSessionName(raw: string): string {
  const firstLine = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const words = firstLine
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter((w) => w !== '');
  return words.slice(0, 8).join('-');
}

/** Local fallback: derive a name straight from the prompt (no pi call). Drops
 *  stop-words, takes the first few content words. */
export function slugFromPrompt(prompt: string): string {
  const words = (prompt ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w !== '' && !STOPWORDS.has(w));
  const picked = (words.length > 0 ? words : (prompt ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(Boolean))
    .slice(0, 3);
  return sanitizeSessionName(picked.join('-')) || 'session';
}

/** Default namer model — Anthropic's small/fast model. Naming is a one-line
 *  classification, so we pin Haiku (cheap, quick) instead of inheriting the
 *  node's heavyweight default. Override with CRTR_NAME_MODEL. */
const DEFAULT_NAME_MODEL = 'anthropic/claude-haiku-4-5';

/** The pi argv for a headless name request. Stripped down (no tools, session,
 *  context files, extensions, skills, templates, themes) so it's fast and
 *  side-effect free. Pinned to Haiku with thinking off — naming is a trivial
 *  classification that never needs a reasoning budget. Override the model with
 *  CRTR_NAME_MODEL. */
function nameArgs(prompt: string): string[] {
  const override = process.env['CRTR_NAME_MODEL'];
  const model = override !== undefined && override.trim() !== '' ? override.trim() : DEFAULT_NAME_MODEL;
  const argv = [
    '-p',
    '--no-session',
    '--no-context-files',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-tools',
    '--mode', 'text',
    // Naming is a trivial one-line classification — no thinking budget, ever.
    '--thinking', 'off',
    '--model', model,
  ];
  argv.push('--system-prompt', NAME_SYSTEM_PROMPT);
  argv.push(nameUserPrompt(prompt));
  return argv;
}

/** Synchronously ask pi for a 3-8 word kebab name for `prompt`. Blocks up to
 *  NAME_TIMEOUT_MS; on any failure (non-zero exit, timeout, empty/garbled
 *  output) falls back to a local slug. Returns '' only for an empty prompt. */
export function generateSessionName(prompt: string): string {
  const body = (prompt ?? '').trim();
  if (body === '') return '';
  try {
    const r = spawnSync('pi', nameArgs(body), {
      encoding: 'utf8',
      timeout: NAME_TIMEOUT_MS,
      // Don't inherit a TUI; capture stdout only.
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status === 0 && typeof r.stdout === 'string') {
      const name = sanitizeSessionName(r.stdout);
      if (name !== '') return name;
    }
  } catch {
    // fall through to slug
  }
  return slugFromPrompt(body);
}

/** Asynchronously generate a name for `prompt` and persist it to the node's
 *  meta as `description` — only if the node has none yet (so a later message
 *  never clobbers it). Non-blocking: safe to call from inside a live pi event
 *  loop. Best-effort; swallows all errors.
 *
 *  `onNamed` (optional) fires with the freshly-persisted meta the moment the
 *  name lands — the bare-root path passes a callback that calls
 *  pi.setSessionName(editorLabel(meta)) so the LIVE editor label updates in the
 *  same session, instead of waiting for the next revive/cycle. */
export function generateAndPersistName(
  nodeId: string,
  prompt: string,
  onNamed?: (meta: NodeMeta) => void,
): void {
  const body = (prompt ?? '').trim();
  if (body === '') return;

  const persist = (name: string): void => {
    try {
      const meta = getNode(nodeId);
      if (meta === null) return;
      if ((meta.description ?? '').trim() !== '') return; // already named
      const clean = sanitizeSessionName(name);
      const updated = updateNode(nodeId, { description: clean !== '' ? clean : slugFromPrompt(body) });
      onNamed?.(updated);
    } catch {
      // best-effort
    }
  };

  try {
    execFile(
      'pi',
      nameArgs(body),
      { encoding: 'utf8', timeout: NAME_TIMEOUT_MS },
      (err, stdout) => {
        if (err || typeof stdout !== 'string') {
          persist(slugFromPrompt(body));
          return;
        }
        const name = sanitizeSessionName(stdout);
        persist(name !== '' ? name : slugFromPrompt(body));
      },
    );
  } catch {
    persist(slugFromPrompt(body));
  }
}
