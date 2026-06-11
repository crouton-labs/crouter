// @ts-check
/**
 * Workspace Sidebar — the left rail of `crtr workspace` (the agent-centric
 * editor view). A narrow, cwd-scoped navigator that sits beside a `crtr attach`
 * chat pane: two sections, ↵ swaps the selected node into the chat pane.
 *
 *   ⌗ this graph        the subtree of the node the chat pane is attached to
 *                       (its forest root), rendered as an ASCII tree.
 *   ↪ elsewhere         the OTHER top-level nodes (forest roots) started in this
 *                       working directory — root rows only, ⚑ inbox flags.
 *
 * Self-contained ESM; imports its data layer from `./client.mjs` and the shared
 * state helpers from `../_lib/states.mjs`; imports NOTHING from crtr — the host
 * injects `Draw` + `ViewHost` and dynamically import()s the default export.
 *
 * Unlike the read-only `canvas` monitor, this rail is a CONTROLLER: ↵ shells
 * `crtr node focus <id> --pane <chatPane>` (the chat pane id arrives as
 * `host.options.target`). That swap lands in the OTHER pane — the rail itself
 * stays sessionless and never opens a pi session (the §0 view invariant holds:
 * it focuses a node into a pane, it does not host one).
 *
 * VISUAL LANGUAGE (mirrors the `canvas` view): hierarchy via weight + hue +
 * position, never boxes. Status glyph hues match `canvas browse` (active=green,
 * idle=yellow, done=cyan, dead=red, canceled=grey; asks=bright-yellow). Color
 * never carries meaning alone — every hue pairs with a glyph/weight (NO_COLOR-
 * safe). The attached node carries a `▸` accent marker + bold name so "where am
 * I" is unmistakable. ⚑N attention flags right-flush into a clean column.
 *
 * @module workspace-sidebar/view
 */

import { fetchNodes, fetchAttentionMap, resolveChatPane, focusInto } from './client.mjs';
import { loadingState, emptyState, notReadyState } from '../_lib/states.mjs';

/** @typedef {import('./client.mjs').CanvasNode} CanvasNode */

// ── Status vocabulary (single source: core/canvas/browse/render.ts) ───────────

const LIVE_STATUS = new Set(['active', 'idle']);

/** @type {Record<string,string>} */
const STATUS_GLYPH = { active: '●', idle: '○', done: '✓', dead: '✗', canceled: '⊘' };

/** Load-bearing status hue — NUMERIC SGR, matching `canvas browse` exactly. */
/** @type {Record<string,string>} */
const STATUS_FG = { active: '32', idle: '33', done: '36', dead: '31', canceled: '90' };

/** @param {string} status @returns {import('../../core/tui/draw.js').Style|undefined} */
function glyphStyle(status) {
  const fg = STATUS_FG[status];
  return fg ? { fg } : undefined; // hue only — the glyph SHAPE is the mono carrier
}

/** Name weight = hierarchy: live work LEADS in bold; terminal nodes recede dim. */
/** @param {string} status @param {boolean} attached
 *  @returns {import('../../core/tui/draw.js').Style|undefined} */
function nameStyle(status, attached) {
  if (attached) return { fg: '36', bold: true }; // the attached node — cyan accent
  if (status === 'active') return { bold: true };
  if (status === 'done' || status === 'dead' || status === 'canceled') return { dim: true };
  return undefined;
}

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One rendered rail line. Either a non-selectable chrome line (header/gap/hint,
 * `nodeId: null`) or a selectable node row.
 * @typedef {Object} RailRow
 * @property {string|null} nodeId   null ⇒ chrome (header/gap), not selectable.
 * @property {string} name
 * @property {import('../../core/tui/draw.js').Span[]} spans   Left spans.
 * @property {import('../../core/tui/draw.js').Span[]} [right] Right-flush spans (⚑N).
 */

