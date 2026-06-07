// @ts-check
/**
 * Git / PR board data layer for the crtr `git-pr` view (a monitor archetype).
 *
 * Self-contained ESM, Node-builtins-only. Imports NOTHING from crtr so it ships
 * verbatim (`cp -R src/builtin-views dist/builtin-views`) and is dynamically
 * `import()`ed by the view at runtime where there is no TS toolchain.
 *
 * It shells `git` (local state) and `gh` (GitHub PR/CI state) over the view's
 * cwd — exactly as the canvas view shells `crtr` and the LinkedIn view shells
 * `capture`. Two independent domains:
 *   - `fetchGit()` → branch / upstream ahead·behind / working-tree status +
 *                    churn / last commit. The PRIMARY instrument.
 *   - `fetchPrs(branch)` → open PRs for this repo (review decision + CI rollup),
 *                    the current branch's PR first. BEST-EFFORT — its failure is
 *                    a guided note in the PR section, never a crash; the git
 *                    section still renders (graceful partial failure).
 *
 * NOTHING here throws. Every exported function returns a `Result<T>`; failures
 * surface as a typed `ClientError` so the view renders guidance, not a crash.
 * The error taxonomy (each → a view state):
 *   git:  git-missing · not-a-repo · git-failed   (empty-repo / no-upstream are
 *         NOT errors — they degrade to null fields the header renders).
 *   gh:   gh-missing · gh-unauthed · gh-no-remote · gh-network · gh-failed.
 *
 * @module git-pr/client
 */

import { execFile } from 'node:child_process';

// ── Types ────────────────────────────────────────────────────────────────────

/**
 * One changed file, flattened from `git status --porcelain=v1 -z`.
 * @typedef {Object} ChangedFile
 * @property {string} path       Display path (destination on a rename).
 * @property {string} xy         The two-char porcelain code (e.g. "M ", " M", "??", "UU").
 * @property {'staged'|'modified'|'untracked'|'conflict'} cls  Primary class (drives glyph + hue).
 * @property {number} add        Lines added (numstat; 0 if unknown/binary/untracked).
 * @property {number} del        Lines removed.
 */

/**
 * Local git state. `lastCommit` / `upstream` are null on an empty repo / a
 * branch with no upstream — the header renders the degraded form, not an error.
 * @typedef {Object} GitState
 * @property {string} branch     Branch name, or "(detached <sha>)" / "(no branch)".
 * @property {boolean} detached  True ⇒ detached HEAD.
 * @property {string|null} upstream  Tracking ref (e.g. "origin/main"), or null.
 * @property {number} ahead      Commits ahead of upstream.
 * @property {number} behind     Commits behind upstream.
 * @property {{sha:string, subject:string, when:string}|null} lastCommit
 * @property {ChangedFile[]} files   Changed files, problems-first then path.
 * @property {{staged:number, modified:number, untracked:number, conflict:number}} counts
 */

/**
 * One open pull request, flattened from `gh pr list --json …`.
 * @typedef {Object} Pr
 * @property {number} number
 * @property {string} title
 * @property {string} headRefName
 * @property {boolean} isDraft
 * @property {boolean} current   True ⇒ this PR's head is the checked-out branch.
 * @property {'approved'|'changes'|'review'} review   Normalized reviewDecision.
 * @property {'pass'|'fail'|'pending'|'none'} ci      Rolled-up statusCheckRollup.
 * @property {string} updatedAt  ISO 8601 (drives the right-flush age).
 */

/**
 * Typed failure. `kind` drives the view state / guidance.
 * @typedef {{kind:'git-missing', message:string}
 *   | {kind:'not-a-repo', message:string}
 *   | {kind:'git-failed', message:string}} GitError
 */
/**
 * @typedef {{kind:'gh-missing', message:string}
 *   | {kind:'gh-unauthed', message:string}
 *   | {kind:'gh-no-remote', message:string}
 *   | {kind:'gh-network', message:string}
 *   | {kind:'gh-failed', message:string}} GhError
 */
/** @typedef {GitError|GhError} ClientError */

