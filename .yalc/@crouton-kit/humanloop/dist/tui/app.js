import { readFileSync, existsSync, writeFileSync, renameSync, unlinkSync, statSync } from 'fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { setupTerminal, restoreTerminal, parseKeypress, getTerminalSize } from './terminal.js';
import { diffFrame, renderOverview, renderItemReview, renderFinal } from './render.js';
import { handleKeypress, assignShortcuts } from './input.js';
import { readConversation } from '../conversation/reader.js';
import { defaultGenerateVisual } from '../visuals/generate.js';
import { validateDeck } from '../inbox/deck-schema.js';
import { progressPath as progressPathFor, deckPath as deckPathFor, writeResponse, clearProgress } from '../inbox/convention.js';
/** Validate an arbitrary parsed value as a Deck. Delegates to the canonical
 * Zod validator in `inbox/deck-schema.ts` (the single source of truth shared
 * with sisyphus). Kept exported for back-compat. */
export function validateInput(parsed) {
    return validateDeck(parsed);
}
// ── Internal helpers ──────────────────────────────────────────────────────────
function buildInitialState(deck) {
    // Single-question decks skip the overview list — there's nothing to overview,
    // and overview hides the option hotkeys so users press 'y' and nothing happens.
    const initialPhase = deck.interactions.length === 1 ? 'item-review' : 'overview';
    const responses = new Map();
    const preAnsweredIds = new Set();
    // Seed responses + preAnsweredIds from any `preAnswered` field. The seeded
    // response counts as answered for navigation/auto-advance, but is rendered
    // distinctly so the human knows it carried over. `tryResume` runs after and
    // takes priority — mid-deck progress should not be overwritten by defaults.
    for (const interaction of deck.interactions) {
        const pa = interaction.preAnswered;
        if (pa === undefined)
            continue;
        const response = { id: interaction.id };
        if (pa.selectedOptionId !== undefined)
            response.selectedOptionId = pa.selectedOptionId;
        if (pa.selectedOptionIds !== undefined)
            response.selectedOptionIds = [...pa.selectedOptionIds];
        if (pa.freetext !== undefined)
            response.freetext = pa.freetext;
        responses.set(interaction.id, response);
        preAnsweredIds.add(interaction.id);
    }
    // Start cursor on the first unanswered interaction — humans land where they
    // need to act. If every interaction is pre-answered, fall back to index 0.
    const firstUnanswered = deck.interactions.findIndex((i) => !responses.has(i.id));
    return {
        phase: initialPhase,
        currentIndex: firstUnanswered >= 0 ? firstUnanswered : 0,
        interactions: deck.interactions,
        responses,
        visuals: new Map(),
        preAnsweredIds,
        inputMode: null,
        selectedAction: 0,
        detailExpanded: false,
        scrollOffset: 0,
    };
}
function collectResponses(state) {
    const out = [];
    for (const interaction of state.interactions) {
        const r = state.responses.get(interaction.id);
        if (r !== undefined)
            out.push(r);
    }
    return out;
}
function tryResume(state, progressPath, interactions) {
    try {
        const prior = JSON.parse(readFileSync(progressPath, 'utf8'));
        if (!Array.isArray(prior.responses))
            return;
        const validIds = new Set(interactions.map((i) => i.id));
        for (const r of prior.responses) {
            if (validIds.has(r.id))
                state.responses.set(r.id, r);
        }
        const firstUnanswered = interactions.findIndex((i) => !state.responses.has(i.id));
        state.currentIndex = firstUnanswered >= 0 ? firstUnanswered : 0;
    }
    catch {
        // corrupt or missing progress file — start fresh
    }
}
function atomicWriteProgress(progressPath, responses) {
    const payload = JSON.stringify({ partial: true, responses, savedAt: new Date().toISOString() }, null, 2);
    const tmp = `${progressPath}.tmp`;
    try {
        writeFileSync(tmp, payload);
        renameSync(tmp, progressPath);
    }
    catch {
        // best-effort
    }
}
function rebindPersist(internals) {
    internals.state.persist = () => {
        const responses = collectResponses(internals.state);
        if (internals.progressPath !== undefined)
            atomicWriteProgress(internals.progressPath, responses);
        internals.callbacks.onProgress?.(responses);
    };
}
function fireVisuals(internals, interactions) {
    if (internals.generateVisual === undefined)
        return;
    const gen = internals.generateVisual;
    for (const interaction of interactions) {
        internals.state.visuals.set(interaction.id, { questionId: interaction.id, content: '', status: 'loading' });
        gen(interaction).then((r) => {
            if (!internals.mounted)
                return;
            if (!internals.state.interactions.some((x) => x.id === interaction.id))
                return;
            internals.state.visuals.set(interaction.id, r.ok
                ? { questionId: interaction.id, content: r.ansi, status: 'ready' }
                : { questionId: interaction.id, content: '', status: 'error' });
        }).catch(() => {
            if (!internals.mounted)
                return;
            if (!internals.state.interactions.some((x) => x.id === interaction.id))
                return;
            internals.state.visuals.set(interaction.id, { questionId: interaction.id, content: '', status: 'error' });
        });
    }
}
export function mountPanel(opts) {
    const internals = {
        state: buildInitialState(opts.deck),
        cols: opts.cols,
        rows: opts.rows,
        mounted: true,
        generateVisual: opts.generateVisual,
        progressPath: opts.progressPath,
        callbacks: { onProgress: opts.onProgress, onComplete: opts.onComplete, onExit: opts.onExit },
    };
    assignShortcuts(internals.state.interactions);
    rebindPersist(internals);
    if (internals.progressPath !== undefined) {
        tryResume(internals.state, internals.progressPath, opts.deck.interactions);
    }
    fireVisuals(internals, opts.deck.interactions);
    const renderLines = () => {
        switch (internals.state.phase) {
            case 'overview': return renderOverview(internals.state, internals.cols, internals.rows);
            case 'item-review': return renderItemReview(internals.state, internals.cols, internals.rows);
            case 'final': return renderFinal(internals.state, internals.cols, internals.rows);
        }
    };
    return {
        handleKey(input, key) {
            if (!internals.mounted)
                return;
            const onAutoComplete = () => {
                const responses = collectResponses(internals.state);
                if (internals.progressPath !== undefined) {
                    try {
                        unlinkSync(internals.progressPath);
                    }
                    catch { /* ignore */ }
                }
                internals.callbacks.onComplete?.(responses);
            };
            handleKeypress(input, key, internals.state, () => { }, () => {
                const responses = collectResponses(internals.state);
                if (responses.length >= internals.state.interactions.length) {
                    onAutoComplete();
                }
                else {
                    internals.callbacks.onExit?.();
                }
            });
        },
        render() {
            if (!internals.mounted)
                return [];
            return renderLines();
        },
        handleResize(cols, rows) {
            internals.cols = cols;
            internals.rows = rows;
            return renderLines();
        },
        unmount() {
            internals.mounted = false;
            internals.state.visuals.clear();
            internals.state.persist = undefined;
        },
        loadDeck(deck, loadOpts) {
            if (!internals.mounted)
                return;
            internals.state = buildInitialState(deck);
            if (loadOpts !== undefined && loadOpts.progressPath !== undefined) {
                internals.progressPath = loadOpts.progressPath;
            }
            assignShortcuts(internals.state.interactions);
            rebindPersist(internals);
            if (internals.progressPath !== undefined) {
                tryResume(internals.state, internals.progressPath, deck.interactions);
            }
            fireVisuals(internals, deck.interactions);
        },
        canAcceptHostKeys() {
            if (!internals.mounted)
                return false;
            return internals.state.inputMode === null;
        },
        atDeckTop() {
            if (!internals.mounted)
                return true;
            return internals.state.phase === 'overview' && internals.state.inputMode === null;
        },
    };
}
/**
 * Resolve an interaction directory in place: mount the panel TUI keyed off
 * `<dir>/progress.json`, and on finish (full completion OR human-finished
 * with skips) write `<dir>/response.json` atomically and drop the progress
 * file. A hard process kill leaves `progress.json` for a later resume —
 * `tryResume` (unchanged logic) reads the new dir-derived path.
 *
 * While the panel is mounted, `<dir>/deck.json` is polled for changes (an
 * agent calling `hl deck update`). On a valid rewrite the panel is reloaded
 * in place via `loadDeck`, so the human's pane reflects the new questions
 * without a respawn; answers for surviving interaction ids are kept. The
 * returned `deck` is the one actually answered (post-reload).
 */
