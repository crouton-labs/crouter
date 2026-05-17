import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync } from 'fs';
const CLAUDE_DB_PATH = join(homedir(), '.claude', '__store.db');
export function readConversation(sessionId) {
    if (!existsSync(CLAUDE_DB_PATH)) {
        throw new Error(`Claude database not found at ${CLAUDE_DB_PATH}`);
    }
    const query = `
    SELECT bm.message_type,
           COALESCE(um.message, am.message) AS content
    FROM base_messages bm
    LEFT JOIN user_messages um ON bm.uuid = um.uuid
    LEFT JOIN assistant_messages am ON bm.uuid = am.uuid
    WHERE bm.session_id = '${sessionId.replace(/'/g, "''")}'
    ORDER BY bm.timestamp ASC;
  `;
    const raw = execSync(`sqlite3 -json "${CLAUDE_DB_PATH}" "${query.replace(/"/g, '\\"')}"`, {
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
    });
    if (!raw.trim())
        return [];
    const rows = JSON.parse(raw);
    const messages = [];
    for (const row of rows) {
        if (!row.content)
            continue;
        if (row.message_type === 'user' || row.message_type === 'assistant') {
            messages.push({
                role: row.message_type,
                content: row.content,
            });
        }
    }
    return messages;
}
export function findRecentSessionId(cwd) {
    if (!existsSync(CLAUDE_DB_PATH))
        return null;
    const whereClause = cwd
        ? `WHERE cwd = '${cwd.replace(/'/g, "''")}'`
        : '';
    const query = `SELECT DISTINCT session_id FROM base_messages ${whereClause} ORDER BY timestamp DESC LIMIT 1;`;
    try {
        const raw = execSync(`sqlite3 -json "${CLAUDE_DB_PATH}" "${query.replace(/"/g, '\\"')}"`, {
            encoding: 'utf8',
        });
        if (!raw.trim())
            return null;
        const rows = JSON.parse(raw);
        return rows[0]?.session_id ?? null;
    }
    catch {
        return null;
    }
}
