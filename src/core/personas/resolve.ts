/**
 * Persona resolver — composes base + orchestrator personas into a
 * ResolvedPersona ready for use when spawning a canvas node.
 *
 * Composition rules:
 *   mode==='base'
 *     → load <kind>/PERSONA.md; if missing fall back to general defaults.
 *
 *   mode==='orchestrator'
 *     → prefer <kind>/orchestrator.md (which must embed the kernel via
 *       @include orchestration-kernel.md — inlined by the loader).
 *       If no orchestrator.md exists for this kind, compose:
 *         <kind>/PERSONA.md body  +  '\n\n'  +  kernel body
 *       If even the PERSONA.md is missing, fall back to general defaults + kernel.
 *
 * Frontmatter from whichever file is the primary source (orchestrator.md >
 * PERSONA.md) supplies model/skills/extensions/tools. Lifecycle and spine position
 * are INPUTS (the caller decides them — root/child, terminal/resident), not
 * derived here; they select the lifecycle/spine protocol fragments spliced
 * ahead of the persona body.
 */

import { loadPersona, loadKernel, loadRuntimeBase, loadSpineFragment, loadLifecycleFragment, loadWaitingFragment, subPersonasFor } from './loader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedPersona {
  systemPrompt: string;
  extensions: string[];
  skills: string[];
  model?: string;
  lifecycle: 'terminal' | 'resident';
  tools?: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function toOptionalString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** The bare-minimum system prompt used when no persona file is found at all. */
function fallbackBasePrompt(kind: string): string {
  return `You are a ${kind} agent. Complete the task you have been given.`;
}

/** Compose the runtime protocol that precedes every persona body: the
 *  lifecycle-neutral base (identity/delegate/ask/promote), then the spine
 *  fragment (report-up vs. silent, keyed on whether the node has a manager),
 *  then the lifecycle fragment (finish-with-`push final` vs. dormant/wake). The
 *  kind×mode persona body follows after a rule. Empty fragments drop out. */
/** Render the "sub-personas you may spawn" menu for a kind that has any
 *  available to it. Returns '' when none are. Data-driven: one line per
 *  sub-persona, its spawn string + its `whenToUse`. A sub-persona surfaces here
 *  for a kind when its `availableTo` includes that kind (default: its own
 *  top-level ancestor) or is the wildcard. */
function renderSubPersonaMenu(kind: string): string {
  const subs = subPersonasFor(kind);
  if (subs.length === 0) return '';
  const lines = subs.map((s) => `- \`${s.kind}\` — ${s.whenToUse}`);
  return [
    '## Sub-personas you may spawn',
    '',
    `These specialist sub-personas are available to the ${kind} kind. Spawn one with \`crtr node new --kind <sub> "<scope>"\`, giving it only its scope, never your suspicions: a reviewer handed a hint anchors on it instead of finding problems independently.`,
    '',
    ...lines,
  ].join('\n');
}

function composeProtocol(
  personaPrompt: string,
  kind: string,
  lifecycle: 'terminal' | 'resident',
  hasManager: boolean,
): string {
  const menu = renderSubPersonaMenu(kind);
  const body = menu ? `${personaPrompt}\n\n${menu}` : personaPrompt;
  const protocol = [
    loadRuntimeBase(),
    loadSpineFragment(hasManager),
    loadLifecycleFragment(lifecycle),
    loadWaitingFragment(),
  ]
    .filter((s) => s.length > 0)
    .join('\n\n');
  return protocol ? `${protocol}\n\n---\n\n${body}` : body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a fully composed persona for the given `kind` and `mode`.
 *
 * Never throws for missing files — missing personas produce sensible defaults.
 */
export interface ResolveOpts {
  /** The node's lifecycle axis — selects the "how you end" fragment. */
  lifecycle: 'terminal' | 'resident';
  /** Whether the node reports up to a manager (parent !== null) — selects the
   *  spine fragment (`has-manager` teaches the push family; `no-manager` omits
   *  it entirely). */
  hasManager: boolean;
}

export function resolve(
  kind: string,
  mode: 'base' | 'orchestrator',
  opts: ResolveOpts,
): ResolvedPersona {
  if (mode === 'base') {
    const persona = loadPersona(kind, 'base');

    if (!persona) {
      // No persona file for this kind — use minimal defaults.
      return {
        systemPrompt: composeProtocol(fallbackBasePrompt(kind), kind, opts.lifecycle, opts.hasManager),
        extensions: [],
        skills: [],
        lifecycle: opts.lifecycle,
      };
    }

    const fm = persona.frontmatter ?? {};
    return {
      systemPrompt: composeProtocol(persona.body || fallbackBasePrompt(kind), kind, opts.lifecycle, opts.hasManager),
      extensions: toStringArray(fm['extensions']),
      skills: toStringArray(fm['skills']),
      model: toOptionalString(fm['model']),
      lifecycle: opts.lifecycle,
      tools: fm['tools'] !== undefined ? toStringArray(fm['tools']) : undefined,
    };
  }

  // mode === 'orchestrator'
  const orchestratorPersona = loadPersona(kind, 'orchestrator');

  if (orchestratorPersona) {
    // Orchestrator file exists; @include was already inlined by the loader.
    const fm = orchestratorPersona.frontmatter ?? {};
    return {
      systemPrompt: composeProtocol(orchestratorPersona.body || fallbackBasePrompt(kind), kind, opts.lifecycle, opts.hasManager),
      extensions: toStringArray(fm['extensions']),
      skills: toStringArray(fm['skills']),
      model: toOptionalString(fm['model']),
      lifecycle: opts.lifecycle,
      tools: fm['tools'] !== undefined ? toStringArray(fm['tools']) : undefined,
    };
  }

  // No orchestrator.md for this kind — compose base + bare kernel.
  const kernel = loadKernel();
  const basePersona = loadPersona(kind, 'base');

  const baseBody = basePersona?.body || fallbackBasePrompt(kind);
  const fm = basePersona?.frontmatter ?? {};

  // Append the kernel to the base body (with separator if kernel is non-empty).
  const systemPrompt = kernel ? `${baseBody}\n\n${kernel}` : baseBody;

  return {
    systemPrompt: composeProtocol(systemPrompt, kind, opts.lifecycle, opts.hasManager),
    extensions: toStringArray(fm['extensions']),
    skills: toStringArray(fm['skills']),
    model: toOptionalString(fm['model']),
    lifecycle: opts.lifecycle,
    tools: fm['tools'] !== undefined ? toStringArray(fm['tools']) : undefined,
  };
}
