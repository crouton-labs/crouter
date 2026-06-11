// Inactivity recap — turn a dormant node's conversation into a three-fragment
// "where it left off" card (goal / doing-now / next) for the recap widget.
//
// One entry point: generateRecap — async (execFile, non-blocking), mirroring
// naming.ts's headless-`pi -p` pattern exactly. It runs Haiku over the literal
// back-and-forth (the caller concatenates user+assistant text) with a stripped-
// down pi invocation (no tools/session/context/extensions/skills), so it's fast
// and side-effect free and can never recurse into another spawn.
//
// Best-effort and silent on failure: a non-zero exit, timeout, empty or garbled
// output resolves to NO recap (the caller shows nothing). The recap is throwaway
// idle chrome — there is no local fallback, unlike naming, because a wrong or
// stale recap is worse than none.
//
// Plain TS-with-types — no imports from @earendil-works/* so it compiles inside
// crouter's own tsc build without a dep on the pi packages.

import { execFile } from 'node:child_process';

/** Wall-clock budget for the headless pi call before we give up (no recap). */
const RECAP_TIMEOUT_MS = 25_000;

/** Default recap model — Haiku. A recap is a one-shot summarization, so we pin
 *  the small/fast model rather than the node's heavyweight default. Override
 *  with CRTR_RECAP_MODEL (mirrors CRTR_NAME_MODEL). */
const DEFAULT_RECAP_MODEL = 'anthropic/claude-haiku-4-5';

const RECAP_SYSTEM_PROMPT =
  'You write a terse "where we left off" recap of a coding-agent work session, ' +
  'read at a glance by someone returning to a paused conversation. You are given ' +
  'the literal back-and-forth between the user and the agent. Output EXACTLY three ' +
  'lines, nothing else — no labels, no numbering, no bullets, no punctuation at the ' +
  'end of a line, no prose:\n' +
  '  Line 1: the GOAL — what this session is ultimately trying to achieve.\n' +
  '  Line 2: DOING NOW — what was just happening / the active piece of work.\n' +
  '  Line 3: NEXT — the immediate next step.\n' +
  'Each line is a short FRAGMENT, not a sentence (e.g. `wire up recap widget above editor`, ' +
  'not `We are wiring up the recap widget.`). Keep each under ~60 characters. ' +
  'If the session has barely started or you cannot tell, still give your best three ' +
  'fragments from whatever text exists. Output JUST the three lines.';

/** Put the conversation FIRST in a delimited block, then the instruction, so the
 *  model reads the content before being told what to do. */
function recapUserPrompt(conversation: string): string {
  return `<conversation>\n${conversation}\n</conversation>\n\nWrite the three-line recap of the session above (goal / doing-now / next). Output JUST the three lines.`;
}

/** The pi argv for a headless recap request. Stripped down (no tools, session,
 *  context files, extensions, skills, templates, themes) so it's fast and
 *  side-effect free. Pinned to Haiku with thinking off. Override the model with
 *  CRTR_RECAP_MODEL. */
function recapArgs(conversation: string): string[] {
  const override = process.env['CRTR_RECAP_MODEL'];
  const model = override !== undefined && override.trim() !== '' ? override.trim() : DEFAULT_RECAP_MODEL;
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
    '--thinking', 'off',
    '--model', model,
    '--system-prompt', RECAP_SYSTEM_PROMPT,
    recapUserPrompt(conversation),
  ];
  return argv;
}

/** Parse the model's raw stdout into up to three short fragment lines. Strips any
 *  stray leading labels/bullets the model may have added despite instructions,
 *  drops empties, and hard-caps line length so a runaway line can't blow up the
 *  widget. Returns [] when nothing usable survives (→ no recap). */
function parseRecap(stdout: string): string[] {
  const LINE_CAP = 72;
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    // Strip a leading `goal:` / `now:` / `next:` / `- ` / `1.` style prefix.
    .map((l) => l.replace(/^(?:[-*•]\s*)?(?:\d+[.)]\s*)?(?:goal|now|doing(?:[\s-]now)?|next)\s*[:\-]\s*/i, '').trim())
    .filter((l) => l !== '');
  return lines.slice(0, 3).map((l) => (l.length > LINE_CAP ? l.slice(0, LINE_CAP) : l));
}

/** Ask pi headlessly for a three-fragment recap of `conversation`, async. Invokes
 *  `onRecap` with the parsed fragment lines on success, or never (silent) on any
 *  failure — non-zero exit, timeout, empty/garbled output. Owns the subprocess
 *  mechanics — crucially it hands pi an immediate stdin EOF: `pi -p` reads stdin,
 *  and execFile's default stdin is an OPEN pipe that never closes, so without
 *  this pi blocks waiting for EOF and the call exits non-zero (the same gotcha
 *  naming.ts documents). */
export function generateRecap(conversation: string, onRecap: (lines: string[]) => void): void {
  const body = (conversation ?? '').trim();
  if (body === '') return;
  try {
    const child = execFile(
      'pi',
      recapArgs(body),
      { encoding: 'utf8', timeout: RECAP_TIMEOUT_MS },
      (err, stdout) => {
        if (err || typeof stdout !== 'string') return; // silent — no recap
        const lines = parseRecap(stdout);
        if (lines.length === 0) return;
        try { onRecap(lines); } catch { /* best-effort */ }
      },
    );
    child.stdin?.end(); // immediate EOF — see the doc above
  } catch {
    // best-effort: no recap
  }
}
