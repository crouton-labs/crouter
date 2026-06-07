// @ts-check
/**
 * Canvas Dashboard — the crtr `canvas` view (the monitor archetype).
 *
 * Self-contained ESM. Imports its data layer from `./client.mjs` (which shells
 * the `crtr` binary) and the shared state helpers from `../_lib/states.mjs`. It
 * imports NOTHING from crtr — the host injects the `Draw` + `ViewHost` API and
 * dynamically `import()`s this module's DEFAULT EXPORT.
 *
 * A READ-ONLY monitor of the live agent graph: it rebuilds the forest from each
 * node's `parent` edge, keeps only trees that contain live (active/idle) or
 * human-blocked work, and renders them as a scrollable ASCII tree. It auto-polls
 * (refreshMs) — no node-focus / close / swap (views are sessionless). j/k move a
 * read cursor; g forces a refresh; q quits.
 *
 * VISUAL LANGUAGE (crtr-views-visual-design §2/§3/§4): hierarchy is carried by
 * weight + hue + position, never boxes. The status glyph hues match `canvas
 * browse`'s authoritative palette (active=green, idle=yellow, done=cyan,
 * dead=red, canceled=grey; asks=bright-yellow) — "not a recolor." The chrome's
 * one state chip is host-derived from data freshness (busy→working, an error
 * banner→blocked, an action banner→attention, else ready/idle), driven here by
 * toggling banners + the busy lane. Per-row metadata (the relative age) is
 * right-flushed via `ListItemRow.right`; secondary text recedes via grey+dim so
 * it survives NO_COLOR. The four standard states come from `_lib/states.mjs`.
 *
 * @module canvas/view
 */

