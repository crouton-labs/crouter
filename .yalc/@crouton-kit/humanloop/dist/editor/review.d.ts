import type { FeedbackResult } from '../types.js';
export interface ReviewOptions {
    /** Where the answers JSON is written (live autosave + finalized on exit). */
    output: string;
    /** Editor binary override. Default: first of nvim, vim on PATH. */
    editor?: string;
    /** Force running in the current terminal even when $TMUX is set. */
    noTmux?: boolean;
}
/**
 * Compact stdout rendering for the agent: per comment just the line:col
 * range, the original text in that span, and the note — plus the source
 * path, a pointer to the full JSON on disk, and a one-line schema hint.
 * The verbose fields are deliberately not printed so they don't clog context.
 */
export declare function formatFeedbackSummary(result: FeedbackResult, feedbackJsonPath: string): string;
/**
 * Open a markdown file in a clean, read-only Neovim/Vim review session. The
 * human anchors comments to source lines/selections with native vim motions
 * and quits to submit. Blocks until the editor exits, then finalizes and
 * returns the feedback. Autosaved continuously so a kill is recoverable and
 * the next run resumes.
 */
export declare function launchReview(file: string, opts: ReviewOptions): Promise<FeedbackResult>;
