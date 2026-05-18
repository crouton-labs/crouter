import type { Deck, InteractionResponse, MountedPanel, MountedPanelOpts, GenerateVisual } from '../types.js';
/** Validate an arbitrary parsed value as a Deck. Delegates to the canonical
 * Zod validator in `inbox/deck-schema.ts` (the single source of truth shared
 * with sisyphus). Kept exported for back-compat. */
export declare function validateInput(parsed: unknown): Deck;
export declare function mountPanel(opts: MountedPanelOpts): MountedPanel;
export interface ResolveDirOpts {
    /** Claude session id → per-interaction visual context from history. */
    sessionId?: string;
    /** Explicit visual generator; overrides the sessionId default. */
    generateVisual?: GenerateVisual;
    cols?: number;
    rows?: number;
}
/**
 * Resolve an interaction directory in place: mount the panel TUI keyed off
 * `<dir>/progress.json`, and on finish (full completion OR human-finished
 * with skips) write `<dir>/response.json` atomically and drop the progress
 * file. A hard process kill leaves `progress.json` for a later resume —
 * `tryResume` (unchanged logic) reads the new dir-derived path.
 *
 * While the panel is mounted, `<dir>/deck.json` is polled for changes (an
 * agent calling `hl deck update`). On a valid rewrite the panel is reloaded
 * in place via `loadDeck`, so the human's pane reflects the new questions
 * without a respawn; answers for surviving interaction ids are kept. The
 * returned `deck` is the one actually answered (post-reload).
 */
export declare function resolveInteractionDir(dir: string, deck: Deck, opts?: ResolveDirOpts): Promise<{
    responses: InteractionResponse[];
    completedAt: string;
    responsePath: string;
    deck: Deck;
}>;
export declare function launchTui(decisionsPath: string, sessionId?: string): Promise<{
    responses: InteractionResponse[];
    completedAt: string;
}>;
