/**
 * Persona resolver — composes base + orchestrator personas into a
 * ResolvedPersona ready for use when spawning a canvas node.
 */

import { getNode } from '../canvas/index.js';
import { renderKnowledgeBlock, renderMemoryGuidance, renderPreferencesSection } from '../substrate/render.js';
import {
  loadPersona,
  loadPersonaSource,
  loadKernelSource,
  loadRuntimeBaseSource,
  loadSpineFragmentSource,
  loadLifecycleFragmentSource,
  loadWaitingFragmentSource,
  loadScopedText,
  subPersonasFor,
  type LoadedPersonaSource,
} from './loader.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResolvedPersona {
  systemPrompt: string;
  extensions: string[];
  model?: string;
  lifecycle: 'terminal' | 'resident';
  tools?: string[];
}

export type PromptLayerGroup = 'protocol' | 'persona' | 'generated' | 'substrate';
export type PromptLayerScope = 'project' | 'user' | 'builtin' | 'generated' | 'runtime';

export interface PromptLayer {
  id: string;
  label: string;
  group: PromptLayerGroup;
  source: string;
  sourcePath: string | null;
  scope: PromptLayerScope;
  included: boolean;
  condition: string | null;
  text: string;
  tokens: number;
  chars: number;
}

export interface PromptSource {
  id: string;
  label: string;
  path: string;
  scope: Exclude<PromptLayerScope, 'generated' | 'runtime'>;
}

export interface PromptReviewConfig {
  kind: string;
  mode: 'base' | 'orchestrator';
  lifecycle: 'terminal' | 'resident';
  hasManager: boolean;
  node: string | null;
}

export interface PromptReviewData {
  config: PromptReviewConfig;
  layers: PromptLayer[];
  assembled: string;
  total: { tokens: number; chars: number };
  sources: PromptSource[];
}

export interface ResolveOpts {
  lifecycle: 'terminal' | 'resident';
  hasManager: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => x != null && typeof x !== 'object').map((x) => String(x));
}

