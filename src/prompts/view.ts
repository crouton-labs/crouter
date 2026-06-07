// Scaffold stub for `crtr view new`. Returns the contents of a runnable
// `view.mjs` — a minimal, self-contained ViewModule that runs as-is via
// `crtr view run <name>` and prints a sane snapshot when piped (`| cat`).
//
// Authoring guidance lives INSIDE the stub (the comment block at the top of the
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

/** Build the `view.mjs` source for a freshly scaffolded view. */
export function viewScaffold(v: ViewScaffoldVars): string {
  const id = jsStr(v.id);
  const title = jsStr(v.title);
  const description = jsStr(v.description);
  return `// ${v.title} — a crtr view.
//
// A view is a self-contained ESM module the \`crtr view\` host loads and runs.
//   Run it:   crtr view run ${v.id}          (interactive, inside tmux)
//             crtr view run ${v.id} | cat    (static snapshot, exits 0)
//
// THE CONTRACT (the host injects everything — import NOTHING from crtr):
//   manifest            { id, title, description, refreshMs?, keymap? }
//                       id MUST equal this view's directory name.
//   init(host)          build initial state — keep it CHEAP and sync-ish;
//                       do NOT do slow fetches here (do them in refresh).
//   refresh(state,host) async data load; the host runs it on launch, every
//                       manifest.refreshMs (if set), and whenever a key handler
//                       returns { type: 'refresh' }. Mutate state in place.
//   render(state,draw,content)  paint into the \`content\` Rect via draw.* —
//                       a pure read of state; NEVER write ANSI yourself.
//   onKey(k,state,host) handle one keystroke; mutate state; return a ViewAction.
//   dump(state)         plain text for the piped / non-TTY path (exit 0).
//
// draw API (all absolute cells inside \`content\`):
//   draw.text(row,col,text,style?)            · draw.spans(row,col,spans,maxWidth?)
//   draw.hline(row,fromCol?,toCol?)           · draw.box(rect,title?)
//   draw.columns(rect,[1,2]) -> Rect[]        (proportional split)
//   draw.list(rect,items,cursor,scroll) -> { scroll }   (windows + cursor row)
//   style: { fg, bg, bold, dim, reverse }     (fg/bg honored only when color is on)
// host API:
//   host.options          CLI --flags, camelCased & stringified (e.g. options.port)
//   host.setStatus(msg)   transient footer-left status; null clears it
//   host.setError(msg)    sticky red banner above the footer; null clears it
// ViewAction: { type: 'render' | 'refresh' | 'quit' | 'none' }

/** @type {import('@crouton-kit/crouter/dist/core/tui/contract.js').ViewModule} */
const view = {
  manifest: {
    id: '${id}',
    title: '${title}',
    description: '${description}',
    // refreshMs: 30000,   // uncomment to auto-poll; omit ⇒ on-demand (g) only
    keymap: [
      { keys: 'g', label: 'refresh' },
      { keys: 'q', label: 'quit' },
    ],
  },

  init(host) {
    // Cheap, synchronous setup. Stash CLI flags off host.options here.
    return { count: 0, port: host.options.port ?? null };
  },

  async refresh(state, host) {
    // Load your data here (shell out, fetch, read files). Mutate \`state\`.
    state.count += 1;
    host.setStatus(\`refreshed \${state.count}×\`);
  },

  render(state, draw, content) {
    draw.text(content.row, content.col, '${title}', { bold: true });
    draw.text(content.row + 2, content.col, \`refreshed \${state.count} time(s)\`);
    draw.text(content.row + 3, content.col, \`port option: \${state.port ?? '(none)'}\`, { dim: true });
    draw.text(
      content.row + 5,
      content.col,
      'Edit view.mjs to build your view — g refreshes, q quits.',
      { dim: true },
    );
  },

  onKey(k, state, host) {
    if (k.input === 'q') return { type: 'quit' };
    if (k.input === 'g') return { type: 'refresh' };
    return { type: 'none' };
  },

  dump(state) {
    return [
      '${title}',
      '',
      \`refreshed \${state.count} time(s)\`,
      \`port option: \${state.port ?? '(none)'}\`,
    ].join('\\n');
  },
};

export default view;
`;
}
