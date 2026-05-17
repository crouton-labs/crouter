export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
}
export declare function readConversation(sessionId: string): ConversationMessage[];
export declare function findRecentSessionId(cwd?: string): string | null;
