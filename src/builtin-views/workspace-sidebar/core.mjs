// @ts-check
/**
 * Workspace Sidebar — the PORTABLE CORE of the `workspace-sidebar` view
 * (manifest · init · sources · commands · intents). The left rail of
 * `crtr workspace`: a narrow, cwd-scoped navigator with two sections —
 *
 *   ⌗ this graph        the subtree of the node the chat pane is attached to
 *                       (its forest root), rendered as an ASCII tree.
 *   ↪ elsewhere         the OTHER top-level nodes (forest roots) started in this
 *                       cwd — root rows only, ⚑ inbox flags.
 *
 * Runs in BOTH Node (the tmux TUI, via `tui.mjs`) and the browser (the
 * React+Tailwind page, via `web.jsx`), so it imports NOTHING — no `node:*`, no
 * crtr. The data layer that used to shell `crtr`/`tmux` directly (`client.mjs`'s
 * `execFile`) is now expressed as transport-agnostic `Source`/`Command`
 * descriptors: the core describes WHAT to run (`request()` → a SourceRequest),
 * the host's Transport runs it (local `execFile` for the TUI, the HTTP bridge
 * for web), and the pure `parse()` turns bytes → typed data. The forest model,
 * cwd scoping, attention rollup, and cursor logic are pure string work that runs
 * anywhere.
 *
 * The rail is a CONTROLLER in the TUI: the `open` intent shells
 * `crtr node focus <id> --pane <chatPane>` (a `Command`), swapping the selected
 * node into the OTHER pane. The chat pane + the attached node are resolved each
 * refresh from the window's tmux panes (the `@crtr_node` tag attach self-sets,
 * which survives the swap). On the web target there is no chat pane — the same
 * rail renders as a plain styled list; `open` no-ops with a banner.
 *
 * NOTHING throws. Sources return a `Result<T>` (typed `SourceError` on a hard
 * failure); `refresh` keeps the last-known rail on a transient failure.
 *
 * @module workspace-sidebar/core
 */

/**
 * @typedef {import('../../core/view/contract.js').SourceError} SourceError
 * @typedef {import('../../core/view/contract.js').IntentCtx<SidebarState>} Ctx
 */

// ── Status vocabulary (single source: core/canvas/browse/render.ts) ───────────

const LIVE_STATUS = new Set(['active', 'idle']);

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One canvas node, flattened from `node inspect list --json`.
 * @typedef {Object} CanvasNode
 * @property {string} nodeId
 * @property {string} name
 * @property {string} kind
 * @property {string} mode
 * @property {string} lifecycle
 * @property {string} status      active | idle | done | dead | canceled.
 * @property {string} cwd         Originating cwd — the workspace scope key.
 * @property {string|null} parent Spawn/subscription parent id (null ⇒ a root).
 * @property {string} created     ISO 8601 birth timestamp (drives ordering).
 */

/**
 * One LOGICAL rail row (each presenter paints it in its own idiom). A node row
 * is selectable; header/chrome rows are inert chrome.
 * @typedef {{kind:'header', text:string}
 *   | {kind:'chrome', text:string}
 *   | {kind:'node', nodeId:string, name:string, status:string, prefix:string, attached:boolean, asks:number}} RailRow
 */

/**
 * The view's immutable state (the core owns it; intents replace it via ctx.set).
 * @typedef {Object} SidebarState
 * @property {string} cwd               Workspace scope key (process.cwd()).
 * @property {string} targetOverride    Optional explicit chat pane id (options.target); '' if unset.
 * @property {string} chatPane          tmux pane id of the chat pane, resolved each refresh.
 * @property {string|null} attachedNode Node the chat pane currently views (@crtr_node), or null.
 * @property {string|null} currentRoot  Forest root of `this graph`.
 * @property {RailRow[]} rows           Flattened render list (chrome + node rows).
 * @property {number} cursor            Index into `rows` (always lands on a node row).
 * @property {number} scroll            draw.list scroll, stored back each frame.
 * @property {number} graphsHere        Live forest roots in this cwd.
 * @property {number} nodesHere         Total nodes in this cwd.
 * @property {number} asksHere          Total pending asks across the rendered set.
 * @property {number} lastFetch         Epoch ms of the last successful refresh.
 * @property {SourceError|null} srcError Non-null ⇒ the node source failed (typed).
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

/** @param {string} s @returns {string} */
function firstLine(s) {
  const lines = String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? lines[0] : '';
}

