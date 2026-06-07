// @ts-check
/**
 * Git / PR board — the crtr `git-pr` view (the monitor archetype, sibling of
 * `canvas`).
 *
 * Self-contained ESM. Imports its data layer from `./client.mjs` (which shells
 * `git` + `gh` over the view's cwd) and the shared state helpers from
 * `../_lib/states.mjs`. It imports NOTHING from crtr — the host injects the
 * `Draw` + `ViewHost` API and dynamically `import()`s this module's DEFAULT
 * EXPORT.
 *
 * A READ-ONLY instrument cluster for the repo at the view's cwd. Composition
 * (single pane — the two domains are stacked, not split, so the eye reads top to
 * bottom without hunting across a rule; a vline is reserved for genuinely
 * co-equal live panes and these aren't — git local state is the headline, PRs
 * are the trailing gauge):
 *
 *   1. HEADER ZONE (always-on gauges, 2 rows): branch → upstream with ahead/
 *      behind, a right-flushed working-tree chip; then the last commit + a
 *      right-flushed relative age. These are the dials you glance at first.
 *   2. BOARD (the scrollable body, one list with two labeled sections):
 *      "Working tree" — changed files (status glyph + XY code + path + churn),
 *      then "Pull requests" — open PRs (number + title + review/CI rollup +
 *      age). gh failure degrades THIS SECTION to a guided note; the git header +
 *      file list still render (graceful partial failure, principle 5).
 *
 * VISUAL LANGUAGE (crtr-views-visual-design §2/§3/§4): hierarchy by weight + hue
 * + position, never boxes. Hues are NUMERIC SGR only — green=clean/passing/
 * staged/ahead (32), yellow=attention/pending/modified/behind (33), red=failing/
 * conflicted (31), cyan=identity/branch/PR# (36), grey=metadata (90), bright-
 * yellow=flag counts (93). Every hue is paired with a glyph + the git-native XY
 * code so it survives NO_COLOR. The one state chip is host-derived from data
 * freshness (busy→working; git source down→error/blocked; conflicts or failing
 * CI / changes-requested→action/attention; else ready), driven by toggling
 * banners + the busy lane. The four standard states come from `_lib/states.mjs`.
 *
 * @module git-pr/view
 */

