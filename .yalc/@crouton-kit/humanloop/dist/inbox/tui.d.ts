import type { InboxItem } from '../types.js';
export declare const KIND_ICON: Record<string, string>;
export declare const KIND_COLOR: Record<string, string>;
export declare function formatTimeAgo(iso: string): string;
export declare function buildInboxLines(items: InboxItem[], width: number, selectedIndex: number): string[];
export declare function pickFromInbox(items: InboxItem[], opts: {
    cols: number;
    rows: number;
}): Promise<InboxItem | null>;