/** @param {unknown} v @returns {string} */
function str(v) {
  return v == null ? '' : String(v);
}

/** @param {number} n @param {string} w @returns {string} */
export function plural(n, w) {
  return `${n} ${w}${n === 1 ? '' : 's'}`;
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
    cwd: str(o.cwd),
    parent: o.parent ? str(o.parent) : null,
    created: str(o.created),
  };
}

// ── Typed SourceError displays (presenters render `display` verbatim) ─────────

/** @type {SourceError} */
const CRTR_MISSING = {
  kind: 'crtr-missing',
  display: {
    headline: 'crtr unavailable',
    explanation: 'The crtr binary was not found on PATH.',
    nextStep: 'Install crtr (or set it on PATH), then press g.',
    level: 'error',
    blocking: true,
  },
};
/** @param {string} msg @returns {SourceError} */
function crtrFailed(msg) {
  return {
    kind: 'crtr-failed',
    display: {
      headline: 'Canvas unavailable',
      explanation: msg || 'crtr could not read the graph.',
      nextStep: 'Press g to retry.',
      level: 'error',
      blocking: false,
    },
  };
}

// ── Sources (reads): a request descriptor + a pure parse ──────────────────────

/**
 * Every node on the canvas (all statuses). The view filters to the workspace cwd
 * and rebuilds the forest from `parent` edges itself. The PRIMARY instrument —
 * its parse owns the two hard failures (crtr missing / a failing crtr command).
 * @type {import('../../core/view/contract.js').Source<CanvasNode[]>}
 */
export const nodesSource = {
  id: 'nodes',
  request: () => ({ kind: 'exec', bin: 'crtr', args: ['node', 'inspect', 'list', '--json'] }),
  parse: (raw) => {
    if (!raw.ok) return fail(CRTR_MISSING);
    if (raw.exitCode !== 0) return fail(crtrFailed(firstLine(raw.stderr || raw.stdout)));
    const out = String(raw.stdout || '').trim();
    let data;
    try {
      data = out === '' ? {} : JSON.parse(out);
    } catch {
      return fail(crtrFailed('could not parse `crtr node inspect list` output as JSON'));
    }
    const arr = data && Array.isArray(data.nodes) ? data.nodes : [];
    return ok(arr.map(toNode));
  },
};

/**
 * Per-node pending-ask counts for a visible set, in ONE pass: the current
 * graph's whole sub-DAG (`--view <root>`) unioned with explicit `nodeIds` (the
 * other roots in this cwd). BEST-EFFORT — any failure yields {} so the rail
 * still renders without ⚑ flags.
 * @type {import('../../core/view/contract.js').Source<Record<string,number>, {viewRoot:string|null, nodeIds:string[]}>}
 */
export const attentionSource = {
  id: 'attention',
  request: ({ viewRoot, nodeIds }) => {
    const args = ['canvas', 'attention', 'map', '--json'];
    if (viewRoot) args.push('--view', viewRoot);
    const extra = (nodeIds || []).filter(Boolean);
    if (extra.length) args.push('--nodes', extra.join(','));
    return { kind: 'exec', bin: 'crtr', args };
  },
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return ok({});
    let data;
    try {
      data = JSON.parse(String(raw.stdout || '').trim() || '{}');
    } catch {
      return ok({});
    }
    const counts = data && data.counts && typeof data.counts === 'object' ? data.counts : {};
    /** @type {Record<string, number>} */
    const out = {};
    for (const [k, v] of Object.entries(counts)) out[k] = typeof v === 'number' ? v : 0;
    return ok(out);
  },
};

/**
 * The host's working directory — the workspace scope key the rail filters on.
 * Resolved through the transport (which runs exec in the host's cwd) so it is
 * uniform across BOTH targets: `process.cwd()` is a Node-only facility the
 * browser can't read, so the web target would otherwise scope to '' and show an
 * empty rail. BEST-EFFORT — a failure falls back to the init-time cwd.
 * @type {import('../../core/view/contract.js').Source<string>}
 */