/**
 * Never-throw return contract.
 * @template T
 * @typedef {{ok:true, data:T} | {ok:false, error:ClientError}} Result
 */

// ── Result helpers ───────────────────────────────────────────────────────────

/** @template T @param {T} data @returns {{ok:true, data:T}} */
function ok(data) {
  return { ok: true, data };
}
/** @param {ClientError} error @returns {{ok:false, error:ClientError}} */
function fail(error) {
  return { ok: false, error };
}

// ── Process runner (never throws) ────────────────────────────────────────────

/**
 * @typedef {Object} RunResult
 * @property {boolean} spawned   False ⇒ the binary is missing (ENOENT).
 * @property {number}  exitCode  0 on success; -1 if not spawned.
 * @property {string}  stdout
 * @property {string}  stderr
 */

/**
 * Run a binary. Resolves (never rejects). ENOENT ⇒ `spawned:false`. Runs in the
 * view's cwd (the repo under inspection) so `git`/`gh` operate on the right tree.
 * @param {string} bin
 * @param {string[]} argv
 * @returns {Promise<RunResult>}
 */
function run(bin, argv) {
  return new Promise((resolve) => {
    execFile(
      bin,
      argv,
      { maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', cwd: process.cwd() },
      (err, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : '';
        const errOut = typeof stderr === 'string' ? stderr : '';
        if (err && /** @type {any} */ (err).code === 'ENOENT') {
          resolve({ spawned: false, exitCode: -1, stdout: out, stderr: errOut });
          return;
        }
        const code = err
          ? typeof /** @type {any} */ (err).code === 'number'
            ? /** @type {any} */ (err).code
            : 1
          : 0;
        resolve({ spawned: true, exitCode: code, stdout: out, stderr: errOut });
      }
    );
  });
}

/** @param {string} s @returns {string} */
function firstLine(s) {
  const lines = String(s || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[0] : '';
}

/** @param {string} v @returns {number} */
function toInt(v) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : 0;
}

// ── git: status parsing ───────────────────────────────────────────────────────

/**
 * Classify a porcelain XY pair into the file's primary class. A file can be both
 * staged AND modified (e.g. `MM`); the worktree change wins the glyph (it's the
 * freshest, un-committed edit), but `counts` tallies both columns independently.
 * @param {string} x  Index column.
 * @param {string} y  Worktree column.
 * @returns {'staged'|'modified'|'untracked'|'conflict'}
 */
function classify(x, y) {
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict';
  if (x === '?' || y === '?') return 'untracked';
  if (y !== ' ' && y !== '') return 'modified'; // worktree change (incl. D)
  if (x !== ' ' && x !== '') return 'staged'; // index-only change
  return 'modified';
}

/**
 * Parse `git status --porcelain=v1 -z -uall` into changed files + column tallies.
 * The `-z` form is NUL-terminated; a rename/copy entry is followed by an extra
 * NUL field (the original path) which we consume.
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
    // A rename/copy carries the source path in the next NUL field — skip it.
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
 * @param {Map<string,{add:number,del:number}>} into
 */
function accChurn(stdout, into) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = line.split('\t');
    if (m.length < 3) continue;
    const add = m[0];
    const del = m[1];
    const path = m.slice(2).join('\t');
    if (add === '-' || del === '-' || path.includes(' => ')) continue;
    const prev = into.get(path) || { add: 0, del: 0 };
    prev.add += toInt(add);
    prev.del += toInt(del);
    into.set(path, prev);
  }
}

const CLASS_RANK = { conflict: 0, staged: 1, modified: 2, untracked: 3 };

// ── git: public API ───────────────────────────────────────────────────────────

/**
 * Read local git state for the view's cwd. Returns a typed error for the three
 * hard cases (no git binary, not a repo, a git command failing); empty-repo and
 * no-upstream degrade to null fields, NOT errors.
 * @returns {Promise<Result<GitState>>}
 */
