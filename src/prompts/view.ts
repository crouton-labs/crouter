// Scaffold stubs for `crtr view new`. Returns the four files of a dual-target
// view directory — a portable `core.mjs` plus the TUI / web / text presenters —
// that runs as-is via `crtr view run <name>` (TUI), `crtr view serve <name>`
// (web), and `crtr view run <name> | cat` (static snapshot).
//
// Authoring guidance lives INSIDE each stub (the comment block at the top of the
// generated file), so a view author reads the contract right where they edit.

export interface ViewScaffoldVars {
  id: string;
  title: string;
  description: string;
}

/** Escape a value for embedding inside a single-quoted JS string literal. */
function jsStr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/** The portable core: manifest · init · sources · intents. Runs in BOTH Node
 *  (the TUI host) and the browser (the web bundle) — imports NOTHING. */
function coreStub(v: ViewScaffoldVars): string {
  const id = jsStr(v.id);
  const title = jsStr(v.title);
  const description = jsStr(v.description);
  return `// ${v.title} — portable core (manifest · init · sources · intents).
//
// Runs in BOTH Node (the TUI host) and the browser (the web bundle), so it
// imports NOTHING — no \`node:*\`, no crtr. ALL state + behavior live here;
// presenters (tui.mjs / web.jsx) are pure reads that dispatch named intents.
//
//   Run it:   crtr view run ${v.id}          (TUI, inside tmux)
//             crtr view run ${v.id} | cat    (static snapshot, exits 0)
//             crtr view serve ${v.id}        (React + Tailwind web page)
//
// THE CONTRACT:
//   manifest          { id, title, description, refreshMs? } — id MUST equal
//                     this view's directory name.
//   init(opts)        cheap, SYNCHRONOUS initial state — NO fetch, NO screen.
//                     CLI flags arrive in \`opts\` (crtr view run --port/--target).
//   sources           { request, parse } READ descriptors. The host's transport
//                     runs request() (exec/file/http) and hands parse() the bytes
//                     — your parse is pure, runs in Node AND the browser.
//   intents           semantic actions both targets dispatch. State updates are
//                     IMMUTABLE via ctx.set; async effects (ctx.resolve a source)
//                     live in the same handler. ctx.signal raises chrome signals.

/** A READ source: a transport-agnostic request + a pure parse. */
export const clockSource = {
  id: 'clock',
  request: () => ({ kind: 'exec', bin: 'date', args: [] }),
  parse: (raw) =>
    raw.ok && raw.exitCode === 0
      ? { ok: true, data: raw.stdout.trim() }
      : { ok: false, error: { kind: 'clock-failed', display: {
          headline: 'Could not read the clock',
          explanation: raw.stderr || 'the date command failed',
          nextStep: 'Check the \`date\` binary is on PATH.',
          level: 'error', blocking: true } } },
};

/** @type {import('@crouton-kit/crouter/dist/core/view/contract.js').ViewCore} */
const core = {
  manifest: {
    id: '${id}',
    title: '${title}',
    description: '${description}',
    // refreshMs: 30000,   // uncomment to auto-poll; omit ⇒ on-demand (g) only
  },

  // Cheap, synchronous setup. Stash CLI flags off \`opts\` here.
  init: (opts) => ({ count: 0, clock: null, port: opts.port ?? null }),

  sources: { clockSource },

  intents: {
    // Async intent: ctx.set updates state immutably; ctx.resolve runs a source
    // through the host transport. The host runs 'refresh' on launch, every
    // manifest.refreshMs (if set), and on the \`g\` key (see tui.mjs).
    async refresh(ctx) {
      ctx.signal.setStatus('Reading clock…');
      const r = await ctx.resolve(clockSource);
      if (!r.ok) { ctx.signal.setBanner(r.error.display.headline, r.error.display.level); ctx.signal.setStatus(null); return; }
      ctx.set((s) => ({ ...s, count: s.count + 1, clock: r.data }));
      ctx.signal.clearBanner();
      ctx.signal.setStatus(\`refreshed \${ctx.state.count}×\`);
    },
    quit: (ctx) => ctx.signal.quit(),
  },
};

export default core;
`;
}