export async function resolveInteractionDir(dir, deck, opts = {}) {
    let conversationContext = '';
    if (opts.sessionId !== undefined) {
        try {
            const conv = readConversation(opts.sessionId);
            conversationContext = conv.map((m) => `${m.role}: ${m.content}`).join('\n\n');
        }
        catch {
            // empty context — proceed without visuals context
        }
    }
    setupTerminal();
    const term = getTerminalSize();
    const cols = opts.cols ?? term.cols;
    const rows = opts.rows ?? term.rows;
    const generateVisual = opts.generateVisual ??
        (opts.sessionId !== undefined
            ? (interaction) => defaultGenerateVisual(interaction, conversationContext)
            : undefined);
    return new Promise((resolve) => {
        let panel = null;
        let prevFrameLocal = [];
        let lastResponses = [];
        let onData;
        // The deck the human is actually answering. An agent may replace it
        // mid-flight via `hl deck update` (atomic deck.json rewrite); the poller
        // below reloads the panel in place and tracks the live deck here so the
        // returned envelope/summary describes what was answered, not the kickoff.
        let currentDeck = deck;
        let deckWatch = null;
        const flushHost = (lines) => {
            const { rows: currentRows } = getTerminalSize();
            const { writes, nextPrevFrame } = diffFrame(prevFrameLocal, lines, currentRows);
            process.stdout.write('\x1b[?2026h');
            for (const w of writes)
                process.stdout.write(w);
            process.stdout.write('\x1b[?2026l');
            prevFrameLocal = nextPrevFrame;
        };
        const finalize = (responses) => {
            if (deckWatch !== null) {
                clearInterval(deckWatch);
                deckWatch = null;
            }
            restoreTerminal();
            process.stdin.removeListener('data', onData);
            panel?.unmount();
            const completedAt = new Date().toISOString();
            // Resolved supersedes in-progress: write response.json, drop progress.json.
            const rp = writeResponse(dir, responses, completedAt);
            clearProgress(dir);
            resolve({ responses, completedAt, responsePath: rp, deck: currentDeck });
        };
        panel = mountPanel({
            deck,
            progressPath: progressPathFor(dir),
            cols,
            rows,
            generateVisual,
            onProgress: (responses) => {
                lastResponses = responses;
                if (panel !== null)
                    flushHost(panel.render());
            },
            onComplete: finalize,
            onExit: () => {
                finalize(lastResponses);
            },
        });
        flushHost(panel.render());
        // ── Live deck reload ──────────────────────────────────────────────────
        // Poll deck.json mtime (cheap stat; full read only on change). atomicWrite
        // does write-tmp + rename, so stat/read always see a whole file — no
        // fs.watch rename flakiness. The TUI never writes deck.json, so there is
        // no feedback loop. A structurally identical rewrite is ignored so a
        // no-op touch never disrupts the human mid-answer.
        const deckFile = deckPathFor(dir);
        const deckMtime = () => {
            try {
                return statSync(deckFile).mtimeMs;
            }
            catch {
                return 0;
            }
        };
        let lastDeckMtime = deckMtime();
        let lastDeckJson = JSON.stringify(currentDeck);
        deckWatch = setInterval(() => {
            if (panel === null)
                return;
            const m = deckMtime();
            if (m === 0 || m === lastDeckMtime)
                return;
            lastDeckMtime = m;
            let nextDeck;
            try {
                const parsed = JSON.parse(readFileSync(deckFile, 'utf8'));
                nextDeck = validateDeck(parsed);
            }
            catch {
                // Mid-rename, invalid, or rejected by schema: keep the live deck,
                // retry on the next tick. `hl deck update` validates before writing,
                // so a persistently bad file is an out-of-band edit, not our concern.
                return;
            }
            const nextJson = JSON.stringify(nextDeck);
            if (nextJson === lastDeckJson)
                return; // touch / identical content
            lastDeckJson = nextJson;
            currentDeck = nextDeck;
            panel.loadDeck(nextDeck, { progressPath: progressPathFor(dir) });
            flushHost(panel.render());
        }, 500);
        onData = (data) => {
            const { input: inp, key } = parseKeypress(data);
            panel.handleKey(inp, key);
            flushHost(panel.render());
        };
        process.stdin.on('data', onData);
    });
}
// ── launchTui — file-path entry over the dir resolver (a kept public export
//    per the interaction-layer plan; consumed until consumers move to ask()) ──
export async function launchTui(decisionsPath, sessionId) {
    if (!existsSync(decisionsPath)) {
        throw new Error(`Decisions file not found: ${decisionsPath}`);
    }
    const raw = readFileSync(decisionsPath, 'utf8');
    const deck = validateInput(JSON.parse(raw));
    // The interaction dir is the deck file's directory; progress/response live
    // there per the convention.
    const dir = dirname(resolvePath(decisionsPath));
    const { responses, completedAt } = await resolveInteractionDir(dir, deck, { sessionId });
    return { responses, completedAt };
}