import { fetchGit, fetchPrs } from './client.mjs';
import { loadingState, emptyState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./client.mjs').GitState} GitState */
/** @typedef {import('./client.mjs').ChangedFile} ChangedFile */
/** @typedef {import('./client.mjs').Pr} Pr */

/**
 * One logical board row (built once per refresh; re-rendered on resize without a
 * re-fetch). The cursor moves over all of them — label/spacer rows are inert.
 * @typedef {{kind:'label', text:string}
 *   | {kind:'file', file:ChangedFile}
 *   | {kind:'clean'}
 *   | {kind:'spacer'}
 *   | {kind:'pr', pr:Pr}
 *   | {kind:'note', text:string}} BoardRow
 */

/**
 * The view's single mutable state object. The view owns it; hooks mutate it in
 * place.
 * @typedef {Object} GitPrState
 * @property {GitState|null} git    Local git state, or null when unavailable.
 * @property {string|null} gitError      Cause string when the git read failed.
 * @property {string|null} gitErrorKind  'not-a-repo' | 'git-missing' | 'git-failed'.
 * @property {Pr[]} prs             Open PRs (empty when none / gh degraded).
 * @property {string|null} prNote   gh degradation guidance (null ⇒ gh ok).
 * @property {BoardRow[]} board     Flattened board rows (render source).
 * @property {number} cursor        Read cursor into board (j/k).
 * @property {number} scroll        draw.list scroll, stored back each frame.
 * @property {number} lastFetch     Epoch ms of the last completed refresh.
 */

// ── Status vocabulary (triple-coded: hue + glyph + the git-native XY code) ─────

/**
 * File class → glyph + NUMERIC hue. Shapes differ (filled/hollow/?/✗) so the
 * class survives mono; the XY code (index vs worktree column) is the third code.
 * @type {Record<string,{glyph:string, fg:string}>}
 */
const FILE_GLYPH = {
  staged: { glyph: '●', fg: '32' }, // green — in the index, ready
  modified: { glyph: '○', fg: '33' }, // yellow — unstaged worktree edit
  untracked: { glyph: '?', fg: '90' }, // grey — not tracked
  conflict: { glyph: '✗', fg: '31' }, // red — merge conflict
};

/** PR review decision → glyph + hue. Pending review is neutral (grey), not red. */
const REVIEW = {
  approved: { glyph: '✓', fg: '32' }, // green
  changes: { glyph: '✗', fg: '31' }, // red — changes requested (attention)
  review: { glyph: '◌', fg: '90' }, // grey — review required / pending
};

/** PR CI rollup → glyph + hue. */
const CI = {
  pass: { glyph: '✓', fg: '32' }, // green
  fail: { glyph: '✗', fg: '31' }, // red
  pending: { glyph: '⟳', fg: '33' }, // yellow
  none: { glyph: '·', fg: '90' }, // grey — no checks
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Relative-age ladder (design §5): `now` (<60s), `{m}m` (<60m), `{h}h` (<24h),
 * `{d}d` (<7d), else `Mon D` (`Mar 4`), prior-year `Mon ʼYY`. Max ~5 cols.
 * @param {string} iso @param {number} now @returns {string}
 */
function relAge(iso, now) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  const date = new Date(t);
  const mon = MONTHS[date.getMonth()] || '?';
  if (date.getFullYear() === new Date(now).getFullYear()) return `${mon} ${date.getDate()}`;
  return `${mon} ʼ${String(date.getFullYear()).slice(-2)}`;
}

/** @param {number} n @param {string} w @returns {string} */
function plural(n, w) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

/** Total changed files. @param {GitState} g @returns {number} */
function changedCount(g) {
  return g.files.length;
}

// ── Board model (built in refresh; mapped to spans in render) ──────────────────

/**
 * Flatten git + PR state into the ordered board rows. Each section degrades
 * inline (a clean reward row / a guided gh note / a "no open PRs" note) so the
 * board is never a void.
 * @param {GitPrState} state @returns {BoardRow[]}
 */
function buildBoard(state) {
  /** @type {BoardRow[]} */
  const rows = [];
  const g = state.git;
  rows.push({ kind: 'label', text: 'Working tree' });
  if (!g || g.files.length === 0) rows.push({ kind: 'clean' });
  else for (const f of g.files) rows.push({ kind: 'file', file: f });

  rows.push({ kind: 'spacer' });
  rows.push({ kind: 'label', text: 'Pull requests' });
  if (state.prNote) rows.push({ kind: 'note', text: state.prNote });
  else if (state.prs.length === 0) rows.push({ kind: 'note', text: 'No open pull requests.' });
  else for (const pr of state.prs) rows.push({ kind: 'pr', pr });
  return rows;
}

// ── Chrome copy (subtitle / footer / attention / dump) ─────────────────────────

/**
 * Working-tree state as one short phrase, for the subtitle + dump.
 * @param {GitState} g @returns {string}
 */
function treePhrase(g) {
  const c = g.counts;
  if (g.files.length === 0) return 'clean';
  /** @type {string[]} */
  const parts = [];
  if (c.conflict) parts.push(`${c.conflict} conflict`);
  if (c.staged) parts.push(`${c.staged} staged`);
  if (c.modified) parts.push(`${c.modified} modified`);
  if (c.untracked) parts.push(`${c.untracked} untracked`);
  return parts.join(' · ') || plural(g.files.length, 'change');
}

/**
 * Live title subtitle — branch + tracking delta + tree state. `null` ⇒ no repo.
 * @param {GitPrState} state @returns {string|null}
 */
function subtitleFor(state) {
  const g = state.git;
  if (!g) return null;
  let s = g.branch;
  if (g.ahead) s += ` ↑${g.ahead}`;
  if (g.behind) s += ` ↓${g.behind}`;
  s += ` · ${treePhrase(g)}`;
  return s;
}

/**
 * Footer status (left, transient) — rendered scope. `null` ⇒ a state speaks.
 * @param {GitPrState} state @returns {string|null}
 */
function footerSummary(state) {
  const g = state.git;
  if (!g) return null;
  const files = g.files.length === 0 ? 'clean' : plural(changedCount(g), 'change');
  const prs = state.prNote ? 'PRs n/a' : plural(state.prs.length, 'PR');
  return `${files} · ${prs}`;
}

/**
 * The one thing that wants a human's eyes → an ACTION banner (host derives the
 * yellow attention chip). Conflicts, a failing PR check, or changes-requested.
 * `null` ⇒ nothing pressing (host derives ready). Only PRs we actually fetched
 * count (gh degraded ⇒ unknown ⇒ not flagged).
 * @param {GitPrState} state @returns {string|null}
 */
function attentionFor(state) {
  const g = state.git;
  /** @type {string[]} */
  const parts = [];
  if (g && g.counts.conflict) parts.push(`${plural(g.counts.conflict, 'conflict')}`);
  if (!state.prNote) {
    const failing = state.prs.filter((p) => p.ci === 'fail').length;
    const changes = state.prs.filter((p) => p.review === 'changes').length;
    if (failing) parts.push(`${failing} PR${failing === 1 ? '' : 's'} failing CI`);
    if (changes) parts.push(`${changes} PR${changes === 1 ? '' : 's'} need changes`);
  }
  return parts.length ? `${parts.join(' · ')} — needs attention` : null;
}

// ── Row → ListItemRow (left spans + right-flushed metadata) ────────────────────

/**
 * Build one board list row. A 1-cell left gutter rides the cursor bg (§2).
 * @param {BoardRow} row @param {number} now
 * @returns {import('../../core/tui/draw.js').ListItemRow}
 */
function rowToItem(row, now) {
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [{ text: ' ', style: undefined }];

  if (row.kind === 'label') {
    spans.push({ text: row.text, style: { fg: '90', dim: true } });
    return { spans };
  }
  if (row.kind === 'spacer') {
    return { spans: [{ text: '', style: undefined }] };
  }
  if (row.kind === 'clean') {
    spans.push({ text: '✓', style: { fg: '32' } });
    spans.push({ text: '  nothing to commit, working tree clean', style: { dim: true } });
    return { spans };
  }
  if (row.kind === 'note') {
    spans.push({ text: '·', style: { fg: '90', dim: true } });
    spans.push({ text: '  ' + row.text, style: { dim: true } });
    return { spans };
  }
  if (row.kind === 'file') {
    const f = row.file;
    const g = FILE_GLYPH[f.cls] || FILE_GLYPH.modified;
    spans.push({ text: g.glyph, style: { fg: g.fg } }); // hue + shape (mono carrier)
    spans.push({ text: ' ', style: undefined });
    spans.push({ text: f.xy.replace(/ /g, '·'), style: { fg: '90', dim: true } }); // git-native XY code
    spans.push({ text: ' ', style: undefined });
    spans.push({ text: f.path, style: f.cls === 'conflict' ? { fg: '31' } : undefined });
    if (f.add || f.del) {
      /** @type {import('../../core/tui/draw.js').Span[]} */
      const right = [
        { text: `+${f.add}`, style: { fg: '90', dim: true } },
        { text: ' ', style: undefined },
        { text: `−${f.del}`, style: { fg: '90', dim: true } },
      ];
      return { spans, right };
    }
    return { spans };
  }
  // row.kind === 'pr'
  const pr = row.pr;
  const rv = REVIEW[pr.review] || REVIEW.review;
  const ci = CI[pr.ci] || CI.none;
  spans.push({ text: `#${pr.number}`, style: { fg: '36', bold: pr.current } }); // cyan identity; current branch bold
  spans.push({ text: ' ', style: undefined });
  spans.push({ text: pr.title, style: pr.isDraft ? { dim: true } : undefined });
  if (pr.isDraft) spans.push({ text: ' (draft)', style: { fg: '90', dim: true } });

  const age = relAge(pr.updatedAt, now);
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const right = [
    { text: rv.glyph, style: { fg: rv.fg } }, // review (color + glyph)
    { text: ' ', style: undefined },
    { text: ci.glyph, style: { fg: ci.fg } }, // CI rollup (color + glyph)
  ];
  if (age) {
    right.push({ text: '  ', style: undefined });
    right.push({ text: age, style: { fg: '90', dim: true } });
  }
  return { spans, right };
}

// ── Header zone (drawn manually above the board list) ──────────────────────────

/**
 * Visible (column) width of a span group — ANSI-free cell count. Mirrors
 * draw.ts's internal `spanWidth` so the header can reserve room for a
 * right-flushed group before clipping the left line (Array.from counts code
 * points, so wide/combined glyphs count as one cell each, like the renderer).
 * @param {import('../../core/tui/draw.js').Span[]} spans @returns {number}
 */
function spanWidth(spans) {
  let n = 0;
  for (const s of spans) n += Array.from(s.text).length;
  return n;
}

/**
 * Paint the always-on header gauges into the top of `content`: branch line then
 * commit line, with right-flushed metadata. Returns the number of rows consumed
 * (incl. the trailing hairline) so render can place the board below it.
 * @param {GitState} g
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} content
 * @param {number} now
 * @returns {number} rows consumed
 */
function drawHeader(g, draw, content, now) {
  const right = content.col + content.width; // exclusive right edge for spansRight
  let r = content.row;

  // ── Branch line: ⎇ branch → upstream  ↑N ↓M   ·····  [tree chip right-flush]
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const left = [
    { text: ' ', style: undefined },
    { text: '⎇ ', style: { fg: '36' } },
    { text: g.branch, style: { fg: '36', bold: true } }, // cyan identity
  ];
  if (g.upstream) {
    left.push({ text: ` → ${g.upstream}`, style: { fg: '90', dim: true } });
    if (g.ahead) left.push({ text: ` ↑${g.ahead}`, style: { fg: '32' } }); // green ahead-ok
    if (g.behind) left.push({ text: ` ↓${g.behind}`, style: { fg: '33' } }); // yellow attention
    if (!g.ahead && !g.behind) left.push({ text: ' ✓ up to date', style: { fg: '32' } });
  } else {
    left.push({ text: ' · no upstream', style: { fg: '90', dim: true } });
  }
  // Tree chip, right-flushed on the same row (clean = green ✓, else colored counts).
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const chip = [];
  if (g.files.length === 0) {
    chip.push({ text: '✓ clean', style: { fg: '32' } });
  } else {
    const c = g.counts;
    /** @param {number} n @param {string} word @param {string} glyph @param {string} fg */
    const seg = (n, word, glyph, fg) => {
      if (!n) return;
      if (chip.length) chip.push({ text: '  ', style: undefined });
      chip.push({ text: `${glyph} ${n} ${word}`, style: { fg } });
    };
    seg(c.conflict, 'conflict', '✗', '31');
    seg(c.staged, 'staged', '●', '32');
    seg(c.modified, 'modified', '○', '33');
    seg(c.untracked, 'untracked', '?', '90');
  }
  // Clip the left line so the right-flushed chip never overpaints its tail
  // (mirror draw.list's leftLimit = width − rightWidth − 1).
  const chipW = spanWidth(chip);
  draw.spans(r, content.col, left, chipW ? Math.max(0, content.width - chipW - 1) : content.width);
  draw.spansRight(r, right, chip);
  r++;

  // ── Commit line: ⊙ sha subject ............................ age (right-flush)
  if (g.lastCommit) {
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const commit = [
      { text: ' ', style: undefined },
      { text: '⊙ ', style: { fg: '90', dim: true } },
      { text: g.lastCommit.sha, style: { fg: '33' } }, // yellow sha (git-native)
      { text: '  ', style: undefined },
      { text: g.lastCommit.subject, style: undefined },
    ];
    // Build the right-flushed age first, then clip the subject so the age never
    // overpaints it (mirror draw.list's leftLimit).
    const age = relAge(g.lastCommit.when, now);
    /** @type {import('../../core/tui/draw.js').Span[]} */
    const ageSpans = age ? [{ text: age, style: { fg: '90', dim: true } }] : [];
    const ageW = spanWidth(ageSpans);
    draw.spans(r, content.col, commit, ageW ? Math.max(0, content.width - ageW - 1) : content.width);
    if (age) draw.spansRight(r, right, ageSpans);
  } else {
    draw.spans(r, content.col, [
      { text: ' ', style: undefined },
      { text: '⊙ ', style: { fg: '90', dim: true } },
      { text: 'no commits yet', style: { dim: true } },
    ]);
  }
  r++;

  // Hairline separating the gauges from the board (figure-ground, §3).
  draw.hline(r, content.col, content.col + content.width);
  r++;

  return r - content.row;
}

// ── Refresh (data lane) ────────────────────────────────────────────────────────

/**
 * Read git + PR state, rebuild the board. Runs in the host's single-flight lane.
 * Maps any git failure to guidance (a banner + the freshness chip) and KEEPS the
 * last-known board on a transient git-failed. PR failures degrade the PR section
 * only (an inline note) — the git section always renders.
 * @param {GitPrState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<void>}
 */
async function refresh(state, host) {
  host.setStatus('Reading git…');

  const g = await fetchGit();
  if (!g.ok) {
    state.gitError = g.error.message;
    state.gitErrorKind = g.error.kind;
    if (g.error.kind === 'git-failed' && state.git) {
      // Transient — keep the last-known board; raise the cause as a banner.
      host.setError(state.gitError);
    } else {
      // Hard not-ready (no repo / no git binary / first-load failure): drop data
      // so render() shows the guided takeover. The takeover owns the whole rect
      // (design §3) and already names the cause + next step, so DON'T stack a
      // banner under it — clear any stale one. (Soft/partial cases — a transient
      // git-failed that keeps the board, or gh-down — keep their banner below.)
      state.git = null;
      state.prs = [];
      state.prNote = null;
      state.board = buildBoard(state);
      host.setError(null);
    }
    host.setStatus(null);
    host.setSubtitle(subtitleFor(state));
    state.lastFetch = Date.now();
    return;
  }
  state.gitError = null;
  state.gitErrorKind = null;
  state.git = g.data;

  // PRs — best-effort. A typed error becomes the PR section's guided note.
  const p = await fetchPrs(g.data.branch);
  if (p.ok) {
    state.prs = p.data;
    state.prNote = null;
  } else {
    state.prs = [];
    state.prNote = p.error.message;
  }

  state.board = buildBoard(state);
  if (state.cursor >= state.board.length) state.cursor = Math.max(0, state.board.length - 1);
  state.lastFetch = Date.now();

  host.setSubtitle(subtitleFor(state));

  // Data-freshness → state chip. Something that needs eyes (conflicts / failing
  // CI / changes-requested) → ACTION banner ⇒ attention (yellow). Else clear ⇒
  // ready (green). (busy→working is automatic.)
  const attn = attentionFor(state);
  if (attn) host.setBanner(attn, 'action');
  else host.setError(null);

  host.setStatus(footerSummary(state));
}

// ── ViewModule ─────────────────────────────────────────────────────────────────

/** @type {import('../../core/tui/contract.js').ViewModule<GitPrState>} */
const view = {
  manifest: {
    id: 'git-pr',
    title: 'Git / PR',
    description: 'Local git state + GitHub PR/CI status for the repo at this cwd',
    refreshMs: 5000,
    keymap: [
      { keys: 'j/k', label: 'move' },
      { keys: 'g', label: 'refresh' },
      { keys: 'q', label: 'quit' },
    ],
  },

  /**
   * Cheap + synchronous initial state — NO slow fetch (the host paints a loading
   * frame, then calls refresh()).
   * @returns {GitPrState}
   */
  init() {
    return {
      git: null,
      gitError: null,
      gitErrorKind: null,
      prs: [],
      prNote: null,
      board: [],
      cursor: 0,
      scroll: 0,
      lastFetch: 0,
    };
  },

  refresh,

  /**
   * Paint the header + board, or one of the four standard states. Pure (reads
   * state, calls draw.*); the only write is storing draw.list's adjusted scroll.
   * @param {GitPrState} state
   * @param {import('../../core/tui/draw.js').Draw} draw
   * @param {import('../../core/tui/draw.js').Rect} content
   */
  render(state, draw, content) {
    if (content.width <= 0 || content.height <= 0) return;

    // ── Whole-screen takeovers (no git data to anchor a header) ──
    if (!state.git) {
      if (state.gitErrorKind === 'not-a-repo') {
        notReadyState(draw, content, {
          glyph: '⊙',
          glyphFg: '33', // yellow — pairs with the action chip
          headline: 'Not a git repository',
          explanation: 'This view monitors a git repo, and the current directory is not one.',
          nextStep: 'cd into a repository (or run `git init`), then press g.',
        });
        return;
      }
      if (state.gitErrorKind === 'git-missing') {
        notReadyState(draw, content, {
          glyph: '⚠',
          glyphFg: '31', // red — pairs with the blocked chip
          headline: 'git not found',
          explanation: 'crtr could not find the git binary on PATH.',
          nextStep: 'Install git, then press g.',
        });
        return;
      }
      if (state.lastFetch === 0) {
        loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Reading git…' });
        return;
      }
      // git-failed on the first load (nothing to keep) → guided takeover.
      notReadyState(draw, content, {
        glyph: '⚠',
        glyphFg: '31',
        headline: 'Git unavailable',
        explanation: state.gitError || 'A git command failed.',
        nextStep: 'Press g to retry.',
      });
      return;
    }

    const now = Date.now();
    const g = state.git;

    // ── Header gauges (always on when we have git data) ──
    // Need ≥3 rows for the 2-row header + hairline; below that, skip straight to
    // the board so a tiny pane still shows the changes.
    let bodyRow = content.row;
    let bodyHeight = content.height;
    if (content.height >= 4) {
      const used = drawHeader(g, draw, content, now);
      bodyRow = content.row + used + (content.height - used > 2 ? 1 : 0); // 1-row section gap when there's room
      bodyHeight = content.row + content.height - bodyRow;
    }
    if (bodyHeight <= 0) return;
    const bodyRect = { row: bodyRow, col: content.col, width: content.width, height: bodyHeight };

    // ── Empty reward: clean tree + no open PRs + gh healthy → "All clear" ──
    if (g.files.length === 0 && state.prs.length === 0 && !state.prNote) {
      emptyState(draw, bodyRect, {
        headline: 'All clear',
        secondary: [`${g.branch} — clean working tree, no open PRs.`, 'Press g to refresh.'],
      });
      return;
    }

    // ── The board ──
    const items = state.board.map((row) => rowToItem(row, now));
    const res = draw.list(bodyRect, items, state.cursor, state.scroll);
    state.scroll = res.scroll; // store adjusted scroll back (Draw.list contract)
  },

  /**
   * Read-only navigation: j/k move the cursor, g refreshes, q quits. No async
   * actions — this is a monitor, not a controller.
   * @param {import('../../core/tui/contract.js').ViewKey} k
   * @param {GitPrState} state
   * @returns {import('../../core/tui/contract.js').ViewAction}
   */
  onKey(k, state) {
    const key = k.key;
    const ch = k.input;
    if (ch === 'q') return { type: 'quit' };
    if (ch === 'g') return { type: 'refresh' };
    if (key.downArrow || ch === 'j') {
      if (state.board.length) state.cursor = Math.min(state.board.length - 1, state.cursor + 1);
      return { type: 'render' };
    }
    if (key.upArrow || ch === 'k') {
      state.cursor = Math.max(0, state.cursor - 1);
      return { type: 'render' };
    }
    return { type: 'none' };
  },

  /**
   * Plain-text snapshot for the non-TTY / piped path. No ANSI. The host threads
   * its current banner via `ctx` so guidance surfaces without mirroring it.
   * @param {GitPrState} state
   * @param {import('../../core/tui/contract.js').DumpContext} [ctx]
   * @returns {string}
   */
  dump(state, ctx) {
    /** @type {string[]} */
    const lines = ['Git / PR board'];
    const banner = ctx && ctx.banner ? ctx.banner : null;
    if (banner) lines.push('', `[${banner.level}] ${banner.msg}`);
    else if (state.gitError) lines.push('', `[error] ${state.gitError}`);

    const g = state.git;
    if (!g) {
      lines.push('', state.lastFetch === 0 ? '(reading git…)' : '(git unavailable)');
      return lines.join('\n');
    }

    const now = Date.now();

    // Header.
    let head = `⎇ ${g.branch}`;
    if (g.upstream) {
      head += ` → ${g.upstream}`;
      if (g.ahead) head += ` ↑${g.ahead}`;
      if (g.behind) head += ` ↓${g.behind}`;
      if (!g.ahead && !g.behind) head += ' (up to date)';
    } else {
      head += ' (no upstream)';
    }
    head += `  ·  ${treePhrase(g)}`;
    lines.push('', head);
    if (g.lastCommit) {
      lines.push(`⊙ ${g.lastCommit.sha} ${g.lastCommit.subject}  (${relAge(g.lastCommit.when, now)})`);
    } else {
      lines.push('⊙ no commits yet');
    }

    // Working tree.
    lines.push('', 'Working tree');
    if (g.files.length === 0) {
      lines.push('  ✓ nothing to commit, working tree clean');
    } else {
      for (const f of g.files) {
        const churn = f.add || f.del ? `  +${f.add} −${f.del}` : '';
        lines.push(`  ${f.xy.replace(/ /g, '·')}  ${f.path}${churn}  [${f.cls}]`);
      }
    }

    // Pull requests.
    lines.push('', 'Pull requests');
    if (state.prNote) {
      lines.push(`  · ${state.prNote}`);
    } else if (state.prs.length === 0) {
      lines.push('  · No open pull requests.');
    } else {
      for (const pr of state.prs) {
        const mark = pr.current ? '*' : ' ';
        const draft = pr.isDraft ? ' (draft)' : '';
        lines.push(
          `  ${mark}#${pr.number} ${pr.title}${draft}  [review:${pr.review} ci:${pr.ci}]  (${relAge(pr.updatedAt, now)})`
        );
      }
    }

    return lines.join('\n');
  },
};

export default view;
