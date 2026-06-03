/**
 * Persona composer public surface.
 *
 * Re-exports:
 *   - loadPersona / loadKernel   (loader — raw file access)
 *   - resolve                    (high-level composer)
 *   - ResolvedPersona            (return type of resolve)
 */

export { loadPersona, loadKernel } from './loader.js';
export type { LoadedPersona } from './loader.js';
export { resolve } from './resolve.js';
export type { ResolvedPersona } from './resolve.js';