import { fetchNodes, fetchAttention } from './client.mjs';
import { loadingState, emptyState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./client.mjs').CanvasNode} CanvasNode */
/** @typedef {import('./client.mjs').ClientError} ClientError */

/**
 * One rendered tree line (a flattened forest node). Width-independent, so it is
 * built once per refresh and re-rendered on resize without a re-fetch.
 * @typedef {Object} TreeRow
 * @property {string} nodeId
 * @property {string} prefix     Tree-branch art (e.g. "│  └─ "); '' for a root.
 * @property {string} glyph      Status glyph.
 * @property {string} status
 * @property {string} name
 * @property {string} kind
 * @property {string} mode
 * @property {string} lifecycle
 * @property {string} shortId
 * @property {string} created    ISO 8601 birth timestamp (drives the right-flush age).
 * @property {boolean} blocked   True ⇒ this node has pending human asks.
 * @property {number} askCount
 */

/**
 * The view's single mutable state object. The view owns it; hooks mutate it in
 * place.
 * @typedef {Object} CanvasState
 * @property {TreeRow[]} rows      Flattened active-tree forest (render source).
 * @property {number} cursor       Read cursor into rows (j/k).
 * @property {number} scroll       draw.list scroll, stored back each frame.
 * @property {number} shownRoots   How many trees survived the active filter.
 * @property {number} totalNodes   Total nodes on the canvas (all statuses).
 * @property {number} activeCount  Nodes with status 'active' (canvas-wide).
 * @property {number} attnTotal    Total pending human asks (canvas-wide).
 * @property {number} lastFetch    Epoch ms of the last successful refresh.
 * @property {string|null} sourceError  Non-null ⇒ the data source failed; the
 *   string is the cause (drives the not-ready takeover when there is no data, and
 *   is the dump fallback). Cleared on a successful refresh.
 */

// ── Status vocabulary (mirrors core/canvas/browse/render.ts — single source) ──

const LIVE_STATUS = new Set(['active', 'idle']);

/** @type {Record<string,string>} */
const STATUS_GLYPH = {
  active: '●',
  idle: '○',
  done: '✓',
  dead: '✗',
  canceled: '⊘',
};

/**
 * Load-bearing status hue — NUMERIC SGR codes, matching `canvas browse`'s
 * STATUS_COLOR exactly (active=green, idle=yellow, done=cyan, dead=red,
 * canceled=grey). The design is explicit: keep these, "this is not a recolor."
 * @type {Record<string,string>}
 */
const STATUS_FG = {
  active: '32', // green
  idle: '33', // yellow
  done: '36', // cyan
  dead: '31', // red
  canceled: '90', // grey
};

/** @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined} */
function glyphStyle(status) {
  const fg = STATUS_FG[status];
  return fg ? { fg } : undefined; // hue only — the glyph SHAPE is the mono carrier
}

/**
 * Name weight = hierarchy (design §2 "weight creates hierarchy"): live work
 * (active) LEADS in bold; terminal nodes (done/dead/canceled) recede dim; idle
 * stays default weight (readable, not shouting). Mono-safe (weight, not hue).
 * @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined}
 */
function nameStyle(status) {
  if (status === 'active') return { bold: true };
  if (status === 'done' || status === 'dead' || status === 'canceled') return { dim: true };
  return undefined;
}

/** @param {string} lifecycle @returns {string} */
function lifeAbbr(lifecycle) {
  if (lifecycle === 'resident') return 'res';
  if (lifecycle === 'terminal') return 'term';
  return lifecycle || '?';
}

/** @param {string} id @returns {string} */
function shortId(id) {
  const s = String(id || '');
  const dash = s.indexOf('-');
  return dash > 0 ? s.slice(0, dash) : s.slice(0, 8);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Relative-age ladder (design §5): `now` (<60s), `{m}m` (<60m), `{h}h` (<24h),
 * `{d}d` (<7d), else a calendar date `Mon D` (`Mar 4`), prior-year `Mon ʼYY`.
 * Max ~5 cols. Used for the right-flushed per-row age (the node's birth time).
 * @param {string} createdIso @param {number} now @returns {string}
 */
function relAge(createdIso, now) {
  const t = Date.parse(createdIso);
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

// ── Error → guidance text ─────────────────────────────────────────────────────

/**
 * Map a typed {@link ClientError} to guidance text (the host error banner +
 * dump fallback).
 * @param {ClientError} error
 * @returns {string}
 */
function bannerFor(error) {
  switch (error && error.kind) {
    case 'crtr-missing':
      return error.message;
    case 'crtr-failed':
      return 'crtr command failed: ' + (error.message || 'unknown error');
    case 'parse':
      return error.message || 'could not parse crtr output';
    case 'error':
      return (error && error.message) || 'Unknown error.';
    default:
      return (error && /** @type {any} */ (error).message) || 'Unknown error.';
  }
}

// ── Forest builder ───────────────────────────────────────────────────────────

/**
 * Build the flattened active-tree forest from a flat node list + the
 * human-blocked id→count map.
 *
 * A tree is shown iff its subtree contains any LIVE node (status active|idle) OR
 * any human-blocked node — so a fully-finished tree drops out, but a blocked one
 * always surfaces. Shown trees are rendered IN FULL (finished children included)
 * to preserve context, mirroring `crtr canvas dashboard`.
 *
 * @param {CanvasNode[]} nodes
 * @param {Map<string,number>} blockedById
 * @returns {{rows: TreeRow[], shownRoots: number}}
 */
function buildForest(nodes, blockedById) {
  /** @type {Map<string, CanvasNode>} */
  const byId = new Map();
  for (const n of nodes) byId.set(n.nodeId, n);

  /** @type {Map<string, CanvasNode[]>} */
  const children = new Map();
  /** @type {CanvasNode[]} */
  const roots = [];
  for (const n of nodes) {
    const parent = n.parent && byId.has(n.parent) ? n.parent : null;
    if (parent) {
      const arr = children.get(parent);
      if (arr) arr.push(n);
      else children.set(parent, [n]);
    } else {
      roots.push(n);
    }
  }
  // Order siblings + roots by birth time (matches spawn order).
  const cmp = (/** @type {CanvasNode} */ a, /** @type {CanvasNode} */ b) =>
    a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
  for (const arr of children.values()) arr.sort(cmp);
  roots.sort(cmp);

  // Subtree liveness, memoised + cycle-guarded (the graph is a forest, but the
  // db is mutable — guard defensively).
  /** @type {Map<string, boolean>} */
  const liveMemo = new Map();
  /** @param {string} id @param {Set<string>} guard @returns {boolean} */
  function subtreeLive(id, guard) {
    const memo = liveMemo.get(id);
    if (memo !== undefined) return memo;
    if (guard.has(id)) return false;
    guard.add(id);
    const node = byId.get(id);
    let res = !!node && (LIVE_STATUS.has(node.status) || blockedById.has(id));
    if (!res) {
      for (const c of children.get(id) || []) {
        if (subtreeLive(c.nodeId, guard)) {
          res = true;
          break;
        }
      }
    }
    guard.delete(id);
    liveMemo.set(id, res);
    return res;
  }

  /** @param {CanvasNode} node @param {string} prefix @returns {TreeRow} */
  function makeRow(node, prefix) {
    const askCount = blockedById.get(node.nodeId) || 0;
    return {
      nodeId: node.nodeId,
      prefix,
      glyph: STATUS_GLYPH[node.status] || '?',
      status: node.status,
      name: node.name,
      kind: node.kind,
      mode: node.mode,
      lifecycle: node.lifecycle,
      shortId: shortId(node.nodeId),
      created: node.created,
      blocked: askCount > 0,
      askCount,
    };
  }

  /** @type {TreeRow[]} */
  const rows = [];
  /** @type {Set<string>} */
  const visited = new Set();
  /** @param {CanvasNode} node @param {string} indent @param {boolean} isLast @param {boolean} isRoot */
  function walk(node, indent, isLast, isRoot) {
    if (visited.has(node.nodeId)) return; // cycle guard
    visited.add(node.nodeId);
    const prefix = isRoot ? '' : indent + (isLast ? '└─ ' : '├─ ');
    rows.push(makeRow(node, prefix));
    const kids = children.get(node.nodeId) || [];
    const childIndent = isRoot ? '' : indent + (isLast ? '   ' : '│  ');
    for (let i = 0; i < kids.length; i++) {
      walk(kids[i], childIndent, i === kids.length - 1, false);
    }
  }

  let shownRoots = 0;
  for (const r of roots) {
    if (!subtreeLive(r.nodeId, new Set())) continue;
    shownRoots++;
    walk(r, '', true, true);
  }
  return { rows, shownRoots };
}

// ── Chrome copy (subtitle / footer / banner / dump) ───────────────────────────

/**
 * Live title subtitle — canvas-wide health (design §3 "a dim ` · <subtitle>`").
 * `null` ⇒ no subtitle (the title leads alone) on an empty canvas.
 * @param {CanvasState} state @returns {string|null}
 */
function subtitleFor(state) {
  if (state.totalNodes === 0) return null;
  return `${state.activeCount} active · ${plural(state.totalNodes, 'node')}`;
}

/**
 * Footer status (left, transient) — the RENDERED forest scope, distinct from the
 * canvas-wide subtitle. `null` ⇒ nothing (the empty/loading state speaks).
 * @param {CanvasState} state @returns {string|null}
 */
function footerSummary(state) {
  if (state.rows.length === 0) return null;
  return `${plural(state.shownRoots, 'live tree')} · ${state.rows.length} shown`;
}

/** @param {CanvasState} state @returns {string} */
function dumpSummary(state) {
  return (
    `${plural(state.shownRoots, 'tree')} · ${state.rows.length} shown · ` +
    `${state.activeCount} active · ${plural(state.attnTotal, 'ask')} · ` +
    `${state.totalNodes} total`
  );
}

// ── Row → ListItemRow (left spans + right-flushed age) ─────────────────────────

/**
 * Build one list row: a 1-cell left gutter (§2), the tree prefix (dim), the
 * status glyph (hue), the name (weight = status), the dim `[kind/mode]` cue, and
 * a bright-yellow `⚑N` attention flag when blocked — with the relative age
 * RIGHT-FLUSHED into a clean scannable column via `ListItemRow.right`.
 * @param {TreeRow} r @param {number} now
 * @returns {import('../../core/tui/draw.js').ListItemRow}
 */
function rowToItem(r, now) {
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [{ text: ' ', style: undefined }]; // 1-cell gutter (rides the cursor bg)
  if (r.prefix) spans.push({ text: r.prefix, style: { dim: true } });
  spans.push({ text: r.glyph, style: glyphStyle(r.status) });
  spans.push({ text: ' ', style: undefined });
  spans.push({ text: r.name, style: nameStyle(r.status) });
  spans.push({ text: ` [${r.kind}/${r.mode}]`, style: { fg: '90', dim: true } }); // muted: grey + dim (mono-safe)
  if (r.blocked) spans.push({ text: ` ⚑${r.askCount}`, style: { fg: '93', bold: true } }); // attention

  const age = relAge(r.created, now);
  if (age) {
    return { spans, right: [{ text: age, style: { fg: '90', dim: true } }] };
  }
  return { spans };
}

// ── Refresh (data lane) ──────────────────────────────────────────────────────

/**
 * Pull the node graph + attention, rebuild the active-tree forest. Runs in the
 * host's single-flight lane (launch, refreshMs, and `{type:'refresh'}`). Maps any
 * fetch failure to guidance (a banner + the data-freshness chip) instead of
 * crashing, and KEEPS the last-known forest on a transient failure.
 * @param {CanvasState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<void>}
 */
async function refresh(state, host) {
  host.setStatus('Loading the canvas…');

  const rn = await fetchNodes();
  if (!rn.ok) {
    // Data source down. KEEP the last-known forest; raise the cause as the error
    // banner → the host derives the BLOCKED (red) chip. The not-ready takeover
    // only owns the screen when there is nothing to keep (see render()).
    state.sourceError = bannerFor(rn.error);
    host.setStatus(null);
    host.setError(state.sourceError);
    return;
  }
  state.sourceError = null;
  const nodes = rn.data;

  // Attention is best-effort: a failure here still renders the graph (just
  // without the blocked flags), so the monitor degrades gracefully.
  /** @type {Map<string,number>} */
  const blockedById = new Map();
  let attnTotal = 0;
  const ra = await fetchAttention();
  if (ra.ok) {
    for (const it of ra.data.items) {
      if (it.nodeId) blockedById.set(it.nodeId, it.count);
    }
    attnTotal = ra.data.total;
  }

  const built = buildForest(nodes, blockedById);
  state.rows = built.rows;
  state.shownRoots = built.shownRoots;
  state.totalNodes = nodes.length;
  state.activeCount = nodes.filter((n) => n.status === 'active').length;
  state.attnTotal = attnTotal;
  if (state.cursor >= state.rows.length) state.cursor = Math.max(0, state.rows.length - 1);
  state.lastFetch = Date.now();

  host.setSubtitle(subtitleFor(state));

  // Data-freshness → state chip. Pending human asks are the one thing that wants
  // a human: raise an ACTION banner → the host derives the ATTENTION (yellow)
  // chip. Otherwise clear → READY (green). (busy→working is automatic.)
  if (attnTotal > 0) {
    host.setBanner(`${plural(attnTotal, 'ask')} waiting on a human — see the ⚑ rows`, 'action');
  } else {
    host.setError(null);
  }

  host.setStatus(footerSummary(state));
}

// ── ViewModule ───────────────────────────────────────────────────────────────

/** @type {import('../../core/tui/contract.js').ViewModule<CanvasState>} */
const view = {
  manifest: {
    id: 'canvas',
    title: 'Canvas',
    description: 'Live agent graph — who is working, who is blocked',
    refreshMs: 3000,
    keymap: [
      { keys: 'j/k', label: 'move' },
      { keys: 'g', label: 'refresh' },
      { keys: 'q', label: 'quit' },
    ],
  },

  /**
   * Cheap + synchronous initial state — NO slow fetch (the host paints a loading
   * frame, then calls refresh()).
   * @returns {CanvasState}
   */
  init() {
    return {
      rows: [],
      cursor: 0,
      scroll: 0,
      shownRoots: 0,
      totalNodes: 0,
      activeCount: 0,
      attnTotal: 0,
      lastFetch: 0,
      sourceError: null,
    };
  },

  refresh,

  /**
   * Paint the forest, or one of the four standard states. Pure (reads state,
   * calls draw.*); the only state write is storing draw.list's adjusted scroll
   * back, per the Draw contract.
   * @param {CanvasState} state
   * @param {import('../../core/tui/draw.js').Draw} draw
   * @param {import('../../core/tui/draw.js').Rect} content
   */
  render(state, draw, content) {
    if (content.width <= 0 || content.height <= 0) return;

    if (state.rows.length === 0) {
      // Hard not-ready: the data source is down and there is nothing to keep —
      // a guided takeover owns the whole content rect (design §4/§5). The
      // specific cause rides the host error banner (full-width); this names the
      // state + the next action so the view never dead-ends.
      if (state.sourceError) {
        notReadyState(draw, content, {
          glyph: '⚠',
          glyphFg: '31', // red — pairs with the blocked chip
          headline: 'Canvas unavailable',
          explanation: 'crtr could not read the canvas graph.',
          nextStep: 'Press g to retry.',
        });
        return;
      }
      // First load in flight — a skeleton, not a blank screen.
      if (state.lastFetch === 0) {
        loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Loading the canvas…' });
        return;
      }
      // Loaded, nothing to render — the reward state, two flavors.
      if (state.totalNodes === 0) {
        emptyState(draw, content, {
          headline: 'No nodes on the canvas',
          secondary: ['Spawn one with `crtr node new`.', 'Press g to refresh.'],
        });
      } else {
        emptyState(draw, content, {
          headline: 'All caught up',
          secondary: [`${plural(state.totalNodes, 'node')} finished — none active.`, 'Press g to refresh.'],
        });
      }
      return;
    }

    // The forest. A 1-row section gap below the header (§2 rhythm) when there is
    // room; full-width list so the cursor highlight + age column reach the edges.
    const now = Date.now();
    const gap = content.height > 4 ? 1 : 0;
    const listRect = {
      row: content.row + gap,
      col: content.col,
      width: content.width,
      height: content.height - gap,
    };
    const items = state.rows.map((r) => rowToItem(r, now));
    const res = draw.list(listRect, items, state.cursor, state.scroll);
    state.scroll = res.scroll; // store adjusted scroll back (Draw.list contract)
  },

  /**
   * Read-only navigation: j/k move the cursor, g refreshes, q quits. No async
   * actions — this is a monitor, not a controller.
   * @param {import('../../core/tui/contract.js').ViewKey} k
   * @param {CanvasState} state
   * @returns {import('../../core/tui/contract.js').ViewAction}
   */
  onKey(k, state) {
    const key = k.key;
    const ch = k.input;
    if (ch === 'q') return { type: 'quit' };
    if (ch === 'g') return { type: 'refresh' };
    if (key.downArrow || ch === 'j') {
      if (state.rows.length) state.cursor = Math.min(state.rows.length - 1, state.cursor + 1);
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
   * its current banner via `ctx` so guidance (a source error / a pending-ask
   * action) surfaces without the view mirroring it into state.
   * @param {CanvasState} state
   * @param {import('../../core/tui/contract.js').DumpContext} [ctx]
   * @returns {string}
   */
  dump(state, ctx) {
    /** @type {string[]} */
    const lines = ['Canvas — live agent graph'];
    const banner = ctx && ctx.banner ? ctx.banner : null;
    if (banner) lines.push('', `[${banner.level}] ${banner.msg}`);
    else if (state.sourceError) lines.push('', `[error] ${state.sourceError}`);

    lines.push('', dumpSummary(state), '');

    if (state.rows.length === 0) {
      lines.push(
        state.sourceError
          ? '(canvas unavailable)'
          : state.lastFetch === 0
            ? '(loading…)'
            : state.totalNodes === 0
              ? '(no nodes on the canvas)'
              : '(no active trees)',
      );
      return lines.join('\n');
    }

    const now = Date.now();
    for (const r of state.rows) {
      const blk = r.blocked ? ` ⚑${r.askCount}` : '';
      const age = relAge(r.created, now);
      lines.push(
        `${r.prefix}${r.glyph} ${r.name} [${r.kind}/${r.mode}] ${lifeAbbr(r.lifecycle)} ${r.shortId} ${age}${blk}`,
      );
    }
    return lines.join('\n');
  },
};

export default view;
