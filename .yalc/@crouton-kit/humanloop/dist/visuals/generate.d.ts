import type { Interaction } from '../types.js';
export declare function defaultGenerateVisual(interaction: Interaction, conversationContext: string): Promise<{
    ok: true;
    ansi: string;
    markdown: string;
} | {
    ok: false;
    error: string;
}>;
