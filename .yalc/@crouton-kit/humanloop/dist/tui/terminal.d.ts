export interface Key {
    upArrow: boolean;
    downArrow: boolean;
    return: boolean;
    escape: boolean;
    ctrl: boolean;
    tab: boolean;
    backspace: boolean;
}
export type KeypressHandler = (input: string, key: Key) => void;
export declare function parseKeypress(data: Buffer): {
    input: string;
    key: Key;
};
export declare function setupTerminal(): void;
export declare function restoreTerminal(): void;
export declare function getTerminalSize(): {
    cols: number;
    rows: number;
};