/**
 * @typedef {Object} SidebarState
 * @property {string} cwd               Workspace scope key (process.cwd()).
 * @property {string} targetOverride    Optional explicit chat pane id (host.options.target); '' if unset.
 * @property {string} chatPane          tmux pane id of the chat pane, resolved each refresh by discovery.
 * @property {string|null} attachedNode Node the chat pane currently views (@crtr_node), or null.
 * @property {string|null} currentRoot  Forest root of `this graph`.
 * @property {RailRow[]} rows           Flattened render list (chrome + node rows).
 * @property {number} cursor            Index into `rows` (always lands on a selectable row).
 * @property {number} scroll            draw.list scroll, stored back each frame.
 * @property {number} graphsHere        Distinct forest roots in this cwd.
 * @property {number} nodesHere         Total nodes in this cwd.
 * @property {number} asksHere          Total pending asks across the rendered set.
 * @property {number} lastFetch         Epoch ms of the last successful refresh.
 * @property {string|null} sourceError  Non-null ⇒ data source failed.
 */

// ── Small helpers ──────────────────────────────────────────────────────────────

/** @param {number} n @param {string} w @returns {string} */
function plural(n, w) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

/** @param {CanvasNode[]} nodes @returns {(a:CanvasNode,b:CanvasNode)=>number} */
function byBirth() {
  return (a, b) => (a.created < b.created ? -1 : a.created > b.created ? 1 : 0);
}

// ── Forest model (within the cwd-scoped node set) ──────────────────────────────

/**
 * Build id→node, parent→children, and the root list for the cwd-scoped set. A
 * node is a ROOT when it has no parent inside the set (its parent may live in
 * another cwd, or be null).
 * @param {CanvasNode[]} mine
 */
function buildForest(mine) {
  /** @type {Map<string, CanvasNode>} */
  const byId = new Map();
  for (const n of mine) byId.set(n.nodeId, n);
  /** @type {Map<string, CanvasNode[]>} */
  const children = new Map();
  /** @type {CanvasNode[]} */
  const roots = [];
  for (const n of mine) {
    const hasParent = n.parent && byId.has(n.parent);
    if (hasParent) {
      const arr = children.get(/** @type {string} */ (n.parent));
      if (arr) arr.push(n);
      else children.set(/** @type {string} */ (n.parent), [n]);
    } else {
      roots.push(n);
    }
  }
  const cmp = byBirth();
  for (const arr of children.values()) arr.sort(cmp);
  roots.sort(cmp);
  return { byId, children, roots };
}

/**
 * Climb from `id` to its forest root within the set (parent edges that stay in
 * `byId`). Cycle-guarded.
 * @param {string} id @param {Map<string, CanvasNode>} byId @returns {string}
 */
function climbRoot(id, byId) {
  const seen = new Set();
  let cur = id;
  while (true) {
    if (seen.has(cur)) return cur;
    seen.add(cur);
    const n = byId.get(cur);
    if (!n || !n.parent || !byId.has(n.parent)) return cur;
    cur = n.parent;
  }
}

/** @param {string} id @param {Map<string,CanvasNode[]>} children @returns {boolean} */
function subtreeLive(id, children, byId, guard = new Set()) {
  if (guard.has(id)) return false;
  guard.add(id);
  const n = byId.get(id);
  let res = !!n && LIVE_STATUS.has(n.status);
  if (!res) {
    for (const c of children.get(id) || []) {
      if (subtreeLive(c.nodeId, children, byId, guard)) {
        res = true;
        break;
      }
    }
  }
  guard.delete(id);
  return res;
}

// ── Row builders ───────────────────────────────────────────────────────────────

/**
 * A node row laid out for the narrow rail: a 1-cell gutter (`▸` accent on the
 * attached node, else blank), an optional dim tree prefix, the status glyph
 * (hue), the name (weight = status / accent when attached), and a right-flushed
 * bright-yellow ⚑N when the node has pending asks.
 * @param {CanvasNode} n @param {string} prefix @param {boolean} attached @param {number} asks
 * @returns {RailRow}
 */
