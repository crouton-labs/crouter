// @ts-check
/**
 * Canvas Dashboard — the crtr `canvas` view (the monitor archetype).
 *
 * Self-contained ESM. Imports its data layer from `./client.mjs` (which shells
 * the `crtr` binary) and imports NOTHING from crtr — the host injects the `Draw`
 * + `ViewHost` API and dynamically `import()`s this module's DEFAULT EXPORT.
 *
 * A READ-ONLY monitor of the live agent graph: it rebuilds the forest from each
 * node's `parent` edge, keeps only trees that contain live (active/idle) or
 * human-blocked work, and renders them as a scrollable ASCII tree. It auto-polls
 * (refreshMs) — no node-focus / close / swap (views are sessionless). j/k move a
 * read cursor; g forces a refresh; q quits.
 *
 * @module canvas/view
 */

import { fetchNodes, fetchAttention } from './client.mjs';

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
 * @property {string|null} banner  Guidance text mirroring host.setError (so dump() can show it).
 */

// ── Status vocabulary (mirrors core/canvas/render.ts) ─────────────────────────

const LIVE_STATUS = new Set(['active', 'idle']);

/** @type {Record<string,string>} */
const STATUS_GLYPH = {
  active: '●',
  idle: '○',
  done: '✓',
  dead: '✗',
  canceled: '⊘',
};

/** @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined} */
function glyphStyle(status) {
  switch (status) {
    case 'active':
      return { fg: '32', bold: true }; // green
    case 'idle':
      return { fg: '33' }; // yellow
    case 'done':
      return { fg: '32', dim: true }; // green
    case 'dead':
      return { fg: '31' }; // red
    case 'canceled':
      return { dim: true };
    default:
      return undefined;
  }
}

/** @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined} */
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

// ── Error → guidance banner ──────────────────────────────────────────────────

/**
 * Map a typed {@link ClientError} to guidance text.
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

/**
 * Record guidance: set the host's sticky banner AND stash it in state so the
 * non-TTY dump() can surface it (host chrome is invisible when piped).
 * @param {CanvasState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @param {ClientError} error
 */
function setBanner(state, host, error) {
  const text = bannerFor(error);
  state.banner = text;
  host.setStatus(null);
  host.setError(text);
}

/**
 * @param {CanvasState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 */
function clearBanner(state, host) {
  state.banner = null;
  host.setError(null);
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

/** @param {CanvasState} state @returns {string} */
function summary(state) {
  return (
    `${state.shownRoots} tree${state.shownRoots === 1 ? '' : 's'} · ` +
    `${state.rows.length} shown · ` +
    `${state.activeCount} active · ` +
    `${state.attnTotal} ask${state.attnTotal === 1 ? '' : 's'} · ` +
    `${state.totalNodes} total`
  );
}

// ── Draw helpers ─────────────────────────────────────────────────────────────

/**
 * Draw a line centered (horizontally + vertically) within a rect.
 * @param {import('../../core/tui/draw.js').Draw} draw
 * @param {import('../../core/tui/draw.js').Rect} rect
 * @param {string} text @param {import('../../core/tui/draw.js').Style} [style]
 */
function centered(draw, rect, text, style) {
  if (rect.width <= 0 || rect.height <= 0) return;
  const t = String(text == null ? '' : text);
  const row = rect.row + Math.floor(rect.height / 2);
  const col = rect.col + Math.max(0, Math.floor((rect.width - t.length) / 2));
  draw.spans(row, col, [{ text: t, style }], rect.col + rect.width - col);
}

/** @param {TreeRow} r @returns {import('../../core/tui/draw.js').ListItemRow} */
function rowToItem(r) {
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [];
  if (r.prefix) spans.push({ text: r.prefix, style: { dim: true } });
  spans.push({ text: r.glyph + ' ', style: glyphStyle(r.status) });
  spans.push({ text: r.name, style: nameStyle(r.status) });
  spans.push({ text: ` [${r.kind}/${r.mode}]`, style: { dim: true } });
  spans.push({ text: ` ${lifeAbbr(r.lifecycle)}`, style: { dim: true } });
  spans.push({ text: ` ${r.shortId}`, style: { dim: true } });
  if (r.blocked) spans.push({ text: ` ⚑${r.askCount}`, style: { fg: '31', bold: true } }); // red
  return { spans };
}

// ── Refresh (data lane) ──────────────────────────────────────────────────────

/**
 * Pull the node graph + attention, rebuild the active-tree forest. Runs in the
 * host's single-flight lane (launch, refreshMs, and `{type:'refresh'}`). Maps any
 * fetch failure to a guided banner instead of crashing.
 * @param {CanvasState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<void>}
 */
async function refresh(state, host) {
  host.setStatus('Loading…');

  const rn = await fetchNodes();
  if (!rn.ok) {
    setBanner(state, host, rn.error);
    return;
  }
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
  clearBanner(state, host);
  host.setStatus(summary(state));
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
      banner: null,
    };
  },

  refresh,

  /**
   * Paint the scrollable forest. Pure (reads state, calls draw.*); the only state
   * write is storing draw.list's adjusted scroll back, per the Draw contract.
   * @param {CanvasState} state
   * @param {import('../../core/tui/draw.js').Draw} draw
   * @param {import('../../core/tui/draw.js').Rect} content
   */
  render(state, draw, content) {
    if (content.width <= 0 || content.height <= 0) return;
    if (state.rows.length === 0) {
      const msg = state.banner
        ? state.banner
        : state.lastFetch === 0
          ? 'Loading…'
          : 'No active trees';
      centered(draw, content, msg, { dim: true });
      return;
    }
    const items = state.rows.map(rowToItem);
    const res = draw.list(content, items, state.cursor, state.scroll);
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
   * Plain-text snapshot for the non-TTY / piped path. No ANSI.
   * @param {CanvasState} state
   * @returns {string}
   */
  dump(state) {
    /** @type {string[]} */
    const lines = ['Canvas — live agent graph'];
    if (state.banner) {
      lines.push('', state.banner);
      return lines.join('\n');
    }
    lines.push(summary(state), '');
    if (state.rows.length === 0) {
      lines.push(state.lastFetch === 0 ? '(not loaded)' : '(no active trees)');
      return lines.join('\n');
    }
    for (const r of state.rows) {
      const blk = r.blocked ? ` ⚑${r.askCount}` : '';
      lines.push(`${r.prefix}${r.glyph} ${r.name} [${r.kind}/${r.mode}] ${lifeAbbr(r.lifecycle)} ${r.shortId}${blk}`);
    }
    return lines.join('\n');
  },
};

export default view;
