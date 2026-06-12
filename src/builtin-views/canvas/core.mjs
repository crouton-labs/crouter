// @ts-check
/**
 * Canvas Dashboard — the PORTABLE CORE of the crtr `canvas` view (manifest ·
 * init · sources · intents). The READ-ONLY monitor of the live agent graph: one
 * core renders in BOTH targets — the tmux TUI (`crtr view run canvas`, via
 * `tui.mjs`) and the React+Tailwind web page (`crtr view serve canvas`, via
 * `web.jsx`).
 *
 * Runs in BOTH Node and the browser, so it imports NOTHING — no `node:*`, no
 * crtr. The data layer is expressed as transport-agnostic `Source` descriptors:
 * the core describes WHAT to run (`request()` → a SourceRequest for
 * `crtr … --json`), the host's Transport runs it (local `execFile` for the TUI,
 * the HTTP bridge for web), and the pure `parse()` turns bytes → typed data | a
 * typed `SourceError`. The forest building + relative-age / chrome-copy logic is
 * pure string/data work that runs anywhere.
 *
 * It rebuilds the forest from each node's `parent` edge, keeps only trees that
 * contain live (active/idle) or human-blocked work, and renders them as a
 * scrollable ASCII tree (TUI) / DOM tree (web). It auto-polls (refreshMs) — no
 * node-focus / close / swap (views are sessionless). j/k move a read cursor; g
 * forces a refresh; q quits.
 *
 * NOTHING throws. Sources return a `Result<T>` (a typed `SourceError` on
 * failure); the `refresh` intent KEEPS the last-known forest on a transient
 * failure and raises the cause as a banner, dropping to a guided takeover only
 * when there is nothing to keep (graceful partial failure).
 *
 * @module canvas/core
 */

/**
 * @typedef {import('../../core/view/contract.js').SourceError} SourceError
 * @typedef {import('../../core/view/contract.js').IntentCtx<CanvasState>} Ctx
 */

/**
 * One canvas node, flattened from `node inspect list --json`.
 * @typedef {Object} CanvasNode
 * @property {string} nodeId      Full node id (`<time>-<hash>`).
 * @property {string} name        Display name.
 * @property {string} kind        Node kind (general/developer/explore/human/…).
 * @property {string} mode        base | orchestrator.
 * @property {string} lifecycle   resident | terminal.
 * @property {string} status      active | idle | done | dead | canceled.
 * @property {string|null} parent Spawn/subscription parent id (null ⇒ a forest root).
 * @property {string} created     ISO 8601 birth timestamp (drives child ordering).
 */

/**
 * One cwd with pending human asks, from `canvas attention list --json`.
 * @typedef {Object} AttentionItem
 * @property {string} nodeId
 * @property {string} name
 * @property {string} cwd
 * @property {number} count    Pending ask count.
 */

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
 * The view's immutable state (the core owns it; intents replace it via ctx.set).
 * @typedef {Object} CanvasState
 * @property {TreeRow[]} rows      Flattened active-tree forest (render source).
 * @property {number} cursor       Read cursor into rows (j/k).
 * @property {number} scroll       draw.list scroll, stored back each frame.
 * @property {number} shownRoots   How many trees survived the active filter.
 * @property {number} totalNodes   Total nodes on the canvas (all statuses).
 * @property {number} activeCount  Nodes with status 'active' (canvas-wide).
 * @property {number} attnTotal    Total pending human asks (canvas-wide).
 * @property {number} lastFetch    Epoch ms of the last successful refresh.
 * @property {SourceError|null} sourceError  Non-null ⇒ the data source failed;
 *   presenters render its `display` VERBATIM (the not-ready takeover when there
 *   is no data, and the dump fallback). Cleared on a successful refresh.
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

// ── Field mappers ───────────────────────────────────────────────────

/** @param {unknown} v @returns {string} */
function str(v) {
  return v == null ? '' : String(v);
}

/** @param {any} n @returns {CanvasNode} */
function toNode(n) {
  const o = n || {};
  return {
    nodeId: str(o.node_id),
    name: str(o.name) || '(unnamed)',
    kind: str(o.kind) || '?',
    mode: str(o.mode) || '?',
    lifecycle: str(o.lifecycle) || '?',
    status: str(o.status) || '?',
    parent: o.parent ? str(o.parent) : null,
    created: str(o.created),
  };
}

/** @param {any} i @returns {AttentionItem} */
function toAttention(i) {
  const o = i || {};
  return {
    nodeId: str(o.node_id),
    name: str(o.name),
    cwd: str(o.cwd),
    count: typeof o.count === 'number' ? o.count : 0,
  };
}

// ── Status vocabulary (mirrors core/canvas/browse/render.ts — single source) ──

const LIVE_STATUS = new Set(['active', 'idle']);

