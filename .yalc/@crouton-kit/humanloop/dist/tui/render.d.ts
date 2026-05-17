import type { TuiState, Interaction, InteractionResponse } from '../types.js';
export declare function sanitize(text: string): string;
export declare function diffFrame(prevFrame: string[], nextLines: string[], rows: number): {
    writes: string[];
    nextPrevFrame: string[];
};
export declare function renderOverview(state: TuiState, cols: number, rows: number): string[];
export declare function renderItemReview(state: TuiState, cols: number, rows: number): string[];
export declare function renderFinal(state: TuiState, cols: number, rows: number): string[];
export declare function responseSummary(r: InteractionResponse, interaction: Interaction): string;