export async function fetchGit() {
  const inside = await run('git', ['rev-parse', '--is-inside-work-tree']);
  if (!inside.spawned) {
    return fail({ kind: 'git-missing', message: 'git was not found on PATH — install git to use this view.' });
  }
  if (inside.exitCode !== 0 || inside.stdout.trim() !== 'true') {
    return fail({ kind: 'not-a-repo', message: 'The current directory is not a git repository.' });
  }

  // Branch (empty ⇒ detached HEAD; works even before the first commit).
  const br = await run('git', ['branch', '--show-current']);
  let branch = br.stdout.trim();
  let detached = false;
  if (branch === '') {
    detached = true;
    const head = await run('git', ['rev-parse', '--short', 'HEAD']);
    branch = head.exitCode === 0 ? `(detached ${head.stdout.trim()})` : '(no branch)';
  }

  // Upstream + ahead/behind (no upstream ⇒ null, ahead/behind 0).
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  const up = await run('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (up.exitCode === 0) {
    upstream = up.stdout.trim();
    const counts = await run('git', ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']);
    if (counts.exitCode === 0) {
      const nums = counts.stdout.trim().split(/\s+/);
      behind = toInt(nums[0]); // left  = in upstream, not HEAD
      ahead = toInt(nums[1]); // right = in HEAD, not upstream
    }
  }

  // Last commit (null on an empty repo).
  let lastCommit = null;
  const log = await run('git', ['log', '-1', '--pretty=%h%x1f%s%x1f%cI']);
  if (log.exitCode === 0 && log.stdout.trim() !== '') {
    const [sha, subject, when] = log.stdout.replace(/\n$/, '').split('\x1f');
    lastCommit = { sha: sha || '', subject: subject || '', when: when || '' };
  }

  // Working-tree status. A failure here (rare once we know it's a repo) is the
  // one genuine git-failed case.
  const st = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (!st.spawned) return fail({ kind: 'git-missing', message: 'git disappeared mid-read.' });
  if (st.exitCode !== 0) {
    return fail({ kind: 'git-failed', message: firstLine(st.stderr) || 'git status failed.' });
  }
  const { files, counts } = parseStatus(st.stdout);

  // Churn (best-effort; never fatal).
  /** @type {Map<string,{add:number,del:number}>} */
  const churn = new Map();
  const unstaged = await run('git', ['diff', '--numstat']);
  if (unstaged.exitCode === 0) accChurn(unstaged.stdout, churn);
  const staged = await run('git', ['diff', '--cached', '--numstat']);
  if (staged.exitCode === 0) accChurn(staged.stdout, churn);
  for (const f of files) {
    const c = churn.get(f.path);
    if (c) {
      f.add = c.add;
      f.del = c.del;
    }
  }

  // Problems first (conflict → staged → modified → untracked), then by path.
  files.sort((a, b) => {
    const r = CLASS_RANK[a.cls] - CLASS_RANK[b.cls];
    return r !== 0 ? r : a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return ok({ branch, detached, upstream, ahead, behind, lastCommit, files, counts });
}

// ── gh: rollups + classification ───────────────────────────────────────────────

const CI_BAD = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const CI_GOOD = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);

/**
 * Roll a PR's statusCheckRollup array into one verdict. CheckRun entries carry
 * `status` (QUEUED/IN_PROGRESS/COMPLETED) + `conclusion`; StatusContext entries
 * carry `state`. Any bad → fail; else any in-flight/unknown → pending; else pass.
 * @param {any[]|undefined} items
 * @returns {'pass'|'fail'|'pending'|'none'}
 */
function rollupCi(items) {
  if (!Array.isArray(items) || items.length === 0) return 'none';
  let pending = false;
  for (const it of items) {
    const concl = String((it && it.conclusion) || '').toUpperCase();
    const state = String((it && it.state) || '').toUpperCase();
    const status = String((it && it.status) || '').toUpperCase();
    if (CI_BAD.has(concl) || CI_BAD.has(state)) return 'fail';
    if (status && status !== 'COMPLETED') pending = true;
    else if (state && !CI_GOOD.has(state) && !CI_BAD.has(state)) pending = true; // PENDING/EXPECTED/QUEUED
    else if (!concl && !state && !status) pending = true; // shapeless ⇒ treat as in-flight
  }
  return pending ? 'pending' : 'pass';
}

/** @param {string} d @returns {'approved'|'changes'|'review'} */
function normReview(d) {
  const s = String(d || '').toUpperCase();
  if (s === 'APPROVED') return 'approved';
  if (s === 'CHANGES_REQUESTED') return 'changes';
  return 'review'; // REVIEW_REQUIRED / "" / null
}

/**
 * Classify a failed `gh` invocation. Auth first (the most common), then
 * network, then a missing/!GitHub remote, else generic.
 * @param {string} stderr
 * @returns {GhError}
 */
function classifyGh(stderr) {
  const s = String(stderr || '').toLowerCase();
  if (/auth|logged in|gh auth login|authentication|not logged/.test(s)) {
    return { kind: 'gh-unauthed', message: 'gh is not authenticated — run `gh auth login`.' };
  }
  if (/could not resolve host|dial tcp|network is unreachable|no such host|timeout|temporary failure|connection refused/.test(s)) {
    return { kind: 'gh-network', message: 'Cannot reach GitHub (offline?).' };
  }
  if (/could not resolve to a repository|no git remote|none of the git remotes|no default remote|not a github|head branch could not/.test(s)) {
    return { kind: 'gh-no-remote', message: 'No GitHub remote for this repository.' };
  }
  return { kind: 'gh-failed', message: firstLine(stderr) || 'gh command failed.' };
}

// ── gh: public API ─────────────────────────────────────────────────────────────

/**
 * Open PRs for this repo, the current branch's PR first then most-recently
 * updated. BEST-EFFORT: a typed error means the PR section degrades to a guided
 * note — the git section is unaffected.
 * @param {string} branch  The checked-out branch (to mark the current PR).
 * @returns {Promise<Result<Pr[]>>}
 */
export async function fetchPrs(branch) {
  const r = await run('gh', [
    'pr',
    'list',
    '--state',
    'open',
    '--limit',
    '30',
    '--json',
    'number,title,headRefName,reviewDecision,statusCheckRollup,updatedAt,isDraft',
  ]);
  if (!r.spawned) {
    return fail({ kind: 'gh-missing', message: 'gh (GitHub CLI) not found — install it to see PRs.' });
  }
  if (r.exitCode !== 0) return fail(classifyGh(r.stderr || r.stdout));

  let arr;
  try {
    arr = JSON.parse(r.stdout.trim() || '[]');
  } catch {
    return fail({ kind: 'gh-failed', message: 'could not parse gh output as JSON.' });
  }
  if (!Array.isArray(arr)) arr = [];

  /** @type {Pr[]} */
  const prs = arr.map((p) => {
    // Guard the whole element — gh shouldn't emit null array entries, but this
    // file's contract is never-throw, so dereference only off a safe object.
    const o = p || {};
    const head = String(o.headRefName || '');
    return {
      number: typeof o.number === 'number' ? o.number : toInt(o.number),
      title: String(o.title || '(untitled)'),
      headRefName: head,
      isDraft: !!o.isDraft,
      current: head !== '' && head === branch,
      review: normReview(o.reviewDecision),
      ci: rollupCi(o.statusCheckRollup),
      updatedAt: String(o.updatedAt || ''),
    };
  });

  prs.sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1; // current branch first
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0; // newest first
  });

  return ok(prs);
}

/**
 * Introspection helper (not used at runtime): the exact shell-outs this client
 * makes, so the shape can be eyeballed without a live repo.
 * @returns {Record<string,string>}
 */
export function describeCommands() {
  return {
    fetchGit:
      'git rev-parse --is-inside-work-tree · branch --show-current · rev-list --left-right --count @{u}...HEAD · log -1 · status --porcelain=v1 -z · diff [--cached] --numstat',
    fetchPrs: 'gh pr list --state open --json number,title,headRefName,reviewDecision,statusCheckRollup,updatedAt,isDraft',
  };
}