function toOptionalString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function fallbackBasePrompt(kind: string): string {
  return `You are a ${kind} agent. Complete the task you have been given.`;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function makeLayer(part: Omit<PromptLayer, 'tokens' | 'chars'>): PromptLayer {
  return {
    ...part,
    chars: part.text.length,
    tokens: approxTokens(part.text),
  };
}

function trimBlock(text: string): string {
  return text.trim();
}


function includeTargets(rawBody: string): string[] {
  const targets: string[] = [];
  const re = /^@include\s+(\S+)\s*$/gm;
  for (const match of rawBody.matchAll(re)) {
    targets.push(match[1]!);
  }
  return targets;
}

function addSource(list: PromptSource[], seen: Set<string>, source: PromptSource | null): void {
  if (source === null) return;
  const key = `${source.scope}:${source.path}`;
  if (seen.has(key)) return;
  seen.add(key);
  list.push(source);
}

function resolveSourceRef(path: string, label: string): PromptSource | null {
  const loaded = loadScopedText(path);
  if (!loaded) return null;
  return { id: label, label, path: loaded.sourcePath, scope: loaded.scope };
}

function collectPersonaSources(primary: LoadedPersonaSource | null, fallbackLabel: string): PromptSource[] {
  const sources: PromptSource[] = [];
  const seen = new Set<string>();
  if (primary !== null) {
    addSource(sources, seen, {
      id: fallbackLabel,
      label: fallbackLabel,
      path: primary.sourcePath,
      scope: primary.scope,
    });
    for (const target of includeTargets(primary.rawBody)) {
      addSource(sources, seen, resolveSourceRef(target, `included: ${target}`));
    }
  }
  return sources;
}

function basePersonaLayer(kind: string, mode: 'base' | 'orchestrator'): { layer: PromptLayer; sources: PromptSource[] } {
  const source = loadPersonaSource(kind, mode);
  if (source !== null) {
    const label = mode === 'base' ? 'Persona body' : 'Orchestrator body';
    return {
      layer: makeLayer({
        id: 'persona-body',
        label,
        group: 'persona',
        source: source.source,
        sourcePath: source.sourcePath,
        scope: source.scope,
        included: true,
        condition: null,
        text: source.body || fallbackBasePrompt(kind),
      }),
      sources: collectPersonaSources(source, label),
    };
  }

  if (mode === 'orchestrator') {
    const base = loadPersonaSource(kind, 'base');
    const kernel = loadKernelSource();
    const body = `${base?.body || fallbackBasePrompt(kind)}${kernel ? `\n\n${kernel.text}` : ''}`;
    const layer = makeLayer({
      id: 'persona-body',
      label: 'Orchestrator body',
      group: 'persona',
      source: base?.sourcePath !== undefined ? base.source : 'generated: base persona + kernel',
      sourcePath: base?.sourcePath ?? null,
      scope: base?.scope ?? 'generated',
      included: true,
      condition: null,
      text: body,
    });
    const sources: PromptSource[] = [];
    const seen = new Set<string>();
    if (base !== null) {
      addSource(sources, seen, { id: 'persona-body', label: 'Persona body', path: base.sourcePath, scope: base.scope });
      for (const target of includeTargets(base.rawBody)) {
        addSource(sources, seen, resolveSourceRef(target, `included: ${target}`));
      }
    }
    if (kernel !== null) {
      addSource(sources, seen, { id: 'kernel', label: 'Kernel', path: kernel.sourcePath, scope: kernel.scope });
    }
    return { layer, sources };
  }

  const layer = makeLayer({
    id: 'persona-body',
    label: 'Persona body',
    group: 'persona',
    source: 'generated: fallback persona',
    sourcePath: null,
    scope: 'generated',
    included: true,
    condition: null,
    text: fallbackBasePrompt(kind),
  });
  return { layer, sources: [] };
}

function protocolLayers(lifecycle: 'terminal' | 'resident', hasManager: boolean): PromptLayer[] {
  const runtime = loadRuntimeBaseSource();
  const wait = loadWaitingFragmentSource();
  const spineHas = loadSpineFragmentSource(true);
  const spineNo = loadSpineFragmentSource(false);
  const lifecycleTerminal = loadLifecycleFragmentSource('terminal');
  const lifecycleResident = loadLifecycleFragmentSource('resident');

  return [
    makeLayer({
      id: 'runtime-base',
      label: 'Runtime base',
      group: 'protocol',
      source: 'personas/runtime-base.md',
      sourcePath: runtime?.sourcePath ?? null,
      scope: runtime?.scope ?? 'generated',
      included: true,
      condition: null,
      text: trimBlock(runtime?.text ?? ''),
    }),
    makeLayer({
      id: 'spine-has-manager',
      label: 'Has manager',
      group: 'protocol',
      source: 'personas/spine/has-manager.md',
      sourcePath: spineHas?.sourcePath ?? null,
      scope: spineHas?.scope ?? 'generated',
      included: hasManager,
      condition: hasManager ? null : 'hasManager == false',
      text: trimBlock(spineHas?.text ?? ''),
    }),
    makeLayer({
      id: 'spine-no-manager',
      label: 'No manager',
      group: 'protocol',
      source: 'personas/spine/no-manager.md',
      sourcePath: spineNo?.sourcePath ?? null,
      scope: spineNo?.scope ?? 'generated',
      included: !hasManager,
      condition: hasManager ? 'hasManager == true' : null,
      text: trimBlock(spineNo?.text ?? ''),
    }),
    makeLayer({
      id: 'lifecycle-terminal',
      label: 'Terminal lifecycle',
      group: 'protocol',
      source: 'personas/lifecycle/terminal.md',
      sourcePath: lifecycleTerminal?.sourcePath ?? null,
      scope: lifecycleTerminal?.scope ?? 'generated',
      included: lifecycle === 'terminal',
      condition: lifecycle === 'terminal' ? null : 'lifecycle == resident',
      text: trimBlock(lifecycleTerminal?.text ?? ''),
    }),
    makeLayer({
      id: 'lifecycle-resident',
      label: 'Resident lifecycle',
      group: 'protocol',
      source: 'personas/lifecycle/resident.md',
      sourcePath: lifecycleResident?.sourcePath ?? null,
      scope: lifecycleResident?.scope ?? 'generated',
      included: lifecycle === 'resident',
      condition: lifecycle === 'resident' ? null : 'lifecycle == terminal',
      text: trimBlock(lifecycleResident?.text ?? ''),
    }),
    makeLayer({
      id: 'waiting',
      label: 'Waiting',
      group: 'protocol',
      source: 'personas/waiting.md',
      sourcePath: wait?.sourcePath ?? null,
      scope: wait?.scope ?? 'generated',
      included: true,
      condition: null,
      text: trimBlock(wait?.text ?? ''),
    }),
    makeLayer({
      id: 'separator',
      label: 'Separator',
      group: 'protocol',
      source: 'generated: separator',
      sourcePath: null,
      scope: 'generated',
      included: true,
      condition: null,
      text: '---',
    }),
  ];
}

function renderSubPersonaMenu(kind: string): { layer: PromptLayer | null; sources: PromptSource[] } {
  const subs = subPersonasFor(kind);
  if (subs.length === 0) return { layer: null, sources: [] };

  const lines: string[] = [
    '## Sub-personas you may spawn',
    '',
    `These specialist sub-personas are available to the ${kind} kind. Spawn one with \`crtr node new --kind <sub> "<scope>"\`, and treat it as its own scope instead of dragging unrelated context into it.`,
    '',
  ];
  const sources: PromptSource[] = [];
  const seen = new Set<string>();
  for (const sub of subs) {
    const src = loadPersonaSource(sub.kind, 'base');
    if (src !== null) {
      addSource(sources, seen, { id: sub.kind, label: sub.kind, path: src.sourcePath, scope: src.scope });
      lines.push(`- \`${sub.kind}\` — ${sub.whenToUse} (${src.sourcePath})`);
    } else {
      lines.push(`- \`${sub.kind}\` — ${sub.whenToUse}`);
    }
  }
  return {
    layer: makeLayer({
      id: 'subpersona-menu',
      label: 'Sub-persona menu',
      group: 'generated',
      source: 'generated: sub-persona menu',
      sourcePath: null,
      scope: 'generated',
      included: true,
      condition: null,
      text: lines.join('\n'),
    }),
    sources,
  };
}

function coreLayers(kind: string, mode: 'base' | 'orchestrator', opts: ResolveOpts): { layers: PromptLayer[]; sources: PromptSource[] } {
  const protocol = protocolLayers(opts.lifecycle, opts.hasManager);
  const body = basePersonaLayer(kind, mode);
  const menu = renderSubPersonaMenu(kind);
  const layers: PromptLayer[] = [...protocol, body.layer];
  if (menu.layer !== null) layers.push(menu.layer);

  const sources: PromptSource[] = [];
  const seen = new Set<string>();
  for (const layer of protocol) {
    if (layer.sourcePath === null) continue;
    addSource(sources, seen, { id: layer.id, label: layer.label, path: layer.sourcePath, scope: layer.scope as PromptSource['scope'] });
  }
  for (const source of body.sources) addSource(sources, seen, source);
  for (const source of menu.sources) addSource(sources, seen, source);
  return { layers, sources };
}

function joinIncluded(layers: PromptLayer[]): string {
  return layers.filter((layer) => layer.included && layer.text.length > 0).map((layer) => layer.text).join('\n\n');
}

function spliceRuntimeSubstrate(systemPrompt: string, nodeId: string): { prompt: string; layers: PromptLayer[] } {
  const pref = renderPreferencesSection(nodeId).trim();
  const guidance = renderMemoryGuidance().trim();
  const blocks: string[] = [];
  const layers: PromptLayer[] = [];
  if (pref !== '') {
    const text = pref;
    blocks.push(text);
    layers.push(makeLayer({
      id: 'preferences',
      label: 'Preferences',
      group: 'substrate',
      source: 'runtime-spliced',
      sourcePath: null,
      scope: 'runtime',
      included: true,
      condition: null,
      text,
    }));
  }
  if (guidance !== '') {
    blocks.push(guidance);
    layers.push(makeLayer({
      id: 'memory-guidance',
      label: 'Memory guidance',
      group: 'substrate',
      source: 'runtime-spliced',
      sourcePath: null,
      scope: 'runtime',
      included: true,
      condition: null,
      text: guidance,
    }));
  }
  const knowledge = renderKnowledgeBlock(nodeId).trim();
  if (knowledge !== '') {
    layers.push(makeLayer({
      id: 'knowledge',
      label: 'Context message — not system prompt',
      group: 'substrate',
      source: 'runtime-spliced',
      sourcePath: null,
      scope: 'runtime',
      included: false,
      condition: 'session_start context message, not the system prompt',
      text: knowledge,
    }));
  }
  if (blocks.length === 0) return { prompt: systemPrompt, layers };
  const insert = blocks.join('\n\n');
  const anchor = '\n\nGuidelines:';
  const idx = systemPrompt.indexOf(anchor);
  if (idx === -1) return { prompt: `${systemPrompt}\n\n${insert}`, layers };
  return { prompt: `${systemPrompt.slice(0, idx)}\n\n${insert}${systemPrompt.slice(idx)}`, layers };
}

function collectLayers(kind: string, mode: 'base' | 'orchestrator', opts: ResolveOpts, nodeId?: string): PromptReviewData {
  const core = coreLayers(kind, mode, opts);
  const assembledCore = joinIncluded(core.layers);
  const node = nodeId !== undefined ? getNode(nodeId) : null;
  const config: PromptReviewConfig = {
    kind,
    mode,
    lifecycle: opts.lifecycle,
    hasManager: opts.hasManager,
    node: node !== null ? node.node_id : null,
  };
  const substrate = node !== null ? spliceRuntimeSubstrate(assembledCore, node.node_id) : { prompt: assembledCore, layers: [] };
  const layers = [...core.layers, ...substrate.layers];
  const sources: PromptSource[] = [];
  const seen = new Set<string>();
  for (const source of core.sources) addSource(sources, seen, source);
  const included = layers.filter((layer) => layer.included).reduce(
    (acc, layer) => ({ tokens: acc.tokens + layer.tokens, chars: acc.chars + layer.chars }),
    { tokens: 0, chars: 0 },
  );
  return {
    config,
    layers,
    assembled: substrate.prompt,
    total: included,
    sources,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve a fully composed persona for the given `kind` and `mode`.
 */
export function resolve(kind: string, mode: 'base' | 'orchestrator', opts: ResolveOpts): ResolvedPersona {
  const persona = mode === 'base' ? loadPersona(kind, 'base') : loadPersona(kind, 'orchestrator') ?? loadPersona(kind, 'base');
  const fm = persona?.frontmatter ?? {};
  const systemPrompt = joinIncluded(coreLayers(kind, mode, opts).layers);
  return {
    systemPrompt,
    extensions: toStringArray(fm['extensions']),
    model: toOptionalString(fm['model']),
    lifecycle: opts.lifecycle,
    tools: fm['tools'] !== undefined ? toStringArray(fm['tools']) : undefined,
  };
}

export function resolveLayers(kind: string, mode: 'base' | 'orchestrator', opts: ResolveOpts): PromptLayer[] {
  return coreLayers(kind, mode, opts).layers;
}

export function resolvePromptReview(
  kind: string,
  mode: 'base' | 'orchestrator',
  opts: ResolveOpts,
  nodeId?: string,
): PromptReviewData {
  return collectLayers(kind, mode, opts, nodeId);
}
