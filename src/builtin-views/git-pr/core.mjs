// @ts-check
/**
 * Git / PR board — the PORTABLE CORE of the crtr `git-pr` view (manifest · init ·
 * sources · intents). The reference dual-target view: this one core renders in
 * BOTH targets — the tmux TUI (`crtr view run git-pr`, via `tui.mjs`) and the
 * React+Tailwind web page (`crtr view serve git-pr`, via `web.jsx`).
 *
 * Runs in BOTH Node and the browser, so it imports NOTHING — no `node:*`, no
 * crtr. The data layer that used to shell `git`/`gh` directly (`client.mjs`'s
 * `execFile`) is now expressed as transport-agnostic `Source` descriptors: the
 * core describes WHAT to run (`request()` → a SourceRequest), the host's
 * Transport runs it (local `execFile` for the TUI, the HTTP bridge for web), and
 * the pure `parse()` turns bytes → typed data. All the porcelain/JSON parsing
 * (parseStatus / rollupCi / relAge / classifyGh …) moved here verbatim — it is
 * pure string work that runs anywhere.
 *
 * NOTHING throws. Sources return a `Result<T>` (typed `SourceError` on failure);
 * the `refresh` intent maps a blocking git error to a guided takeover and keeps
 * the last-known board on a transient failure (graceful partial failure).
 *
 * @module git-pr/core
 */

/**
 * @typedef {import('../../core/view/contract.js').Source<any, any>} AnySource
 * @typedef {import('../../core/view/contract.js').SourceError} SourceError
 * @typedef {import('../../core/view/contract.js').RawResponse} RawResponse
 * @typedef {import('../../core/view/contract.js').IntentCtx<GitPrState>} Ctx
 */

/**
 * One changed file, flattened from `git status --porcelain=v1 -z`.
 * @typedef {Object} ChangedFile
 * @property {string} path
 * @property {string} xy
 * @property {'staged'|'modified'|'untracked'|'conflict'} cls
 * @property {number} add
 * @property {number} del
 */
/**
 * Local git state. `lastCommit` / `upstream` are null on an empty repo / a branch
 * with no upstream — degraded fields, not errors.
 * @typedef {Object} GitState
 * @property {string} branch
 * @property {boolean} detached
 * @property {string|null} upstream
 * @property {number} ahead
 * @property {number} behind
 * @property {{sha:string, subject:string, when:string}|null} lastCommit
 * @property {ChangedFile[]} files
 * @property {{staged:number, modified:number, untracked:number, conflict:number}} counts
 */
/**
 * One open pull request, flattened from `gh pr list --json …`.
 * @typedef {Object} Pr
 * @property {number} number
 * @property {string} title
 * @property {string} headRefName
 * @property {boolean} isDraft
 * @property {boolean} current
 * @property {'approved'|'changes'|'review'} review
 * @property {'pass'|'fail'|'pending'|'none'} ci
 * @property {string} updatedAt
 */
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
 * The view's immutable state (the core owns it; intents replace it via ctx.set).
 * @typedef {Object} GitPrState
 * @property {GitState|null} git
 * @property {SourceError|null} gitErr   Typed git failure; presenters render its `display` VERBATIM.
 * @property {Pr[]} prs
 * @property {string|null} prNote
 * @property {BoardRow[]} board
 * @property {number} cursor
 * @property {number} scroll
 * @property {number} lastFetch
 */

// ── Result helpers (inlined — the core imports nothing) ───────────────────────

/** @template T @param {T} data @returns {{ok:true, data:T}} */
function ok(data) {
  return { ok: true, data };
}
/** @param {SourceError} error @returns {{ok:false, error:SourceError}} */
function fail(error) {
  return { ok: false, error };
}

// ── Tiny pure utilities ───────────────────────────────────────────────────────

/** @param {string} s @returns {string} */
function firstLine(s) {
  const lines = String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[0] : '';
}

/** @param {string|number} v @returns {number} */
function toInt(v) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

/** @param {number} n @param {string} w @returns {string} */
export function plural(n, w) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Relative-age ladder (design §5): `now` (<60s), `{m}m` (<60m), `{h}h` (<24h),
 * `{d}d` (<7d), else `Mon D` (`Mar 4`), prior-year `Mon ʼYY`. Max ~5 cols.
 * Shared by the TUI render + the text dump (both import it from here).
 * @param {string} iso @param {number} now @returns {string}
 */