export const cwdSource = {
  id: 'cwd',
  request: () => ({ kind: 'exec', bin: 'pwd', args: [] }),
  parse: (raw) => ok(raw.ok && raw.exitCode === 0 ? String(raw.stdout || '').trim() : ''),
};

/**
 * The tmux panes in the rail's window, each with its `@crtr_node` tag. The chat
 * pane the rail drives is the one attach has tagged (the tag survives the
 * swap-pane `crtr node focus` does). BEST-EFFORT — no tmux / a failure yields []
 * so the rail still renders (just without a chat-pane controller; the web target
 * always lands here). The self-pane never carries `@crtr_node` (the rail tags
 * `@crtr_view`), so "first pane with a node tag" is the chat pane without any
 * self-exclusion.
 * @type {import('../../core/view/contract.js').Source<Array<{pane:string, node:string}>>}
 */
export const panesSource = {
  id: 'tmux-panes',
  request: () => ({ kind: 'exec', bin: 'tmux', args: ['list-panes', '-F', '#{pane_id}\t#{@crtr_node}'] }),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return ok([]);
    /** @type {Array<{pane:string, node:string}>} */
    const rows = [];
    for (const line of String(raw.stdout || '').split(/\r?\n/)) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const pane = (tab < 0 ? line : line.slice(0, tab)).trim();
      const node = tab < 0 ? '' : line.slice(tab + 1).trim();
      if (pane) rows.push({ pane, node });
    }
    return ok(rows);
  },
};

// ── Commands (writes): invoked by an intent ───────────────────────────────────

/**
 * Focus a node into the chat pane (`crtr node focus <id> --pane <pane>`) — the
 * swap-pane call the Alt+G graph overlay uses. The swap lands in the OTHER pane,
 * so the rail neither waits on nor renders its result.
 * @type {import('../../core/view/contract.js').Command<boolean, {nodeId:string, pane:string}>}
 */
export const focusCommand = {
  id: 'focus',
  request: ({ nodeId, pane }) => ({ kind: 'exec', bin: 'crtr', args: ['node', 'focus', nodeId, '--pane', pane] }),
  parse: (raw) => ok(raw.ok && raw.exitCode === 0),
};

// ── Forest model (within the cwd-scoped node set; pure) ────────────────────────

/** @param {CanvasNode} a @param {CanvasNode} b @returns {number} */
function byBirth(a, b) {
  return a.created < b.created ? -1 : a.created > b.created ? 1 : 0;
}

/**
 * Build id→node, parent→children, and the root list for the cwd-scoped set. A
 * node is a ROOT when it has no parent inside the set.
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
  for (const arr of children.values()) arr.sort(byBirth);
  roots.sort(byBirth);
  return { byId, children, roots };
}

/**
 * Climb from `id` to its forest root within the set. Cycle-guarded.
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

/**
 * @param {string} id @param {Map<string,CanvasNode[]>} children
 * @param {Map<string,CanvasNode>} byId @param {Set<string>} [guard] @returns {boolean}
 */
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

// ── Row builders (pure → logical RailRow[]) ───────────────────────────────────

/** @param {CanvasNode} n @param {string} prefix @param {boolean} attached @param {number} asks @returns {RailRow} */
function nodeRow(n, prefix, attached, asks) {
  return { kind: 'node', nodeId: n.nodeId, name: n.name, status: n.status, prefix, attached, asks };
}
/** @param {string} text @returns {RailRow} */
function headerRow(text) {
  return { kind: 'header', text };
}
/** @param {string} [text] @returns {RailRow} */
function chromeRow(text) {
  return { kind: 'chrome', text: text || '' };
}

/**
 * Build the cwd-scoped forest + pick `this graph`'s root. Pure. The caller
 * (`refresh`) folds attention counts in and flattens the two sections, since
 * those need the (async) attention source resolved first.
 * @param {CanvasNode[]} mine
 * @param {string|null} attachedNode
 */
