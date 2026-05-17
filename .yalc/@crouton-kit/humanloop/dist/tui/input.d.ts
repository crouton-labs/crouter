import type { TuiState, Interaction } from '../types.js';
import type { Key } from './terminal.js';
export type RenderFn = () => void;
export type ExitFn = () => void;
export declare function assignShortcuts(interactions: Interaction[]): void;
export declare function handleKeypress(input: string, key: Key, state: TuiState, render: RenderFn, exit: ExitFn): void;
