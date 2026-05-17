/**
 * Memoized, self-healing. Ensures the pinned termrender binary exists inside
 * the humanloop-managed venv; (re)provisions it via `uv` when missing or the
 * version drifts from the pin. Runs at most once per process. Single
 * degradation path: `uv` absent → one stderr remediation line + plaintext
 * fallback. win32 → plaintext (no renderer).
 *
 * Invoked at postinstall AND lazily on the first render/check/display call,
 * so `npm ci --ignore-scripts` consumers still self-heal on first use.
 */
export declare function ensureRenderer(): void;
/** Cheap predicate — true when the pinned managed binary is present and correct. Does not install. */
export declare function isRendererReady(): boolean;
/** Render markdown to terminal lines via the pinned binary; plaintext fallback. */
export declare function renderMarkdown(md: string, width: number): string[];
/** Validate markdown via `termrender doc check`. */
export declare function checkMarkdown(md: string): {
    ok: true;
} | {
    ok: false;
    error: string;
};
export interface DisplayInPaneOpts {
    /** Pass watch so the pane live-updates on file edits. Default true. */
    watch?: boolean;
    /** Open in a new tmux window instead of splitting the current one. */
    newWindow?: boolean;
}
/**
 * Spawn termrender into a live tmux pane. The pane-budget policy (whether to
 * split vs open a new window) is decided by the caller (`src/surfaces/
 * display.ts`); this is the thin managed-binary spawn it delegates to.
 */
export declare function displayInPane(path: string, opts?: DisplayInPaneOpts): {
    paneId?: string;
};