function buildRail(mine, attachedNode) {
  const { byId, children, roots } = buildForest(mine);

  // `this graph` root: the attached node's root if known & present, else the
  // newest LIVE root here, else the newest root, else none.
  /** @type {string|null} */
  let currentRoot = null;
  if (attachedNode && byId.has(attachedNode)) {
    currentRoot = climbRoot(attachedNode, byId);
  } else {
    const live = roots.filter((r) => subtreeLive(r.nodeId, children, byId));
    const pool = live.length ? live : roots;
    if (pool.length) currentRoot = pool[pool.length - 1].nodeId; // newest
  }

  return {
    byId, children, roots, currentRoot,
    liveRoots: roots.filter((r) => subtreeLive(r.nodeId, children, byId)),
  };
}

// ── Cursor model (skips chrome rows) ───────────────────────────────────────────

/** @param {RailRow[]} rows @returns {number[]} */
function selectableIdx(rows) {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].kind === 'node') out.push(i);
  return out;
}

/**
 * Re-home the cursor after a rebuild: same nodeId if still present, else the
 * attached node, else the first selectable row.
 * @param {RailRow[]} rows @param {string|null} prevId @param {string|null} attachedNode @returns {number}
 */
function reanchor(rows, prevId, attachedNode) {
  const sel = selectableIdx(rows);
  if (sel.length === 0) return 0;
  const want = prevId || attachedNode;
  const found = want ? rows.findIndex((r) => r.kind === 'node' && r.nodeId === want) : -1;
  return found >= 0 ? found : sel[0];
}

/** @param {SidebarState} s @param {1|-1} dir @returns {SidebarState} */
function moveCursor(s, dir) {
  const sel = selectableIdx(s.rows);
  if (sel.length === 0) return s;
  const pos = sel.indexOf(s.cursor);
  if (pos < 0) return { ...s, cursor: sel[0] };
  const next = Math.max(0, Math.min(sel.length - 1, pos + dir));
  return { ...s, cursor: sel[next] };
}

// ── The portable core ──────────────────────────────────────────────────────────

