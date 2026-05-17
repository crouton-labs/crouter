import type { Deck, ResolutionEnvelope, GenerateVisual } from './types.js';
export interface AskOpts {
    /** Interaction directory. Defaults to a managed temp dir under os.tmpdir(). */
    dir?: string;
    sessionId?: string;
    cols?: number;
    rows?: number;
}
/**
 * Resolve a deck against an interaction directory and return the resolution
 * envelope. Writes `<dir>/deck.json` (the request, per the convention) and,
 * on completion, `<dir>/response.json`.
 */
export declare function ask(deck: Deck, opts?: AskOpts): Promise<ResolutionEnvelope>;
export interface ApproveOpts {
    subtitle?: string;
    body?: string;
    dir?: string;
    sessionId?: string;
}
/** Sugar: a single `kind:'validation'` Yes/No interaction. */
export declare function approve(title: string, opts?: ApproveOpts): Promise<boolean>;
/** Sugar: a single `kind:'notify'` acknowledgement. */
export declare function notify(title: string, body?: string): Promise<void>;
export interface InboxOpts {
    cols?: number;
    rows?: number;
    generateVisual?: GenerateVisual;
}
/**
 * List → resolve loop across `roots`. Shows pending interactions, lets the
 * human pick one, resolves it (writing its `response.json`), then rescans —
 * resolved items drop out — until the human quits or nothing is pending.
 */
export declare function inbox(roots: string[], opts?: InboxOpts): Promise<void>;
