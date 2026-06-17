/**
 * Persona composer public surface.
 *
 * Re-exports:
 *   - loadPersona / loadKernel / availableKinds / kindWhenToUse / subPersonasFor
 *                                (loader — raw file access)
 *   - resolve                    (high-level composer)
 *   - ResolvedPersona            (return type of resolve)
 */

export {
  loadPersona,
  loadPersonaSource,
  loadKernel,
  loadKernelSource,
  availableKinds,
  kindWhenToUse,
  subPersonasFor,
  loadLifecycleFragment,
  loadLifecycleFragmentSource,
  loadSpineFragment,
  loadSpineFragmentSource,
  loadRuntimeBase,
  loadRuntimeBaseSource,
  loadWaitingFragment,
  loadWaitingFragmentSource,
  loadScopedText,
} from './loader.js';
export type { LoadedPersona, LoadedPersonaSource, SubPersona } from './loader.js';
export { resolve, resolveLayers, resolvePromptReview } from './resolve.js';
export type { ResolvedPersona, PromptReviewData, PromptReviewConfig, PromptLayer, PromptSource } from './resolve.js';