/** @type {import('../../core/view/contract.js').ViewCore<SidebarState>} */
const core = {
  manifest: {
    id: 'workspace-sidebar',
    title: 'Workspace',
    description: 'Left rail for `crtr workspace` — this graph + other agents in this cwd',
    refreshMs: 2500,
  },

  /** Cheap + synchronous initial state — NO fetch. @param {Readonly<Record<string,string>>} opts @returns {SidebarState} */
  init(opts) {
    return {
      cwd: typeof process !== 'undefined' && process.cwd ? process.cwd() : '',
      targetOverride: String((opts && opts.target) || ''),
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
      srcError: null,
    };
  },

  sources: { cwdSource, nodesSource, attentionSource, panesSource },
  commands: { focusCommand },

  intents: {
    /**
     * Resolve the chat pane + attached node from tmux, pull the node graph,
     * scope to this cwd, and rebuild the two-section rail. Runs in the host's
     * single-flight lane. A blocking node-source failure with no prior rail
     * drops to a guided takeover; a transient failure KEEPS the last-known rail.
     * @param {Ctx} ctx
     */
    async refresh(ctx) {
      ctx.signal.setStatus('Loading…');

      // Resolve the chat pane (the @crtr_node-tagged sibling; the launch-time
      // --target is the fallback when no pane is tagged yet) + its attached node.
      const panes = await ctx.resolve(panesSource);
      let chatPane = '';
      /** @type {string|null} */
      let attachedNode = null;
      if (panes.ok) {
        const tagged = panes.data.find((p) => p.node);
        if (tagged) {
          chatPane = tagged.pane;
          attachedNode = tagged.node;
        }
      }
      if (!chatPane && ctx.state.targetOverride) chatPane = ctx.state.targetOverride;

      // The workspace scope key — resolved through the transport (uniform across
      // TUI + web), falling back to the init-time cwd.
      const cwdR = await ctx.resolve(cwdSource);
      const cwd = cwdR.ok && cwdR.data ? cwdR.data : ctx.state.cwd;

      const rn = await ctx.resolve(nodesSource);
      if (!rn.ok) {
        const err = rn.error;
        const hadRail = ctx.state.rows.length > 0;
        const keep = !err.display.blocking && hadRail;
        ctx.set((s) => {
          /** @type {SidebarState} */
          const next = { ...s, cwd, chatPane, attachedNode, srcError: err };
          if (!keep) {
            next.rows = [];
            next.currentRoot = null;
            next.graphsHere = 0;
            next.nodesHere = 0;
            next.asksHere = 0;
          }
          return next;
        });
        // A takeover (empty rail) owns the rect + names the cause; a kept rail
        // raises the cause as a banner.
        if (keep) ctx.signal.setBanner(err.display.explanation, err.display.level);
        else ctx.signal.clearBanner();
        ctx.signal.setStatus(null);
        ctx.signal.setSubtitle(null);
        return;
      }

      const mine = rn.data.filter((n) => n.cwd === cwd);
      const { byId, children, roots, currentRoot, liveRoots } = buildRail(mine, attachedNode);

      // Attention in one pass: the current sub-DAG + EVERY root here (so a
      // blocked-but-not-live root still surfaces its ⚑). Best-effort.
      const rootIds = roots.map((r) => r.nodeId);
      let asks = /** @type {Record<string,number>} */ ({});
      if (currentRoot || rootIds.length) {
        const a = await ctx.resolve(attentionSource, { viewRoot: currentRoot, nodeIds: rootIds });
        if (a.ok) asks = a.data;
      }
      let asksHere = 0;
      for (const v of Object.values(asks)) asksHere += v;

      // `elsewhere` = other roots still LIVE OR with a pending ask. Live first,
      // then newest.
      const others = roots.filter(
        (r) => r.nodeId !== currentRoot && (subtreeLive(r.nodeId, children, byId) || (asks[r.nodeId] || 0) > 0),
      );
      others.sort((a, b) => {
        const la = subtreeLive(a.nodeId, children, byId) ? 1 : 0;
        const lb = subtreeLive(b.nodeId, children, byId) ? 1 : 0;
        if (la !== lb) return lb - la;
        return a.created < b.created ? 1 : -1; // newest first
      });

      // ── Build the flat render list ───────────────────────────────────────
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
          rows.push(nodeRow(node, prefix, node.nodeId === attachedNode, asks[node.nodeId] || 0));
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

      const prevRow = ctx.state.rows[ctx.state.cursor];
      const cursor = reanchor(rows, prevRow && prevRow.kind === 'node' ? prevRow.nodeId : null, attachedNode);

      ctx.set((s) => ({
        ...s,
        cwd,
        chatPane,
        attachedNode,
        currentRoot,
        rows,
        cursor,
        graphsHere: liveRoots.length,
        nodesHere: mine.length,
        asksHere,
        lastFetch: Date.now(),
        srcError: null,
      }));

      ctx.signal.setSubtitle(liveRoots.length > 0 ? `${plural(liveRoots.length, 'live graph')}` : null);
      if (asksHere > 0) ctx.signal.setBanner(`${plural(asksHere, 'ask')} waiting on a human — see the ⚑ rows`, 'action');
      else ctx.signal.clearBanner();
      ctx.signal.setStatus(null);
    },

    /** @param {Ctx} ctx */
    cursorDown: (ctx) => ctx.set((s) => moveCursor(s, 1)),
    /** @param {Ctx} ctx */
    cursorUp: (ctx) => ctx.set((s) => moveCursor(s, -1)),
    /** @param {Ctx} ctx @param {number} [i] */
    select: (ctx, i) =>
      ctx.set((s) => {
        if (typeof i !== 'number') return s;
        return selectableIdx(s.rows).includes(i) ? { ...s, cursor: i } : s;
      }),

    /**
     * Swap the cursor's node into the chat pane (TUI ↵). No chat pane wired (the
     * web target, or a rail not launched via `crtr workspace`) ⇒ a guidance
     * banner, no-op.
     * @param {Ctx} ctx
     */
    async open(ctx) {
      const s = ctx.state;
      const row = s.rows[s.cursor];
      if (!row || row.kind !== 'node') return;
      if (!s.chatPane) {
        ctx.signal.setBanner('No chat pane wired — run this rail via `crtr workspace`.', 'error');
        return;
      }
      await ctx.execute(focusCommand, { nodeId: row.nodeId, pane: s.chatPane });
      ctx.signal.setStatus(`→ ${row.name}`);
    },

    /** @param {Ctx} ctx */
    quit: (ctx) => ctx.signal.quit(),
  },
};

export default core;