export function relAge(iso, now) {
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

// ── git: status / churn parsing (lifted verbatim from client.mjs) ─────────────

/**
 * Classify a porcelain XY pair into the file's primary class.
 * @param {string} x @param {string} y
 * @returns {'staged'|'modified'|'untracked'|'conflict'}
 */
function classify(x, y) {
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === '?' || y === '?') return 'untracked';
  if (y !== ' ' && y !== '') return 'modified';
  if (x !== ' ' && x !== '') return 'staged';
  return 'modified';
}

/**
 * Parse `git status --porcelain=v1 -z -uall` into changed files + column tallies.
 * @param {string} stdout
 * @returns {{files: ChangedFile[], counts: GitState['counts']}}
 */
function parseStatus(stdout) {
  const parts = String(stdout || '').split('\0');
  /** @type {ChangedFile[]} */
  const files = [];
  const counts = { staged: 0, modified: 0, untracked: 0, conflict: 0 };
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 3) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i++;
    const cls = classify(x, y);
    if (cls === 'conflict') counts.conflict++;
    else if (cls === 'untracked') counts.untracked++;
    else {
      if (x !== ' ' && x !== '?' && x !== '') counts.staged++;
      if (y !== ' ' && y !== '?' && y !== '') counts.modified++;
    }
    files.push({ path, xy: `${x}${y}`, cls, add: 0, del: 0 });
  }
  return { files, counts };
}

/**
 * Parse `git diff [--cached] --numstat` into a path→churn map. Binary files
 * (`-\t-`) and renames (`old => new`) are skipped — churn is best-effort.
 * @param {string} stdout
 * @returns {Array<{path:string, add:number, del:number}>}
 */
function parseNumstat(stdout) {
  /** @type {Array<{path:string, add:number, del:number}>} */
  const out = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.split('\t');
    if (m.length < 3) continue;
    const add = m[0];
    const del = m[1];
    const path = m.slice(2).join('\t');
    if (add === '-' || del === '-' || path.includes(' => ')) continue;
    out.push({ path, add: toInt(add), del: toInt(del) });
  }
  return out;
}

const CLASS_RANK = { conflict: 0, staged: 1, modified: 2, untracked: 3 };

// ── gh: rollups + classification (lifted verbatim from client.mjs) ────────────

