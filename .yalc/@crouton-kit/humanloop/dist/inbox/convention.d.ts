import type { InteractionResponse } from '../types.js';
export declare function deckPath(dir: string): string;
export declare function responsePath(dir: string): string;
export declare function progressPath(dir: string): string;
export declare function visualsDir(dir: string): string;
export declare function visualMdPath(dir: string, id: string): string;
export declare function visualAnsiPath(dir: string, id: string): string;
export type InteractionState = 'pending' | 'in-progress' | 'resolved' | 'missing';
export declare function interactionState(dir: string): InteractionState;
export declare function isResolved(dir: string): boolean;
/** Returns true if a live resolver owns this dir (progress.json mtime < 300s). */
export declare function isClaimed(dir: string): boolean;
export declare function atomicWriteJson(path: string, value: unknown): void;
export declare function readJson<T>(path: string): T | null;
export declare function writeResponse(dir: string, responses: InteractionResponse[], completedAt: string): string;
export declare function writeProgress(dir: string, responses: InteractionResponse[]): void;
export declare function clearProgress(dir: string): void;
