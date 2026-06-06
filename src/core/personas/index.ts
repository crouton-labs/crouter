/**
 * Persona composer public surface.
 *
 * Re-exports:
 *   - loadPersona / loadKernel / availableKinds / kindWhenToUse / subPersonasFor
 *                                (loader — raw file access)
 *   - resolve                    (high-level composer)
 *   - ResolvedPersona            (return type of resolve)
 */

export { loadPersona, loadKernel, availableKinds, kindWhenToUse, subPersonasFor, loadLifecycleFragment, loadSpineFragment } from './loader.js';
export type { LoadedPersona, SubPersona } from './loader.js';
export { resolve } from './resolve.js';
export type { ResolvedPersona } from './resolve.js';
