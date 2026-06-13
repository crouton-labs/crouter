// Run with: node --import tsx/esm --test src/core/__tests__/tmux-surface.test.ts
//
// STEP 2 of the placement/focus migration: guards on the tmux Surface (driver).
//
//   1. The §2.2 HARD DRIVER INVARIANT (GREEN now): every create/placement verb
//      in the driver — after the broker-host cut gutted the engine-in-pane
//      relocate verbs (U9 deleted swap-pane/break-pane/join-pane/move-pane),
//      the survivors are new-window / split-window / respawn-pane — MUST pass an
//      explicit `-t` target.
//      Omitting `-t` lets tmux resolve against its GLOBAL current session, which
//      can leak a pane into a user session — the exact unbidden-window bug this
//      redesign kills. This guards the bug's blast radius and should pass today.
//
//   2. The §5.1 "only placement.ts / tmux-chrome.ts import tmux.ts" lint guard
//      (ENFORCED as of Step 8): every other module reaches the driver through
//      placement's re-exports or the tmux-chrome seam, so the only direct
//      importers are placement.ts + tmux-chrome.ts (tmux.ts itself excluded).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..'); // .../src
const TMUX_TS = join(SRC_ROOT, 'core', 'runtime', 'tmux.ts');

/** The placement verbs the §2.2 invariant governs. (swap-pane/break-pane/
 *  join-pane/move-pane were deleted with the engine-in-pane host in the broker
 *  cut; kept in the match set so a regression that re-introduces an untargeted
 *  one is still caught.) */
const PLACEMENT_VERBS = [
  'new-window',
  'split-window',
  'swap-pane',
  'break-pane',
  'join-pane',
  'move-pane',
  'respawn-pane',
] as const;

/** The smallest `[ … ]` array literal that encloses `matchIdx`: scan back to the
 *  nearest `[` (the array open — the verb is always its first element), then
 *  forward with bracket-depth counting to the matching `]` (handles nested
 *  arrays like splitWindow's `? [] : ['-h']`). Returns the array source slice. */
function enclosingArray(src: string, matchIdx: number): string {
  let open = matchIdx;
  while (open >= 0 && src[open] !== '[') open--;
  assert.ok(open >= 0, `no enclosing [ for the verb at index ${matchIdx}`);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('unbalanced [ ] while bracket-matching the verb array');
}

test('§2.2 driver invariant: every placement verb in tmux.ts passes an explicit -t target', () => {
  const src = readFileSync(TMUX_TS, 'utf8');
  // Match only the QUOTED JS string forms (`'new-window'`, …) — these are real
  // args-array elements; the jsdoc prose mentions the verbs unquoted / in
  // backticks, so this never trips on a comment.
  const re = new RegExp(`'(${PLACEMENT_VERBS.join('|')})'`, 'g');
  let found = 0;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    found++;
    const verb = m[1];
    const arr = enclosingArray(src, m.index);
    // The invariant is "name a specific tmux object, never fall back to the
    // GLOBAL current one". `-t` targets a destination; `break-pane` (and the
    // deleted swap/join/move-pane) instead name their SOURCE with `-s` — which
    // satisfies the invariant identically. Accept either explicit target flag.
    assert.ok(
      arr.includes(`'-t'`) || arr.includes(`'-s'`),
      `tmux verb '${verb}' is invoked WITHOUT an explicit -t/-s target — a latent ` +
        `instance of the unbidden-window bug (§2.2). Offending args array:\n${arr}`,
    );
  }
  // Sanity: the driver really does contain placement verbs (so a refactor that
  // renames them can't make this assertion vacuously pass). The broker cut left
  // three (new-window / split-window / respawn-pane).
  assert.ok(found >= 3, `expected to scan ≥3 placement verbs, saw ${found}`);
});

// ---------------------------------------------------------------------------
// Lint guard — §5.1, ENFORCED. The driver (tmux.ts) is imported ONLY by
// placement.ts (the sanctioned model-over-driver, which re-exports the verbs
// other modules need) and the tmux-chrome.ts chrome seam. Every other module —
// runtime, daemon, commands, stophook, AND tests — must route through those.
// ---------------------------------------------------------------------------

/** Every `.ts` file under `src` (recursively), excluding nothing. */
function allTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...allTsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** Files (basename) sanctioned to import the driver, per §2.1. */
const ALLOWED_IMPORTERS = new Set(['tmux.ts', 'placement.ts', 'tmux-chrome.ts']);

function importsDriver(file: string): boolean {
  const src = readFileSync(file, 'utf8');
  // A specifier whose basename is exactly `tmux.js` (so `tmux-chrome.js` is NOT
  // matched). Covers `from '...'` and `import('...')`.
  return [...src.matchAll(/(?:from|import\s*\()\s*'([^']+)'/g)].some(
    (m) => basename(m[1]!) === 'tmux.js',
  );
}

test(
  '§5.1 lint: only placement.ts / tmux-chrome.ts import the tmux driver',
  () => {
    const offenders = allTsFiles(SRC_ROOT)
      .filter((f) => !ALLOWED_IMPORTERS.has(basename(f)))
      .filter(importsDriver)
      .map((f) => f.slice(SRC_ROOT.length + 1));
    assert.deepEqual(offenders, [], `modules importing tmux.ts directly: ${offenders.join(', ')}`);
  },
);
