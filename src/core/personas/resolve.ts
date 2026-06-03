/**
 * Persona resolver — composes base + orchestrator personas into a
 * ResolvedPersona ready for use when spawning a canvas node.
 *
 * Composition rules:
 *   mode==='base'
 *     → load <kind>/base.md; if missing fall back to general defaults.
 *
 *   mode==='orchestrator'
 *     → prefer <kind>/orchestrator.md (which must embed the kernel via
 *       @include orchestration-kernel.md — inlined by the loader).
 *       If no orchestrator.md exists for this kind, compose:
 *         <kind>/base.md body  +  '\n\n'  +  kernel body
 *       If even the base is missing, fall back to general defaults + kernel.
 *
 * Frontmatter from whichever file is the primary source (orchestrator.md >
 * base.md) supplies model/lifecycle/skills/extensions/tools.
 *
 * Lifecycle defaults:
 *   base         → 'terminal'
 *   orchestrator → 'resident'
 */

import { loadPersona, loadKernel, loadRuntimeBase } from './loader.js';

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

function toLifecycle(v: unknown, defaultValue: 'terminal' | 'resident'): 'terminal' | 'resident' {
  if (v === 'terminal' || v === 'resident') return v;
  return defaultValue;
}

/** The bare-minimum system prompt used when no persona file is found at all. */
function fallbackBasePrompt(kind: string): string {
  return `You are a ${kind} agent. Complete the task you have been given.`;
}

/** Prepend the base runtime protocol (push/finish/delegate/feed/ask) to a
 *  persona's prompt — every node, every kind, every mode gets it first. */
function withBase(personaPrompt: string): string {
  const base = loadRuntimeBase();
  return base ? `${base}\n\n---\n\n${personaPrompt}` : personaPrompt;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a fully composed persona for the given `kind` and `mode`.
 *
 * Never throws for missing files — missing personas produce sensible defaults.
 */
export function resolve(kind: string, mode: 'base' | 'orchestrator'): ResolvedPersona {
  if (mode === 'base') {
    const persona = loadPersona(kind, 'base');

    if (!persona) {
      // No persona file for this kind — use minimal defaults.
      return {
        systemPrompt: withBase(fallbackBasePrompt(kind)),
        extensions: [],
        skills: [],
        lifecycle: 'terminal',
      };
    }

    const fm = persona.frontmatter ?? {};
    return {
      systemPrompt: withBase(persona.body || fallbackBasePrompt(kind)),
      extensions: toStringArray(fm['extensions']),
      skills: toStringArray(fm['skills']),
      model: toOptionalString(fm['model']),
      lifecycle: toLifecycle(fm['lifecycle'], 'terminal'),
      tools: fm['tools'] !== undefined ? toStringArray(fm['tools']) : undefined,
    };
  }

  // mode === 'orchestrator'
  const orchestratorPersona = loadPersona(kind, 'orchestrator');

  if (orchestratorPersona) {
    // Orchestrator file exists; @include was already inlined by the loader.
    const fm = orchestratorPersona.frontmatter ?? {};
    return {
      systemPrompt: withBase(orchestratorPersona.body || fallbackBasePrompt(kind)),
      extensions: toStringArray(fm['extensions']),
      skills: toStringArray(fm['skills']),
      model: toOptionalString(fm['model']),
      lifecycle: toLifecycle(fm['lifecycle'], 'resident'),
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
    systemPrompt: withBase(systemPrompt),
    extensions: toStringArray(fm['extensions']),
    skills: toStringArray(fm['skills']),
    model: toOptionalString(fm['model']),
    // Override lifecycle to 'resident' — this node is being used as an orchestrator.
    lifecycle: 'resident',
    tools: fm['tools'] !== undefined ? toStringArray(fm['tools']) : undefined,
  };
}