function nodeRow(n, prefix, attached, asks) {
  /** @type {import('../../core/tui/draw.js').Span[]} */
  const spans = [
    attached ? { text: '▸', style: { fg: '36', bold: true } } : { text: ' ' },
    { text: ' ' },
  ];
  if (prefix) spans.push({ text: prefix, style: { dim: true } });
  spans.push({ text: STATUS_GLYPH[n.status] || '?', style: glyphStyle(n.status) });
  spans.push({ text: ' ' });
  spans.push({ text: n.name, style: nameStyle(n.status, attached) });
  /** @type {RailRow} */
  const row = { nodeId: n.nodeId, name: n.name, spans };
  if (asks > 0) row.right = [{ text: `⚑${asks}`, style: { fg: '93', bold: true } }];
  return row;
}

/** @param {string} text @returns {RailRow} */
function headerRow(text) {
  return { nodeId: null, name: '', spans: [{ text, style: { fg: '36', bold: true } }] };
}
/** @param {string} [text] @returns {RailRow} */
function chromeRow(text) {
  return { nodeId: null, name: '', spans: [{ text: text || '', style: { dim: true } }] };
}

// ── Refresh (data lane) ────────────────────────────────────────────────────────

/**
 * Pull the node graph, scope to this cwd, learn the attached node from the chat
 * pane's `@crtr_node` tag, and rebuild the two-section rail. Keeps the last-known
 * rail on a transient data-source failure.
 * @param {SidebarState} state
 * @param {import('../../core/tui/contract.js').ViewHost} host
 * @returns {Promise<void>}
 */
async function refresh(state, host) {
  host.setStatus('Loading…');

  // Resolve the chat pane in our own window (discovery survives the swap-pane
  // that `crtr node focus` does) and learn which node it is attached to.
  const chat = await resolveChatPane(state.targetOverride);
  state.chatPane = chat.pane;
  state.attachedNode = chat.node || null;

  const rn = await fetchNodes();
  if (!rn.ok) {
    state.sourceError = rn.error.message || 'crtr unavailable';
    host.setStatus(null);
    host.setError(state.sourceError);
    return;
  }
  state.sourceError = null;
  host.setError(null);

  const mine = rn.data.filter((n) => n.cwd === state.cwd);
  const { byId, children, roots } = buildForest(mine);

  // `this graph` root: the attached node's root if known & present, else the
  // newest LIVE root here, else the newest root, else none.
  let currentRoot = null;
  if (state.attachedNode && byId.has(state.attachedNode)) {
    currentRoot = climbRoot(state.attachedNode, byId);
  } else {
    const live = roots.filter((r) => subtreeLive(r.nodeId, children, byId));
    const pool = live.length ? live : roots;
    if (pool.length) currentRoot = pool[pool.length - 1].nodeId; // newest
  }
  state.currentRoot = currentRoot;

  // Attention in one pass: the current sub-DAG + EVERY root here (so a blocked
  // but-not-live root still surfaces). Cheap — asks scan each distinct cwd once.
  const asks = await fetchAttentionMap(currentRoot, roots.map((r) => r.nodeId));
  let asksHere = 0;
  for (const v of Object.values(asks)) asksHere += v;

  // `elsewhere` = other roots that are still LIVE (active|idle subtree) OR have a
  // pending ask — the same active-filter the `canvas` monitor uses, so a cwd with
  // a long graveyard of finished roots shows only what still matters. Live first,
  // then newest.
  const liveRoots = roots.filter((r) => subtreeLive(r.nodeId, children, byId));
  const others = roots.filter(
    (r) => r.nodeId !== currentRoot && (subtreeLive(r.nodeId, children, byId) || (asks[r.nodeId] || 0) > 0),
  );
  others.sort((a, b) => {
    const la = subtreeLive(a.nodeId, children, byId) ? 1 : 0;
    const lb = subtreeLive(b.nodeId, children, byId) ? 1 : 0;
    if (la !== lb) return lb - la;
    return a.created < b.created ? 1 : -1; // newest first
  });

  // ── Build the flat render list ───────────────────────────────────────────
  /** @type {RailRow[]} */
  const rows = [];
  rows.push(headerRow('⌗ this graph'));
  if (currentRoot && byId.has(currentRoot)) {
    /** @type {Set<string>} */
    const visited = new Set();
    /** @param {CanvasNode} node @param {string} indent @param {boolean} isLast @param {boolean} isRoot */
    const walk = (node, indent, isLast, isRoot) => {
      if (visited.has(node.nodeId)) return;
      visited.add(node.nodeId);
      const prefix = isRoot ? '' : indent + (isLast ? '└─ ' : '├─ ');
      rows.push(nodeRow(node, prefix, node.nodeId === state.attachedNode, asks[node.nodeId] || 0));
      const kids = children.get(node.nodeId) || [];
      const childIndent = isRoot ? '' : indent + (isLast ? '   ' : '│  ');
      for (let i = 0; i < kids.length; i++) walk(kids[i], childIndent, i === kids.length - 1, false);
    };
    walk(/** @type {CanvasNode} */ (byId.get(currentRoot)), '', true, true);
  } else {
    rows.push(chromeRow('  no agent here yet'));
  }

  rows.push(chromeRow('')); // section gap
  rows.push(headerRow(`↪ elsewhere${others.length ? ` · ${others.length}` : ''}`));
  if (others.length) {
    for (const r of others) rows.push(nodeRow(r, '', false, asks[r.nodeId] || 0));
  } else {
    rows.push(chromeRow('  —'));
  }

  state.rows = rows;
  state.graphsHere = liveRoots.length;
  state.nodesHere = mine.length;
  state.asksHere = asksHere;
  state.lastFetch = Date.now();

  // Keep the cursor on the same node across refreshes; else home it on the
  // attached node; else the first selectable row.
  reanchorCursor(state);

  host.setSubtitle(state.graphsHere > 0 ? `${plural(state.graphsHere, 'live graph')}` : null);
  if (asksHere > 0) host.setBanner(`${plural(asksHere, 'ask')} waiting on a human — see the ⚑ rows`, 'action');
  else host.setError(null);
  host.setStatus(null);
}