/** @type {Record<string,string>} */
export const STATUS_GLYPH = {
  active: '●',
  idle: '○',
  done: '✓',
  dead: '✗',
  canceled: '⊘',
};

/** @param {string} lifecycle @returns {string} */
export function lifeAbbr(lifecycle) {
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
 * Shared by the TUI render + the text dump (both import it from here).
 * @param {string} createdIso @param {number} now @returns {string}
 */
export function relAge(createdIso, now) {
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
export function plural(n, w) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
}

// ── Typed SourceError displays (the `display`/`kind` split; presenters render
//    `display` verbatim and never branch on `kind`) ────────────────────────────

/** @type {SourceError} */
const CRTR_MISSING = {
  kind: 'crtr-missing',
  display: {
    headline: 'Canvas unavailable',
    explanation: 'crtr could not be found to read the canvas graph.',
    nextStep: 'Install crtr (or set CRTR_BIN on PATH), then press g.',
    level: 'error',
    blocking: true,
  },
};

/** @param {string} stderr @returns {SourceError} */
function crtrFailed(stderr) {
  const s = String(stderr || '');
  if (/help-gate:\s*blocked/i.test(s)) {
    return {
      kind: 'help-gate',
      display: {
        headline: 'Canvas unavailable',
        explanation: 'crtr help-gate blocked the call (run the command with -h once).',
        nextStep: 'Press g to retry.',
        level: 'error',
        blocking: true,
      },
    };
  }
  return {
    kind: 'crtr-failed',
    display: {
      headline: 'Canvas unavailable',
      explanation: 'crtr could not read the canvas graph: ' + (extractMessage(s) || 'unknown error'),
      nextStep: 'Press g to retry.',
      level: 'error',
      blocking: true,
    },
  };
}

/** @param {string} cmd @returns {SourceError} */
function parseError(cmd) {
  return {
    kind: 'parse',
    display: {
      headline: 'Canvas unavailable',
      explanation: `Could not parse \`crtr ${cmd}\` output as JSON.`,
      nextStep: 'Press g to retry.',
      level: 'error',
      blocking: true,
    },
  };
}

/**
 * Pull a human message out of crtr stderr: prefer the last `ERROR:` line, else
 * the last non-empty line, else ''.
 * @param {string} stderr @returns {string}
 */
function extractMessage(stderr) {
  const lines = String(stderr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ERROR:/i.test(lines[i])) return lines[i].replace(/^ERROR:\s*/i, '').trim();
  }
  if (lines.length) return lines[lines.length - 1];
  return '';
}

// ── Sources (reads): a request descriptor + a pure parse. The host's transport
//    runs the request (local execFile for TUI, the HTTP bridge for web). The
//    spawned `crtr` is a grandchild of the view host — not a pi tool call — so
//    the help-gate never intercepts it. ────────────────────────────────────────

/**
 * Every node on the canvas (all statuses). The view rebuilds the forest from the
 * `parent` edges and filters to active trees itself. The PRIMARY instrument —
 * its parse owns the hard failure (crtr missing / a failing crtr command).
 * @type {import('../../core/view/contract.js').Source<CanvasNode[]>}
 */
export const nodesSource = {
  id: 'nodes',
  request: () => ({ kind: 'exec', bin: 'crtr', args: ['node', 'inspect', 'list', '--json'] }),
  parse: (raw) => {
    if (!raw.ok) return fail(CRTR_MISSING);
    if (raw.exitCode !== 0) return fail(crtrFailed(raw.stderr || raw.stdout));
    const out = String(raw.stdout || '').trim();
    let data;
    try {
      data = out === '' ? {} : JSON.parse(out);
    } catch {
      return fail(parseError('node inspect list'));
    }
    const arr = data && Array.isArray(data.nodes) ? data.nodes : [];
    return ok(arr.map(toNode));
  },
};

/**
 * Pending human asks across the canvas (the "blocked on a human" signal).
 * BEST-EFFORT: any failure degrades to no flags (the graph still renders), so a
 * parse never blocks the monitor — it returns an empty set instead of an error.
 * @type {import('../../core/view/contract.js').Source<{items:AttentionItem[], total:number}>}
 */
export const attentionSource = {
  id: 'attention',
  request: () => ({ kind: 'exec', bin: 'crtr', args: ['canvas', 'attention', 'list', '--json'] }),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return ok({ items: [], total: 0 });
    const out = String(raw.stdout || '').trim();
    let data;
    try {
      data = out === '' ? {} : JSON.parse(out);
    } catch {
      return ok({ items: [], total: 0 });
    }
    const items = data && Array.isArray(data.items) ? data.items : [];
    const total = data && typeof data.total === 'number' ? data.total : 0;
    return ok({ items: items.map(toAttention), total });
  },
};