const CI_BAD = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const CI_GOOD = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/** @param {any[]|undefined} items @returns {'pass'|'fail'|'pending'|'none'} */
function rollupCi(items) {
  if (!Array.isArray(items) || items.length === 0) return 'none';
  let pending = false;
  for (const it of items) {
    const concl = String((it && it.conclusion) || '').toUpperCase();
    const state = String((it && it.state) || '').toUpperCase();
    const status = String((it && it.status) || '').toUpperCase();
    if (CI_BAD.has(concl) || CI_BAD.has(state)) return 'fail';
    if (status && status !== 'COMPLETED') pending = true;
    else if (state && !CI_GOOD.has(state) && !CI_BAD.has(state)) pending = true;
    else if (!concl && !state && !status) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

/** @param {string} d @returns {'approved'|'changes'|'review'} */
function normReview(d) {
  const s = String(d || '').toUpperCase();
  if (s === 'APPROVED') return 'approved';
  if (s === 'CHANGES_REQUESTED') return 'changes';
  return 'review';
}

// ── Typed SourceError displays (the `display`/`kind` split; presenters render
//    `display` verbatim and never branch on `kind`) ────────────────────────────

/** @type {SourceError} */
const GIT_MISSING = {
  kind: 'git-missing',
  display: {
    headline: 'git not found',
    explanation: 'crtr could not find the git binary on PATH.',
    nextStep: 'Install git, then press g.',
    level: 'error',
    blocking: true,
  },
};
/** @type {SourceError} */
const NOT_A_REPO = {
  kind: 'not-a-repo',
  display: {
    headline: 'Not a git repository',
    explanation: 'This view monitors a git repo, and the current directory is not one.',
    nextStep: 'cd into a repository (or run `git init`), then press g.',
    level: 'action',
    blocking: true,
  },
};
/** @param {string} msg @returns {SourceError} */
function gitFailed(msg) {
  return {
    kind: 'git-failed',
    display: {
      headline: 'Git unavailable',
      explanation: msg || 'A git command failed.',
      nextStep: 'Press g to retry.',
      level: 'error',
      blocking: false,
    },
  };
}
/** @param {string} kind @param {string} headline @returns {SourceError} */
function ghError(kind, headline) {
  return { kind, display: { headline, explanation: '', nextStep: '', level: 'info', blocking: false } };
}
/**
 * Classify a failed `gh` invocation into a guided PR-section note (auth first,
 * then network, then a missing remote, else generic).
 * @param {string} stderr @returns {SourceError}
 */
function classifyGh(stderr) {
  const s = String(stderr || '').toLowerCase();
  if (/auth|logged in|gh auth login|authentication|not logged/.test(s)) {
    return ghError('gh-unauthed', 'gh is not authenticated — run `gh auth login`.');
  }
  if (/could not resolve host|dial tcp|network is unreachable|no such host|timeout|temporary failure|connection refused/.test(s)) {
    return ghError('gh-network', 'Cannot reach GitHub (offline?).');
  }
  if (/could not resolve to a repository|no git remote|none of the git remotes|no default remote|not a github|head branch could not/.test(s)) {
    return ghError('gh-no-remote', 'No GitHub remote for this repository.');
  }
  return ghError('gh-failed', firstLine(stderr) || 'gh command failed.');
}

// ── Sources (reads): a request descriptor + a pure parse. The host's transport
//    runs the request (local execFile for TUI, the HTTP bridge for web). ───────

/**
 * PRIMARY git instrument — working-tree status. Its parse owns the three hard
 * git states (missing binary / not-a-repo / a failing git command); empty-repo
 * and no-upstream degrade to null fields on the secondary reads, not errors.
 * @type {import('../../core/view/contract.js').Source<{files:ChangedFile[], counts:GitState['counts']}>}
 */
export const gitStatusSource = {
  id: 'git-status',
  request: () => ({ kind: 'exec', bin: 'git', args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'] }),
  parse: (raw) => {
    if (!raw.ok) return fail(GIT_MISSING);
    if (raw.exitCode !== 0) {
      const s = String(raw.stderr || '').toLowerCase();
      if (/not a git repository/.test(s)) return fail(NOT_A_REPO);
      return fail(gitFailed(firstLine(raw.stderr)));
    }
    return ok(parseStatus(raw.stdout));
  },
};

/** Current branch name ('' ⇒ detached HEAD; resolve via gitHeadSource). */
export const gitBranchSource = {
  id: 'git-branch',
  request: () => ({ kind: 'exec', bin: 'git', args: ['branch', '--show-current'] }),
  parse: (raw) => ok(raw.ok && raw.exitCode === 0 ? raw.stdout.trim() : ''),
};

/** Short HEAD sha — used to label a detached HEAD. */
export const gitHeadSource = {
  id: 'git-head',
  request: () => ({ kind: 'exec', bin: 'git', args: ['rev-parse', '--short', 'HEAD'] }),
  parse: (raw) => ok(raw.ok && raw.exitCode === 0 ? raw.stdout.trim() : ''),
};

/** Tracking ref (e.g. "origin/main") or null when no upstream is set. */
export const gitUpstreamSource = {
  id: 'git-upstream',
  request: () => ({ kind: 'exec', bin: 'git', args: ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'] }),
  parse: (raw) => ok(raw.ok && raw.exitCode === 0 ? raw.stdout.trim() : null),
};

/** Ahead/behind vs upstream (only meaningful when an upstream exists). */
export const gitAheadBehindSource = {
  id: 'git-ahead-behind',
  request: () => ({ kind: 'exec', bin: 'git', args: ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'] }),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return ok({ ahead: 0, behind: 0 });
    const nums = raw.stdout.trim().split(/\s+/);
    return ok({ behind: toInt(nums[0]), ahead: toInt(nums[1]) });
  },
};

/** Last commit (null on an empty repo). */
export const gitLogSource = {
  id: 'git-log',
  request: () => ({ kind: 'exec', bin: 'git', args: ['log', '-1', '--pretty=%h%x1f%s%x1f%cI'] }),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0 || raw.stdout.trim() === '') return ok(null);
    const [sha, subject, when] = raw.stdout.replace(/\n$/, '').split('\x1f');
    return ok({ sha: sha || '', subject: subject || '', when: when || '' });
  },
};

/** Unstaged churn (best-effort; never fatal). */
export const gitDiffSource = {
  id: 'git-diff',
  request: () => ({ kind: 'exec', bin: 'git', args: ['diff', '--numstat'] }),
  parse: (raw) => ok(raw.ok && raw.exitCode === 0 ? parseNumstat(raw.stdout) : []),
};

/** Staged churn (best-effort; never fatal). */
export const gitDiffCachedSource = {
  id: 'git-diff-cached',
  request: () => ({ kind: 'exec', bin: 'git', args: ['diff', '--cached', '--numstat'] }),
  parse: (raw) => ok(raw.ok && raw.exitCode === 0 ? parseNumstat(raw.stdout) : []),
};

/**
 * Open PRs for this repo. BEST-EFFORT: a typed error becomes the PR section's
 * guided note (the git section is unaffected). `current`/sort-by-current is
 * applied in `refresh` (parse has no access to the branch).
 * @type {import('../../core/view/contract.js').Source<Pr[]>}
 */
export const prsSource = {
  id: 'prs',
  request: () => ({
    kind: 'exec', bin: 'gh',
    args: ['pr', 'list', '--state', 'open', '--limit', '30', '--json',
      'number,title,headRefName,reviewDecision,statusCheckRollup,updatedAt,isDraft'],
  }),
  parse: (raw) => {
    if (!raw.ok) return fail(ghError('gh-missing', 'gh (GitHub CLI) not found — install it to see PRs.'));
    if (raw.exitCode !== 0) return fail(classifyGh(raw.stderr || raw.stdout));
    let arr;
    try {
      arr = JSON.parse(raw.stdout.trim() || '[]');
    } catch {
      return fail(ghError('gh-failed', 'could not parse gh output as JSON.'));
    }
    if (!Array.isArray(arr)) arr = [];
    /** @type {Pr[]} */
    const prs = arr.map((p) => {
      const o = p || {};
      const head = String(o.headRefName || '');
      return {
        number: typeof o.number === 'number' ? o.number : toInt(o.number),
        title: String(o.title || '(untitled)'),
        headRefName: head,
        isDraft: !!o.isDraft,
        current: false,
        review: normReview(o.reviewDecision),
        ci: rollupCi(o.statusCheckRollup),
        updatedAt: String(o.updatedAt || ''),
      };
    });
    return ok(prs);
  },
};

// ── Board model + chrome copy (shared by render + dump; pure) ──────────────────

/**
 * Flatten git + PR state into the ordered board rows. Each section degrades
 * inline (a clean reward row / a guided gh note / a "no open PRs" note).
 * @param {GitPrState} state @returns {BoardRow[]}
 */
export function buildBoard(state) {
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

/** Working-tree state as one short phrase, for the subtitle + dump. @param {GitState} g */
export function treePhrase(g) {
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

/** Live title subtitle — branch + tracking delta + tree state. @param {{git:GitState|null}} state */
function subtitleFor(state) {
  const g = state.git;
  if (!g) return null;
  let s = g.branch;
  if (g.ahead) s += ` ↑${g.ahead}`;
  if (g.behind) s += ` ↓${g.behind}`;
  s += ` · ${treePhrase(g)}`;
  return s;
}

/** Footer status (left, transient). @param {{git:GitState|null, prs:Pr[], prNote:string|null}} state */
function footerSummary(state) {
  const g = state.git;
  if (!g) return null;
  const files = g.files.length === 0 ? 'clean' : plural(g.files.length, 'change');
  const prs = state.prNote ? 'PRs n/a' : plural(state.prs.length, 'PR');
  return `${files} · ${prs}`;
}

/** The one thing that wants a human's eyes → an ACTION banner. @param {{git:GitState|null, prs:Pr[], prNote:string|null}} state */
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

// ── The portable core ──────────────────────────────────────────────────────────

/** @type {import('../../core/view/contract.js').ViewCore<GitPrState>} */
const core = {
  manifest: {
    id: 'git-pr',
    title: 'Git / PR',
    description: 'Local git state + GitHub PR/CI status for the repo at this cwd',
    refreshMs: 5000,
  },

  /** Cheap + synchronous initial state — NO fetch (the host paints a loading
   *  frame, then dispatches the first 'refresh'). @returns {GitPrState} */
  init() {
    return {
      git: null,
      gitErr: null,
      prs: [],
      prNote: null,
      board: [],
      cursor: 0,
      scroll: 0,
      lastFetch: 0,
    };
  },

  sources: {
    gitStatusSource,
    gitBranchSource,
    gitHeadSource,
    gitUpstreamSource,
    gitAheadBehindSource,
    gitLogSource,
    gitDiffSource,
    gitDiffCachedSource,
    prsSource,
  },

  intents: {
    /**
     * Read git + PR state, rebuild the board. Runs in the host's single-flight
     * lane. A BLOCKING git error (no binary / not a repo) drops to a guided
     * takeover; a transient git-failed KEEPS the last-known board + a banner. PR
     * failures degrade the PR section only (an inline note).
     * @param {Ctx} ctx
     */
    async refresh(ctx) {
      ctx.signal.setStatus('Reading git…');

      const st = await ctx.resolve(gitStatusSource);
      if (!st.ok) {
        const err = st.error;
        const hadGit = ctx.state.git != null;
        // git-failed WITH a last-known board ⇒ keep it (transient). Hard cases
        // (not-a-repo / git-missing) and a first-load git-failed ⇒ takeover.
        const keep = !err.display.blocking && hadGit;
        ctx.set((s) => {
          /** @type {GitPrState} */
          const next = { ...s, gitErr: err };
          if (!keep) {
            next.git = null;
            next.prs = [];
            next.prNote = null;
            next.board = buildBoard(next);
          }
          next.lastFetch = Date.now();
          return next;
        });
        // A takeover owns the whole rect and already names cause + next step —
        // don't stack a banner under it. A kept board raises the cause instead.
        if (keep) ctx.signal.setBanner(err.display.explanation, err.display.level);
        else ctx.signal.clearBanner();
        ctx.signal.setStatus(null);
        ctx.signal.setSubtitle(keep ? subtitleFor(ctx.state) : null);
        return;
      }

      // Secondary git reads — independent, best-effort, resolved concurrently.
      const [brR, headR, upR, abR, logR, diffR, diffCR] = await Promise.all([
        ctx.resolve(gitBranchSource),
        ctx.resolve(gitHeadSource),
        ctx.resolve(gitUpstreamSource),
        ctx.resolve(gitAheadBehindSource),
        ctx.resolve(gitLogSource),
        ctx.resolve(gitDiffSource),
        ctx.resolve(gitDiffCachedSource),
      ]);

      let branch = brR.ok ? brR.data : '';
      let detached = false;
      if (branch === '') {
        detached = true;
        branch = headR.ok && headR.data ? `(detached ${headR.data})` : '(no branch)';
      }
      const upstream = upR.ok ? upR.data : null;
      let ahead = 0;
      let behind = 0;
      if (upstream && abR.ok) {
        ahead = abR.data.ahead;
        behind = abR.data.behind;
      }
      const lastCommit = logR.ok ? logR.data : null;

      // Churn (best-effort) → apply to the status files, then problems-first sort.
      /** @type {Map<string,{add:number,del:number}>} */
      const churn = new Map();
      const accChurn = (rows) => {
        for (const c of rows) {
          const prev = churn.get(c.path) || { add: 0, del: 0 };
          prev.add += c.add;
          prev.del += c.del;
          churn.set(c.path, prev);
        }
      };
      if (diffR.ok) accChurn(diffR.data);
      if (diffCR.ok) accChurn(diffCR.data);

      const { files, counts } = st.data;
      for (const f of files) {
        const c = churn.get(f.path);
        if (c) {
          f.add = c.add;
          f.del = c.del;
        }
      }
      files.sort((a, b) => {
        const r = CLASS_RANK[a.cls] - CLASS_RANK[b.cls];
        return r !== 0 ? r : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      });

      /** @type {GitState} */
      const git = { branch, detached, upstream, ahead, behind, lastCommit, files, counts };

      // PRs — best-effort. Mark the current-branch PR + sort it first.
      const p = await ctx.resolve(prsSource);
      /** @type {Pr[]} */
      let prs = [];
      /** @type {string|null} */
      let prNote = null;
      if (p.ok) {
        prs = p.data.map((pr) => ({ ...pr, current: pr.headRefName !== '' && pr.headRefName === branch }));
        prs.sort((a, b) => {
          if (a.current !== b.current) return a.current ? -1 : 1;
          return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0;
        });
      } else {
        prNote = p.error.display.headline;
      }

      ctx.set((s) => {
        /** @type {GitPrState} */
        const next = { ...s, git, gitErr: null, prs, prNote };
        next.board = buildBoard(next);
        if (next.cursor >= next.board.length) next.cursor = Math.max(0, next.board.length - 1);
        next.lastFetch = Date.now();
        return next;
      });

      const live = { git, prs, prNote };
      ctx.signal.setSubtitle(subtitleFor(live));
      const attn = attentionFor(live);
      if (attn) ctx.signal.setBanner(attn, 'action');
      else ctx.signal.clearBanner();
      ctx.signal.setStatus(footerSummary(live));
    },

    /** @param {Ctx} ctx */
    cursorDown: (ctx) => ctx.set((s) => ({ ...s, cursor: s.board.length ? Math.min(s.board.length - 1, s.cursor + 1) : 0 })),
    /** @param {Ctx} ctx */
    cursorUp: (ctx) => ctx.set((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) })),
    /** @param {Ctx} ctx @param {number} [i] */
    select: (ctx, i) => ctx.set((s) => ({ ...s, cursor: typeof i === 'number' ? Math.max(0, Math.min(s.board.length - 1, i)) : s.cursor })),
    /** @param {Ctx} ctx */
    quit: (ctx) => ctx.signal.quit(),
  },
};

export default core;
