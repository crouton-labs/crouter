import type { DisplayOpts } from '../types.js';
export declare function countPanesInCurrentWindow(): number;
export declare function display(path: string, opts?: DisplayOpts): {
    paneId?: string;
};