// ── Cursor model (skips chrome rows) ───────────────────────────────────────────

/** @param {RailRow[]} rows @returns {number[]} */
function selectableIdx(rows) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].nodeId) out.push(i);
  return out;
}

/**
 * Re-home the cursor after a rebuild: same nodeId if still present, else the
 * attached node, else the first selectable row.
 * @param {SidebarState} state
 */
function reanchorCursor(state) {
  const sel = selectableIdx(state.rows);
  if (sel.length === 0) {
    state.cursor = 0;
    return;
  }
  const prevId = state.rows[state.cursor] ? state.rows[state.cursor].nodeId : null;
  const want = prevId || state.attachedNode;
  const found = want ? state.rows.findIndex((r) => r.nodeId === want) : -1;
  state.cursor = found >= 0 ? found : sel[0];
}

/** @param {SidebarState} state @param {1|-1} dir */
function moveCursor(state, dir) {
  const sel = selectableIdx(state.rows);
  if (sel.length === 0) return;
  const pos = sel.indexOf(state.cursor);
  if (pos < 0) {
    state.cursor = sel[0];
    return;
  }
  const next = Math.max(0, Math.min(sel.length - 1, pos + dir));
  state.cursor = sel[next];
}

// ── ViewModule ─────────────────────────────────────────────────────────────────

