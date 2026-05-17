import { existsSync, statSync, writeFileSync, renameSync, readFileSync, unlinkSync, mkdirSync } from 'fs';
import { dirname } from 'path';
// ── Path helpers ──────────────────────────────────────────────────────────────
export function deckPath(dir) {
    return `${dir}/deck.json`;
}
export function responsePath(dir) {
    return `${dir}/response.json`;
}
export function progressPath(dir) {
    return `${dir}/progress.json`;
}
export function visualsDir(dir) {
    return `${dir}/visuals`;
}
export function visualMdPath(dir, id) {
    return `${dir}/visuals/${id}.md`;
}
export function visualAnsiPath(dir, id) {
    return `${dir}/visuals/${id}.ansi`;
}
export function interactionState(dir) {
    const hasDeck = existsSync(deckPath(dir));
    const hasResponse = existsSync(responsePath(dir));
    const hasProgress = existsSync(progressPath(dir));
    if (!hasDeck)
        return 'missing';
    if (hasResponse)
        return 'resolved';
    if (hasProgress)
        return 'in-progress';
    return 'pending';
}
export function isResolved(dir) {
    return existsSync(responsePath(dir));
}
/** Returns true if a live resolver owns this dir (progress.json mtime < 300s). */
export function isClaimed(dir) {
    const p = progressPath(dir);
    if (!existsSync(p))
        return false;
    try {
        const { mtimeMs } = statSync(p);
        return Date.now() - mtimeMs < 300_000;
    }
    catch {
        return false;
    }
}
// ── Atomic I/O ────────────────────────────────────────────────────────────────
export function atomicWriteJson(path, value) {
    const payload = JSON.stringify(value, null, 2);
    const tmp = `${path}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmp, payload);
    renameSync(tmp, path);
}
export function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return null;
    }
}
// ── High-level write helpers ──────────────────────────────────────────────────
export function writeResponse(dir, responses, completedAt) {
    const p = responsePath(dir);
    atomicWriteJson(p, { responses, completedAt });
    return p;
}
export function writeProgress(dir, responses) {
    atomicWriteJson(progressPath(dir), {
        partial: true,
        responses,
        savedAt: new Date().toISOString(),
    });
}
export function clearProgress(dir) {
    try {
        unlinkSync(progressPath(dir));
    }
    catch (err) {
        if (err.code !== 'ENOENT')
            throw err;
    }
}
