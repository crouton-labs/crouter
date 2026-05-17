import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveInteractionDir } from './tui/app.js';
import { scanInbox } from './inbox/scan.js';
import { pickFromInbox } from './inbox/tui.js';
import { deckPath, atomicWriteJson, readJson } from './inbox/convention.js';
import { getTerminalSize } from './tui/terminal.js';
const RESPONSE_SCHEMA_ID = 'humanloop.response/v2';
function managedDir() {
    return mkdtempSync(join(tmpdir(), 'hl-ix-'));
}
/**
 * Deterministic, no-LLM resolution summary — one line per answered
 * interaction: `"<title>: <option label>[ — <freetext>]"`.
 */
function buildSummary(deck, responses) {
    const byId = new Map(responses.map((r) => [r.id, r]));
    const lines = [];
    for (const it of deck.interactions) {
        const r = byId.get(it.id);
        if (r === undefined)
            continue;
        const ft = r.freetext !== undefined && r.freetext !== '' ? r.freetext : undefined;
        let picked;
        if (r.selectedOptionIds !== undefined) {
            const labels = r.selectedOptionIds
                .map((id) => it.options.find((o) => o.id === id))
                .filter((o) => o !== undefined)
                .map((o) => o.label);
            picked = labels.length > 0 ? labels.join(', ') : undefined;
        }
        else if (r.selectedOptionId !== undefined) {
            picked = it.options.find((o) => o.id === r.selectedOptionId)?.label;
        }
        let val;
        if (picked !== undefined && ft !== undefined)
            val = `${picked} — ${ft}`;
        else if (picked !== undefined)
            val = picked;
        else if (ft !== undefined)
            val = ft;
        else
            val = '(skipped)';
        lines.push(`${it.title}: ${val}`);
    }
    return lines.join('\n');
}
/**
 * Resolve a deck against an interaction directory and return the resolution
 * envelope. Writes `<dir>/deck.json` (the request, per the convention) and,
 * on completion, `<dir>/response.json`.
 */
export async function ask(deck, opts = {}) {
    const dir = opts.dir ?? managedDir();
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(deckPath(dir), deck);
    const { responses, completedAt, responsePath } = await resolveInteractionDir(dir, deck, {
        sessionId: opts.sessionId,
        cols: opts.cols,
        rows: opts.rows,
    });
    return {
        summary: buildSummary(deck, responses),
        responsePath,
        schema: RESPONSE_SCHEMA_ID,
        responses,
        completedAt,
    };
}
/** Sugar: a single `kind:'validation'` Yes/No interaction. */
export async function approve(title, opts = {}) {
    const deck = {
        interactions: [{
                id: 'approve',
                title,
                ...(opts.subtitle !== undefined ? { subtitle: opts.subtitle } : {}),
                ...(opts.body !== undefined ? { body: opts.body } : {}),
                kind: 'validation',
                options: [
                    { id: 'yes', label: 'Yes' },
                    { id: 'no', label: 'No' },
                ],
            }],
    };
    const env = await ask(deck, { dir: opts.dir, sessionId: opts.sessionId });
    return env.responses[0]?.selectedOptionId === 'yes';
}
/** Sugar: a single `kind:'notify'` acknowledgement. */
export async function notify(title, body) {
    const deck = {
        interactions: [{
                id: 'notify',
                title,
                ...(body !== undefined ? { body } : {}),
                kind: 'notify',
                options: [{ id: 'ok', label: 'OK' }],
            }],
    };
    await ask(deck, {});
}
/**
 * List → resolve loop across `roots`. Shows pending interactions, lets the
 * human pick one, resolves it (writing its `response.json`), then rescans —
 * resolved items drop out — until the human quits or nothing is pending.
 */
export async function inbox(roots, opts = {}) {
    for (;;) {
        const items = scanInbox(roots);
        if (items.length === 0)
            return;
        const term = getTerminalSize();
        const cols = opts.cols ?? term.cols;
        const rows = opts.rows ?? term.rows;
        const picked = await pickFromInbox(items, { cols, rows });
        if (picked === null)
            return;
        const deck = readJson(deckPath(picked.dir));
        if (deck === null)
            continue; // raced/removed — rescan
        await resolveInteractionDir(picked.dir, deck, {
            generateVisual: opts.generateVisual,
            cols,
            rows,
        });
    }
}