/** @type {import('../../core/tui/contract.js').ViewModule<SidebarState>} */
const view = {
  manifest: {
    id: 'workspace-sidebar',
    title: 'Workspace',
    description: 'Left rail for `crtr workspace` — this graph + other agents in this cwd',
    refreshMs: 2500,
    keymap: [
      { keys: 'j/k', label: 'move' },
      { keys: '↵', label: 'open' },
      { keys: 'g', label: 'refresh' },
      { keys: 'q', label: 'quit' },
    ],
  },

  /** @param {import('../../core/tui/contract.js').ViewHost} host @returns {SidebarState} */
  init(host) {
    return {
      cwd: process.cwd(),
      targetOverride: String(host.options.target || ''),
      chatPane: '',
      attachedNode: null,
      currentRoot: null,
      rows: [],
      cursor: 0,
      scroll: 0,
      graphsHere: 0,
      nodesHere: 0,
      asksHere: 0,
      lastFetch: 0,
      sourceError: null,
    };
  },

  refresh,

  /**
   * @param {SidebarState} state
   * @param {import('../../core/tui/draw.js').Draw} draw
   * @param {import('../../core/tui/draw.js').Rect} content
   */
  render(state, draw, content) {
    if (content.width <= 0 || content.height <= 0) return;

    if (state.rows.length === 0) {
      if (state.sourceError) {
        notReadyState(draw, content, {
          glyph: '⚠',
          glyphFg: '31',
          headline: 'Canvas unavailable',
          explanation: 'crtr could not read the graph.',
          nextStep: 'Press g to retry.',
        });
        return;
      }
      if (state.lastFetch === 0) {
        loadingState(draw, content, { rows: Math.min(5, content.height), label: 'Loading…' });
        return;
      }
      emptyState(draw, content, {
        headline: 'No agents here',
        secondary: ['Nothing started in this cwd.', 'Press g to refresh.'],
      });
      return;
    }

    const items = state.rows.map((r) => (r.right ? { spans: r.spans, right: r.right } : { spans: r.spans }));
    const res = draw.list(content, items, state.cursor, state.scroll);
    state.scroll = res.scroll;
  },

  /**
   * @param {import('../../core/tui/contract.js').ViewKey} k
   * @param {SidebarState} state
   * @param {import('../../core/tui/contract.js').ViewHost} host
   * @returns {import('../../core/tui/contract.js').ViewAction}
   */
  onKey(k, state, host) {
    const ch = k.input;
    const key = k.key;
    if (ch === 'q') return { type: 'quit' };
    if (ch === 'g' || ch === 'r') return { type: 'refresh' };
    if (key.downArrow || ch === 'j') {
      moveCursor(state, 1);
      return { type: 'render' };
    }
    if (key.upArrow || ch === 'k') {
      moveCursor(state, -1);
      return { type: 'render' };
    }
    if (key.return || ch === '\r' || ch === '\n') {
      const row = state.rows[state.cursor];
      if (row && row.nodeId) {
        if (!state.chatPane) {
          host.setBanner('No chat pane wired — run this rail via `crtr workspace`.', 'error');
          return { type: 'render' };
        }
        focusInto(row.nodeId, state.chatPane);
        host.setStatus(`→ ${row.name}`);
      }
      return { type: 'none' };
    }
    return { type: 'none' };
  },

  /**
   * @param {SidebarState} state
   * @param {import('../../core/tui/contract.js').DumpContext} [ctx]
   * @returns {string}
   */
  dump(state, ctx) {
    /** @type {string[]} */
    const lines = ['Workspace sidebar'];
    const banner = ctx && ctx.banner ? ctx.banner : null;
    if (banner) lines.push('', `[${banner.level}] ${banner.msg}`);
    else if (state.sourceError) lines.push('', `[error] ${state.sourceError}`);
    lines.push('', `${plural(state.graphsHere, 'graph')} · ${state.nodesHere} nodes · ${plural(state.asksHere, 'ask')}`, '');
    if (state.rows.length === 0) {
      lines.push(state.sourceError ? '(canvas unavailable)' : state.lastFetch === 0 ? '(loading…)' : '(no agents in this cwd)');
      return lines.join('\n');
    }
    for (const r of state.rows) {
      const plain = r.spans.map((s) => s.text).join('');
      const flag = r.right ? ' ' + r.right.map((s) => s.text).join('') : '';
      lines.push(plain + flag);
    }
    return lines.join('\n');
  },
};

export default view;
