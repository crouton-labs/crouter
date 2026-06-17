/**
 * Minimal line diff for edit/write cards. An LCS over lines yields a sequence
 * of context/added/removed lines — enough for a readable inline diff without a
 * dependency. Not a full Myers diff; fine for tool-call before/after bodies.
 */

export interface DiffLine {
  kind: 'ctx' | 'add' | 'del';
  text: string;
}

/** Cap on the LCS matrix (`(n+1)×(m+1)` cells). Edit/write hunks are normally
 *  small; a pathological huge hunk (e.g. a 3000-line replace) would allocate
 *  ~9M cells and jank/OOM the tab, so above this we fall back to a plain
 *  remove-all-then-add-all rendering instead of computing the LCS. */
const MAX_LCS_CELLS = 1_000_000;

export function lineDiff(oldStr: string, newStr: string): DiffLine[] {
  const a = (oldStr ?? '').split('\n');
  const b = (newStr ?? '').split('\n');
  const n = a.length;
  const m = b.length;

  // Guard the quadratic LCS: on an oversized hunk, render a plain before/after.
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    const out: DiffLine[] = [];
    for (const text of a) out.push({ kind: 'del', text });
    for (const text of b) out.push({ kind: 'add', text });
    return out;
  }

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ kind: 'del', text: a[i] });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: 'del', text: a[i++] });
  while (j < m) out.push({ kind: 'add', text: b[j++] });
  return out;
}