// ── Forest builder ─────────────────────────────────────────────

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
export function buildForest(nodes, blockedById) {
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

// ── Chrome copy (subtitle / footer / dump; pure) ──────────────────────────────

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
export function dumpSummary(state) {
  return (
    `${plural(state.shownRoots, 'tree')} · ${state.rows.length} shown · ` +
    `${state.activeCount} active · ${plural(state.attnTotal, 'ask')} · ` +
    `${state.totalNodes} total`
  );
}

// ── The portable core ──────────────────────────────────────────────────────────

/** @type {import('../../core/view/contract.js').ViewCore<CanvasState>} */
const core = {
  manifest: {
    id: 'canvas',
    title: 'Canvas',
    description: 'Live agent graph — who is working, who is blocked',
    refreshMs: 3000,
  },

  /**
   * Cheap + synchronous initial state — NO slow fetch (the host paints a loading
   * frame, then dispatches the first 'refresh').
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

  sources: { nodesSource, attentionSource },

  intents: {
    /**
     * Pull the node graph + attention, rebuild the active-tree forest. Runs in
     * the host's single-flight lane (launch, refreshMs, and the `refresh`
     * keybind). A nodes failure KEEPS the last-known forest and raises the cause
     * as a banner (the not-ready takeover only owns the screen when there is
     * nothing to keep — see the presenters). Attention is best-effort: a failure
     * still renders the graph, just without the blocked flags.
     * @param {Ctx} ctx
     */
    async refresh(ctx) {
      ctx.signal.setStatus('Loading the canvas…');

      const rn = await ctx.resolve(nodesSource);
      if (!rn.ok) {
        // Data source down. KEEP the last-known forest; store the typed error
        // (drives the BLOCKED chip + the not-ready takeover when rows are empty)
        // and raise the cause as the error banner.
        ctx.set((s) => ({ ...s, sourceError: rn.error }));
        ctx.signal.setStatus(null);
        ctx.signal.setBanner(rn.error.display.explanation, rn.error.display.level);
        return;
      }
      const nodes = rn.data;

      /** @type {Map<string,number>} */
      const blockedById = new Map();
      let attnTotal = 0;
      const ra = await ctx.resolve(attentionSource);
      if (ra.ok) {
        for (const it of ra.data.items) {
          if (it.nodeId) blockedById.set(it.nodeId, it.count);
        }
        attnTotal = ra.data.total;
      }

      const built = buildForest(nodes, blockedById);
      ctx.set((s) => {
        /** @type {CanvasState} */
        const next = {
          ...s,
          sourceError: null,
          rows: built.rows,
          shownRoots: built.shownRoots,
          totalNodes: nodes.length,
          activeCount: nodes.filter((n) => n.status === 'active').length,
          attnTotal,
          lastFetch: Date.now(),
        };
        if (next.cursor >= next.rows.length) next.cursor = Math.max(0, next.rows.length - 1);
        return next;
      });

      ctx.signal.setSubtitle(subtitleFor(ctx.state));

      // Data-freshness → state chip. Pending human asks are the one thing that
      // wants a human: raise an ACTION banner → the host derives the ATTENTION
      // (yellow) chip. Otherwise clear → READY (green). (busy→working is
      // automatic.)
      if (attnTotal > 0) {
        ctx.signal.setBanner(`${plural(attnTotal, 'ask')} waiting on a human — see the ⚑ rows`, 'action');
      } else {
        ctx.signal.clearBanner();
      }
      ctx.signal.setStatus(footerSummary(ctx.state));
    },

    /** @param {Ctx} ctx */
    cursorDown: (ctx) => ctx.set((s) => ({ ...s, cursor: s.rows.length ? Math.min(s.rows.length - 1, s.cursor + 1) : 0 })),
    /** @param {Ctx} ctx */
    cursorUp: (ctx) => ctx.set((s) => ({ ...s, cursor: Math.max(0, s.cursor - 1) })),
    /**
     * Activate (open) a node. STANDALONE this just sets the read cursor to the
     * node's row — the view stays a read-only monitor. In the WEB SHELL the
     * `{nodeId}` payload is what the host's intent TAP observes to open that
     * node's conversation pane (§5): the core never imports the shell and never
     * knows whether anyone is listening; it always emits the intent, and the
     * payload carries the referent. Unknown/missing id ⇒ no-op.
     * @param {Ctx} ctx @param {{nodeId?: string}} [payload]
     */
    activate: (ctx, payload) => {
      const id = payload && payload.nodeId;
      if (!id) return;
      ctx.set((s) => {
        const i = s.rows.findIndex((r) => r.nodeId === id);
        return i >= 0 ? { ...s, cursor: i } : s;
      });
    },
    /** @param {Ctx} ctx */
    quit: (ctx) => ctx.signal.quit(),
  },
};

export default core;
