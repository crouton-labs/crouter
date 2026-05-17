import type { ResolutionEnvelope } from '../types.js';
export interface TmuxDispatchOpts {
    sessionId?: string;
    visuals: boolean;
    /** Interaction dir forwarded to the child so response.json lands there. */
    dir: string;
}
export declare function dispatchToTmuxPane(file: string, opts: TmuxDispatchOpts): Promise<ResolutionEnvelope>;