/** The TUI presenter: render(state, draw, content) + keymap. Node only. */
function tuiStub(v: ViewScaffoldVars): string {
  const title = jsStr(v.title);
  return `// ${v.title} — TUI presenter: render(state, draw, content) + keymap.
//
// A pure read of state — paint via draw.*; NEVER write ANSI. Keys map to the
// core's intents (no logic here; the keymap names an intent, the host dispatches).
//
// draw API (all absolute cells inside \`content\`):
//   draw.text(row,col,text,style?)            · draw.spans(row,col,spans,maxWidth?)
//   draw.hline(row,fromCol?,toCol?)           · draw.box(rect,title?)
//   draw.columns(rect,[1,2]) -> Rect[]        · draw.list(rect,items,cursor,scroll)
//   style: { fg, bg, bold, dim, reverse }     (fg/bg honored only when color is on)

export const keymap = [
  { keys: ['g'], intent: 'refresh', hint: { keys: 'g', label: 'refresh' } },
  { keys: ['q'], intent: 'quit', hint: { keys: 'q', label: 'quit' } },
];

export function render(state, draw, content) {
  draw.text(content.row, content.col, '${title}', { bold: true });
  draw.text(content.row + 2, content.col, \`clock: \${state.clock ?? '(loading…)'}\`);
  draw.text(content.row + 3, content.col, \`refreshed \${state.count} time(s)\`, { dim: true });
  draw.text(content.row + 4, content.col, \`port option: \${state.port ?? '(none)'}\`, { dim: true });
  draw.text(content.row + 6, content.col, 'Edit core.mjs + tui.mjs to build your view — g refreshes, q quits.', { dim: true });
}
`;
}

/** The web presenter: a React + Tailwind component. Browser only (Vite owns the
 *  JSX + Tailwind transpile; this file is NEVER Node-imported). */
function webStub(v: ViewScaffoldVars): string {
  const title = jsStr(v.title);
  return `// ${v.title} — web presenter: a React + Tailwind component.
//
// A pure function of \`state\`; DOM events call \`dispatch(intent)\`. Consumed ONLY
// by \`crtr view serve\` (Vite owns JSX + Tailwind) — never Node-imported. The
// SAME state + intents the TUI reads; zero shared render code (an intentional fork).

export default function View({ state, dispatch }) {
  return (
    <div
      className="font-mono text-sm p-4 outline-none"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'g') dispatch('refresh'); }}
    >
      <h1 className="text-lg font-bold">${title}</h1>
      <p className="mt-2">clock: {state.clock ?? '(loading…)'}</p>
      <p className="text-gray-500">refreshed {state.count} time(s)</p>
      <button
        className="mt-3 rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-500"
        onClick={() => dispatch('refresh')}
      >
        Refresh
      </button>
    </div>
  );
}
`;
}

/** The text presenter: the piped / non-TTY snapshot. Node only. Optional — omit
 *  it and the host synthesizes a generic one-line dump. */
function textStub(v: ViewScaffoldVars): string {
  const title = jsStr(v.title);
  return `// ${v.title} — text presenter: the piped / non-TTY snapshot (exits 0).
//
// A pure read of current state. Omit this file and the host synthesizes a
// one-line dump (\`<title> — <n> items\`).

export function dump(state) {
  return [
    '${title}',
    '',
    \`clock: \${state.clock ?? '(none)'}\`,
    \`refreshed \${state.count} time(s)\`,
  ].join('\\n');
}
`;
}

/** Build every file of a freshly scaffolded dual-target view, keyed by filename. */
export function viewScaffold(v: ViewScaffoldVars): Record<string, string> {
  return {
    'core.mjs': coreStub(v),
    'tui.mjs': tuiStub(v),
    'web.jsx': webStub(v),
    'text.mjs': textStub(v),
  };
}
