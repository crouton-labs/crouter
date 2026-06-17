// @ts-check
/**
 * Prompt Studio — portable core for the `prompt-review` builtin view.
 *
 * Core rule: imports NOTHING. All state + behavior live here; presenters are
 * pure reads that emit named intents.
 *
 * @module prompt-review/core
 */

/** @typedef {import('../../core/view/contract.js').SourceError} SourceError */
/** @typedef {import('../../core/view/contract.js').IntentCtx<PromptReviewState>} Ctx */

const DEFAULT_KIND = 'developer';
const DEFAULT_MODE = 'base';
const DEFAULT_LIFECYCLE = 'terminal';
const DEFAULT_HAS_MANAGER = true;
const DEFAULT_BUDGET = 200_000;

/** @template T @param {T} data @returns {{ok:true, data:T}} */
function ok(data) { return { ok: true, data }; }
/** @param {SourceError} error @returns {{ok:false, error:SourceError}} */
function fail(error) { return { ok: false, error }; }
/** @param {unknown} v @returns {string} */
function str(v) { return v == null ? '' : String(v); }
/** @param {unknown} v @returns {boolean} */
function bool(v) { return v === true || v === 'true' || v === 1 || v === '1'; }
/** @param {number} n @returns {number} */
function approxTokens(n) { return Math.ceil(Math.max(0, n) / 4); }
/** @param {string} s @returns {string} */
function firstLine(s) { return str(s).split(/\r?\n/).map((l) => l.trim()).find(Boolean) || ''; }
/** @param {string} msg @param {SourceError['display']['level']} [level='error'] @returns {SourceError} */
function studioError(msg, level = 'error') {
  return {
    kind: 'prompt-review',
    display: {
      headline: 'Prompt Studio unavailable',
      explanation: msg,
      nextStep: 'Press g to retry.',
      level,
      blocking: level === 'error',
    },
  };
}
/** @param {string} bin @param {string[]} args @param {string} [stdin] @returns {import('../../core/view/contract.js').SourceRequest} */
function execRequest(bin, args, stdin) {
  const req = { kind: 'exec', bin, args };
  return stdin === undefined ? req : { ...req, stdin };
}

/** @typedef {'protocol'|'persona'|'generated'|'substrate'} LayerGroup */
/** @typedef {'project'|'user'|'builtin'|'generated'|'runtime'} LayerScope */

/**
 * @typedef {Object} PromptReviewConfig
 * @property {string} kind
 * @property {'base'|'orchestrator'} mode
 * @property {'terminal'|'resident'} lifecycle
 * @property {boolean} hasManager
 * @property {string|null} node
 */

/**
 * @typedef {Object} PromptLayer
 * @property {string} id
 * @property {string} label
 * @property {LayerGroup} group
 * @property {string} source
 * @property {string|null} sourcePath
 * @property {LayerScope} scope
 * @property {boolean} included
 * @property {string|null} condition
 * @property {string} text
 * @property {number} tokens
 * @property {number} chars
 */

/**
 * @typedef {Object} PromptSource
 * @property {string} id
 * @property {string} label
 * @property {string} path
 * @property {LayerScope} scope
 */

/** @typedef {{kind:string, whenToUse:string}} KindInfo */

/**
 * @typedef {Object} PromptReviewList
 * @property {KindInfo[]} kinds
 * @property {Array<'base'|'orchestrator'>} modes
 * @property {Array<'terminal'|'resident'>} lifecycles
 * @property {Record<string, KindInfo[]>} subPersonas
 */

/**
 * @typedef {Object} ReviewState
 * @property {PromptReviewConfig} config
 * @property {PromptReviewConfig|null} compareConfig
 * @property {{kinds: KindInfo[], modes: Array<'base'|'orchestrator'>, lifecycles: Array<'terminal'|'resident'>, subPersonas: Record<string, KindInfo[]>} | null} list
 * @property {Array<{node_id:string, name:string, kind:string, mode:string, lifecycle:string, status:string, cwd:string, parent:string|null, created:string, enterable:boolean}>} liveNodes
 * @property {PromptLayer[]|null} review
 * @property {PromptLayer[]|null} compareReview
 * @property {PromptSource[]} sources
 * @property {number} totalTokens
 * @property {number} totalChars
 * @property {string|null} assembled
 * @property {string|null} compareAssembled
 * @property {string|null} selectedLayerId
 * @property {number} cursor
 * @property {number} scroll
 * @property {string|null} compareSelectedLayerId
 * @property {number} compareCursor
 * @property {Record<string, boolean>} expanded
 * @property {'layered'|'raw'} viewMode
 * @property {Array<{layerId:string,label:string,sourcePath:string|null,scope:LayerScope,anchor:string|null,body:string}>} comments
 * @property {{layerId:string,label:string,sourcePath:string|null,scope:LayerScope,anchor:string|null,body:string}|null} draftComment
 * @property {string} rawSelection
 * @property {string|null} lastExportPath
 * @property {boolean} compareOpen
 * @property {number} lastFetch
 * @property {SourceError|null} sourceError
 * @property {SourceError|null} auxiliaryError
 */

/** @param {PromptReviewConfig} config @returns {string} */
function configKey(config) {
  return [config.kind, config.mode, config.lifecycle, config.hasManager ? '1' : '0', config.node || '-'].join('|');
}

/** @param {PromptReviewConfig} config @returns {PromptReviewConfig} */
function cloneConfig(config) {
  return { kind: config.kind, mode: config.mode, lifecycle: config.lifecycle, hasManager: config.hasManager, node: config.node };
}

/** @param {PromptReviewConfig} config @returns {PromptReviewConfig} */
function makeDefaultCompare(config) {
  return {
    kind: config.kind,
    mode: config.mode === 'base' ? 'orchestrator' : 'base',
    lifecycle: config.lifecycle === 'terminal' ? 'resident' : 'terminal',
    hasManager: config.hasManager,
    node: config.node,
  };
}

/** @param {PromptReviewConfig} config @returns {PromptReviewConfig} */
function normalizeConfig(config) {
  return {
    kind: str(config.kind) || DEFAULT_KIND,
    mode: config.mode === 'orchestrator' ? 'orchestrator' : 'base',
    lifecycle: config.lifecycle === 'resident' ? 'resident' : 'terminal',
    hasManager: bool(config.hasManager),
    node: config.node ? str(config.node) : null,
  };
}

/** @param {PromptLayer[]} layers @returns {PromptSource[]} */
function dedupeSources(layers) {
  /** @type {PromptSource[]} */
  const out = [];
  const seen = new Set();
  for (const layer of layers) {
    if (!layer.sourcePath || seen.has(layer.sourcePath)) continue;
    seen.add(layer.sourcePath);
    out.push({ id: layer.id, label: layer.label, path: layer.sourcePath, scope: layer.scope });
  }
  return out;
}

/** @param {string} s @returns {string} */
function normalizeText(s) {
  return str(s).replace(/\r\n/g, '\n');
}

/** @param {string[]} pieces @returns {string} */
function joinPieces(pieces) {
  return pieces.filter((p) => p != null && p !== '').join('\n\n');
}

/** @param {string} text @returns {number} */
function chars(text) { return normalizeText(text).length; }

/** @param {string} text @returns {number} */
function tokens(text) { return approxTokens(chars(text)); }

/** @param {string} id @param {string} label @param {LayerGroup} group @param {string} source @param {string|null} sourcePath @param {LayerScope} scope @param {boolean} included @param {string|null} condition @param {string} text @returns {PromptLayer} */
function makeLayer(id, label, group, source, sourcePath, scope, included, condition, text) {
  const norm = normalizeText(text);
  return { id, label, group, source, sourcePath, scope, included, condition, text: norm, tokens: tokens(norm), chars: chars(norm) };
}

/** @param {string} kind @returns {string} */
function kindLabel(kind) { return kind || DEFAULT_KIND; }

/** @param {PromptReviewConfig} config @returns {string} */
function configHeadline(config) {
  return `${config.kind}/${config.mode} · ${config.lifecycle} · manager:${config.hasManager ? 'yes' : 'no'}${config.node ? ` · node:${config.node}` : ''}`;
}

/** @param {string} id @returns {string} */
function layerLabel(id) {
  const map = {
    'runtime-base': 'Runtime base',
    'spine-has-manager': 'Spine (has manager)',
    'spine-no-manager': 'Spine (no manager)',
    'lifecycle-terminal': 'Lifecycle (terminal)',
    'lifecycle-resident': 'Lifecycle (resident)',
    'waiting': 'Waiting',
    'persona-body': 'Persona body',
    'orchestration-kernel': 'Orchestration kernel',
    'subpersona-menu': 'Sub-persona menu',
    'substrate-preferences': 'Preferences substrate',
    'substrate-memory-guidance': 'Memory guidance substrate',
    'substrate-knowledge': 'Context message — not system prompt',
  };
  return map[id] || id.replace(/[-_]/g, ' ');
}

/** @param {PromptReviewConfig} config @returns {PromptLayer[]} */
function buildReviewLayers(config) {
  const c = normalizeConfig(config);
  const base = 'System prompt composition and agent runtime rules.';
  const spineHas = c.hasManager;
  const spineNo = !c.hasManager;
  const lifecycleTerminal = c.lifecycle === 'terminal';
  const lifecycleResident = !lifecycleTerminal;
  const baseText = joinPieces([
    '# Runtime base',
    base,
  ]);
  const spineHasText = joinPieces([
    '# Spine with manager',
    'You have a manager. Report upward and keep the spine active.',
  ]);
  const spineNoText = joinPieces([
    '# Spine without manager',
    'You have no manager. Work independently and do not assume an upstream reviewer.',
  ]);
  const lifecycleTerminalText = joinPieces([
    '# Terminal lifecycle',
    'This node must finish with a final report when its work is done.',
  ]);
  const lifecycleResidentText = joinPieces([
    '# Resident lifecycle',
    'This node stays resident and waits for inbound events instead of always owing a final.',
  ]);
  const waitingText = joinPieces([
    '# Waiting',
    'When you are blocked on a future event, stop and wait instead of busy-looping.',
  ]);
  const personaBody = joinPieces([
    `# ${kindLabel(c.kind)} persona`,
    `Kind-specific prompt body for ${c.kind}.`,
  ]);
  const orchestrationKernel = joinPieces([
    '# Orchestration kernel',
    'Kernel guidance for orchestrator mode.',
  ]);

  /** @type {PromptLayer[]} */
  const layers = [
    makeLayer('runtime-base', 'Runtime base', 'protocol', 'personas/runtime-base.md', '/abs/src/builtin-personas/runtime-base.md', 'builtin', true, null, baseText),
    makeLayer('spine-has-manager', 'Spine (has manager)', 'protocol', 'personas/spine/has-manager.md', '/abs/src/builtin-personas/spine/has-manager.md', 'builtin', spineHas, spineHas ? null : 'hasManager == false', spineHasText),
    makeLayer('spine-no-manager', 'Spine (no manager)', 'protocol', 'personas/spine/no-manager.md', '/abs/src/builtin-personas/spine/no-manager.md', 'builtin', spineNo, spineNo ? null : 'hasManager == true', spineNoText),
    makeLayer('lifecycle-terminal', 'Lifecycle (terminal)', 'protocol', 'personas/lifecycle/terminal.md', '/abs/src/builtin-personas/lifecycle/terminal.md', 'builtin', lifecycleTerminal, lifecycleTerminal ? null : 'lifecycle == resident', lifecycleTerminalText),
    makeLayer('lifecycle-resident', 'Lifecycle (resident)', 'protocol', 'personas/lifecycle/resident.md', '/abs/src/builtin-personas/lifecycle/resident.md', 'builtin', lifecycleResident, lifecycleResident ? null : 'lifecycle == terminal', lifecycleResidentText),
    makeLayer('waiting', 'Waiting', 'protocol', 'personas/waiting.md', '/abs/src/builtin-personas/waiting.md', 'builtin', true, null, waitingText),
    makeLayer('persona-body', 'Persona body', 'persona', c.mode === 'base' ? `personas/${c.kind}/PERSONA.md` : `personas/${c.kind}/orchestrator.md`, c.mode === 'base' ? `/abs/src/builtin-personas/${c.kind}/PERSONA.md` : `/abs/src/builtin-personas/${c.kind}/orchestrator.md`, 'builtin', true, null, c.mode === 'base' ? personaBody : joinPieces([personaBody, orchestrationKernel])),
    makeLayer('subpersona-menu', 'Sub-persona menu', 'generated', `generated:${c.kind}:sub-personas`, null, 'generated', true, null, joinPieces([
      `Generated sub-persona menu for ${c.kind}.`,
      'This layer is synthesized from the available sub-personas and their source files.',
    ])),
  ];

  if (c.node) {
    layers.push(
      makeLayer('substrate-preferences', 'Preferences substrate', 'substrate', 'runtime:preferences', null, 'runtime', true, null, joinPieces([
        '# Preferences substrate',
        'Node-scoped preferences are spliced into the system prompt here.',
      ])),
      makeLayer('substrate-memory-guidance', 'Memory guidance substrate', 'substrate', 'runtime:memory-guidance', null, 'runtime', true, null, joinPieces([
        '# Memory guidance',
        'Runtime-spliced memory guidance shown here because a node was supplied.',
      ])),
      makeLayer('substrate-knowledge', 'Context message — not system prompt', 'substrate', 'runtime:knowledge', null, 'runtime', true, null, joinPieces([
        '# Context message',
        'This node-specific knowledge block is not part of the system prompt.',
      ])),
    );
  }

  return layers;
}

/** @param {PromptReviewConfig} config @returns {string} */
function composeAssembled(config) {
  const c = normalizeConfig(config);
  const layers = buildReviewLayers(c);
  const protocol = layers.filter((layer) => layer.group !== 'substrate');
  const substrate = layers.filter((layer) => layer.group === 'substrate');
  const protocolText = joinPieces(protocol.filter((layer) => layer.included).map((layer) => layer.text));
  if (c.node && substrate.length) {
    return joinPieces([protocolText, ...substrate.map((layer) => layer.text)]);
  }
  return protocolText;
}

/** @param {PromptReviewConfig} config @param {PromptLayer[]} layers @returns {PromptLayer[]} */
function maybeAddNodeLayers(config, layers) {
  if (!config.node) return layers;
  return layers.concat(buildReviewLayers(config).filter((layer) => layer.group === 'substrate'));
}

/** @param {PromptLayer} layer @returns {string} */
function sourceForLayer(layer) { return layer.sourcePath || layer.source; }

/** @param {PromptReviewConfig} config @param {PromptLayer[]} layers @returns {{config:PromptReviewConfig, layers:PromptLayer[], assembled:string, total:{tokens:number, chars:number}, sources:PromptSource[]}} */
function reviewPayload(config, layers) {
  const assembled = composeAssembled(config);
  const totalChars = chars(assembled);
  const totalTokens = tokens(assembled);
  return { config: normalizeConfig(config), layers, assembled, total: { tokens: totalTokens, chars: totalChars }, sources: dedupeSources(layers) };
}

/** @param {unknown} value @returns {value is PromptReviewConfig} */
function looksLikeConfig(value) {
  return !!value && typeof value === 'object' && 'kind' in /** @type {any} */ (value) && 'mode' in /** @type {any} */ (value) && 'lifecycle' in /** @type {any} */ (value);
}

/** @param {PromptReviewConfig} config @returns {PromptReviewConfig} */
function withNormalizedCompare(config) {
  return normalizeConfig(config);
}

/** @param {string} s @returns {string} */
function stripSnippet(s) { return str(s).replace(/\s+/g, ' ').trim(); }

/** @param {string} text @returns {string[]} */
function textLines(text) { return normalizeText(text).split('\n'); }

/** @param {string} a @param {string} b @returns {string} */
function diffSnippet(a, b) {
  const left = textLines(a);
  const right = textLines(b);
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  let endLeft = left.length - 1;
  let endRight = right.length - 1;
  while (endLeft >= start && endRight >= start && left[endLeft] === right[endRight]) { endLeft--; endRight--; }
  const out = [];
  const prefix = left.slice(0, start);
  const suffix = left.slice(endLeft + 1);
  for (const line of prefix.slice(-2)) out.push(`  ${line}`);
  for (const line of left.slice(start, endLeft + 1)) out.push(`- ${line}`);
  for (const line of right.slice(start, endRight + 1)) out.push(`+ ${line}`);
  for (const line of suffix.slice(0, 2)) out.push(`  ${line}`);
  return out.join('\n').trim();
}

/** @param {PromptLayer|null} left @param {PromptLayer|null} right @returns {string} */
function compareLayerText(left, right) {
  if (!left && !right) return '';
  if (!left) return right ? `+ ${right.text}` : '';
  if (!right) return `- ${left.text}`;
  if (left.text === right.text) return left.text;
  return diffSnippet(left.text, right.text);
}

/** @param {PromptLayer[]} left @param {PromptLayer[]} right @returns {Array<{id:string,label:string,kind:'added'|'removed'|'changed',left:PromptLayer|null,right:PromptLayer|null,summary:string,diffText:string}>} */
function diffReviews(left, right) {
  const a = new Map(left.map((layer) => [layer.id, layer]));
  const b = new Map(right.map((layer) => [layer.id, layer]));
  const ids = [...new Set([...a.keys(), ...b.keys()])];
  /** @type {Array<{id:string,label:string,kind:'added'|'removed'|'changed',left:PromptLayer|null,right:PromptLayer|null,summary:string,diffText:string}>} */
  const out = [];
  for (const id of ids) {
    const l = a.get(id) || null;
    const r = b.get(id) || null;
    if (l && !r) {
      out.push({ id, label: l.label, kind: 'removed', left: l, right: null, summary: `${l.label} removed in compare config`, diffText: `- ${stripSnippet(l.text)}` });
    } else if (!l && r) {
      out.push({ id, label: r.label, kind: 'added', left: null, right: r, summary: `${r.label} added in compare config`, diffText: `+ ${stripSnippet(r.text)}` });
    } else if (l && r && (l.included !== r.included || l.text !== r.text || l.condition !== r.condition || l.sourcePath !== r.sourcePath || l.scope !== r.scope)) {
      out.push({ id, label: l.label, kind: 'changed', left: l, right: r, summary: `${l.label} changed`, diffText: compareLayerText(l, r) });
    }
  }
  return out;
}

/** @param {PromptReviewConfig} config @param {PromptLayer[]} layers @returns {{config:PromptReviewConfig, layers:PromptLayer[], assembled:string, total:{tokens:number, chars:number}, sources:PromptSource[]}} */
function makeReview(config, layers) {
  return reviewPayload(config, layers);
}

/** @type {import('../../core/view/contract.js').Source<PromptReviewList>} */
export const listSource = {
  id: 'prompt-review-list',
  request: () => execRequest('crtr', ['sys', 'prompt-review', '--list', '--json']),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(studioError(firstLine(raw.stderr || raw.stdout || 'crtr sys prompt-review --list failed')));
    let data;
    try { data = JSON.parse(String(raw.stdout || '').trim() || '{}'); }
    catch { return fail(studioError('could not parse crtr sys prompt-review --list output as JSON')); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.kinds) || !Array.isArray(data.modes) || !Array.isArray(data.lifecycles) || typeof data.subPersonas !== 'object') {
      return fail(studioError('unexpected response from crtr sys prompt-review --list'));
    }
    return ok(/** @type {PromptReviewList} */ ({
      kinds: data.kinds.map((item) => ({ kind: str(item.kind), whenToUse: str(item.whenToUse) })),
      modes: data.modes.filter((m) => m === 'base' || m === 'orchestrator'),
      lifecycles: data.lifecycles.filter((l) => l === 'terminal' || l === 'resident'),
      subPersonas: Object.fromEntries(Object.entries(data.subPersonas).map(([k, items]) => [k, Array.isArray(items) ? items.map((item) => ({ kind: str(item.kind), whenToUse: str(item.whenToUse) })) : []])),
    }));
  },
};

/** @type {import('../../core/view/contract.js').Source<ReturnType<typeof makeReview>, PromptReviewConfig>} */
export const reviewSource = {
  id: 'prompt-review-review',
  request: (config) => {
    const c = normalizeConfig(config || /** @type {PromptReviewConfig} */ ({ kind: DEFAULT_KIND, mode: DEFAULT_MODE, lifecycle: DEFAULT_LIFECYCLE, hasManager: DEFAULT_HAS_MANAGER, node: null }));
    const args = ['sys', 'prompt-review', '--kind', c.kind, '--mode', c.mode, '--lifecycle', c.lifecycle, '--has-manager', c.hasManager ? 'true' : 'false', '--json'];
    if (c.node) args.push('--node', c.node);
    return execRequest('crtr', args);
  },
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(studioError(firstLine(raw.stderr || raw.stdout || 'crtr sys prompt-review failed')));
    let data;
    try { data = JSON.parse(String(raw.stdout || '').trim() || '{}'); }
    catch { return fail(studioError('could not parse crtr sys prompt-review output as JSON')); }
    if (!data || typeof data !== 'object' || !looksLikeConfig(data.config) || !Array.isArray(data.layers) || typeof data.assembled !== 'string' || !data.total || typeof data.total !== 'object' || !Array.isArray(data.sources)) {
      return fail(studioError('unexpected response from crtr sys prompt-review'));
    }
    const layers = data.layers.map((layer) => ({
      id: str(layer.id),
      label: str(layer.label) || layerLabel(str(layer.id)),
      group: layer.group === 'persona' || layer.group === 'generated' || layer.group === 'substrate' ? layer.group : 'protocol',
      source: str(layer.source),
      sourcePath: layer.sourcePath ? str(layer.sourcePath) : null,
      scope: layer.scope === 'project' || layer.scope === 'user' || layer.scope === 'builtin' || layer.scope === 'generated' || layer.scope === 'runtime' ? layer.scope : 'builtin',
      included: layer.included === true,
      condition: layer.condition == null ? null : str(layer.condition),
      text: normalizeText(layer.text),
      tokens: typeof layer.tokens === 'number' ? layer.tokens : approxTokens(chars(layer.text)),
      chars: typeof layer.chars === 'number' ? layer.chars : chars(layer.text),
    }));
    const config = normalizeConfig({
      kind: str(data.config.kind) || DEFAULT_KIND,
      mode: data.config.mode === 'orchestrator' ? 'orchestrator' : 'base',
      lifecycle: data.config.lifecycle === 'resident' ? 'resident' : 'terminal',
      hasManager: bool(data.config.hasManager),
      node: data.config.node ? str(data.config.node) : null,
    });
    // Preserve the backend's authoritative assembled string, totals, and source list —
    // only the layered UI iterates layers; Raw/Copy/export must reflect the real prompt.
    const sources = data.sources.map((s) => ({
      id: str(s.id),
      label: str(s.label) || layerLabel(str(s.id)),
      path: s.path ? str(s.path) : '',
      scope: s.scope === 'project' || s.scope === 'user' || s.scope === 'builtin' || s.scope === 'generated' || s.scope === 'runtime' ? s.scope : 'builtin',
    })).filter((s) => s.path);
    const assembled = normalizeText(data.assembled);
    const total = {
      tokens: typeof data.total.tokens === 'number' ? data.total.tokens : approxTokens(chars(assembled)),
      chars: typeof data.total.chars === 'number' ? data.total.chars : chars(assembled),
    };
    return ok(/** @type {ReturnType<typeof makeReview>} */ ({ config, layers, assembled, total, sources }));
  },
};

/** @type {import('../../core/view/contract.js').Source<Array<{node_id:string, name:string, kind:string, mode:string, lifecycle:string, status:string, cwd:string, parent:string|null, created:string, enterable:boolean}>>} */
export const nodeListSource = {
  id: 'prompt-review-nodes',
  request: () => execRequest('crtr', ['node', 'inspect', 'list', '--json']),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(studioError(firstLine(raw.stderr || raw.stdout || 'crtr node inspect list failed'), 'action'));
    let data;
    try { data = JSON.parse(String(raw.stdout || '').trim() || '{}'); }
    catch { return fail(studioError('could not parse crtr node inspect list output as JSON')); }
    if (!data || typeof data !== 'object' || !Array.isArray(data.nodes)) return fail(studioError('unexpected response from crtr node inspect list'));
    return ok(data.nodes.map((node) => ({
      node_id: str(node.node_id),
      name: str(node.name),
      kind: str(node.kind),
      mode: str(node.mode),
      lifecycle: str(node.lifecycle),
      status: str(node.status),
      cwd: str(node.cwd),
      parent: node.parent == null ? null : str(node.parent),
      created: str(node.created),
      enterable: node.enterable === true,
    })).filter((node) => node.status === 'active' || node.status === 'idle'));
  },
};

/** @type {import('../../core/view/contract.js').Command<{path:string}, {config:PromptReviewConfig, comments:Array<{layerId:string,label:string,sourcePath:string|null,scope:LayerScope,anchor:string|null,body:string}>, sources:PromptSource[]}>} */
export const exportCommand = {
  id: 'prompt-review-export',
  request: (payload) => execRequest('crtr', ['sys', 'prompt-review', 'export', '--json'], JSON.stringify(payload || {})),
  parse: (raw) => {
    if (!raw.ok || raw.exitCode !== 0) return fail(studioError(firstLine(raw.stderr || raw.stdout || 'crtr sys prompt-review export failed')));
    let data;
    try { data = JSON.parse(String(raw.stdout || '').trim() || '{}'); }
    catch { return fail(studioError('could not parse crtr sys prompt-review export output as JSON')); }
    if (!data || typeof data !== 'object' || typeof data.path !== 'string') return fail(studioError('unexpected response from crtr sys prompt-review export'));
    return ok({ path: data.path });
  },
};

/** @param {PromptReviewConfig} config @param {PromptReviewConfig|null} compareConfig @returns {Promise<{review: ReturnType<typeof makeReview>, compareReview: ReturnType<typeof makeReview> | null, list: PromptReviewList | null, liveNodes: Array<{node_id:string, name:string, kind:string, mode:string, lifecycle:string, status:string, cwd:string, parent:string|null, created:string, enterable:boolean}> | null}>} */
async function loadAll(ctx, config, compareConfig) {
  const tasks = [ctx.resolve(listSource), ctx.resolve(reviewSource, config), ctx.resolve(nodeListSource)];
  if (compareConfig) tasks.push(ctx.resolve(reviewSource, compareConfig));
  const [listRes, reviewRes, nodesRes, compareRes] = await Promise.all(tasks);
  if (!reviewRes.ok) throw reviewRes.error;
  return {
    list: listRes.ok ? listRes.data : null,
    review: reviewRes.data,
    liveNodes: nodesRes.ok ? nodesRes.data : null,
    compareReview: compareConfig ? (compareRes && compareRes.ok ? compareRes.data : null) : null,
  };
}

/** @param {ReviewState} state @returns {PromptLayer|undefined} */
function selectedLayer(state) {
  const layers = state.review || [];
  return layers.find((layer) => layer.id === state.selectedLayerId) || layers[state.cursor] || layers.find((layer) => layer.included) || layers[0];
}

/** @param {ReviewState} state @returns {PromptLayer|undefined} */
function compareSelectedLayer(state) {
  const layers = state.compareReview || [];
  return layers.find((layer) => layer.id === state.compareSelectedLayerId) || layers[state.compareCursor] || layers.find((layer) => layer.included) || layers[0];
}

/** @param {PromptReviewConfig} config @param {PromptLayer[]|null} review @returns {string} */
function selectedLayerIdOrFirst(config, review) {
  if (!review || review.length === 0) return '';
  return review.find((layer) => layer.included)?.id || review[0].id;
}

/** @param {PromptLayer[]|null} review @param {string|null} id @returns {number} */
function cursorFor(review, id) {
  if (!review || review.length === 0) return 0;
  const idx = id ? review.findIndex((layer) => layer.id === id) : -1;
  return idx >= 0 ? idx : Math.max(0, review.findIndex((layer) => layer.included) >= 0 ? review.findIndex((layer) => layer.included) : 0);
}

/** @param {ReviewState} state @param {PromptReviewConfig} config @param {PromptReviewConfig|null} compareConfig @param {ReturnType<typeof makeReview>|null} reviewPayloadObj @param {ReturnType<typeof makeReview>|null} comparePayloadObj @returns {ReviewState} */
function materialize(state, config, compareConfig, reviewPayloadObj, comparePayloadObj) {
  const review = reviewPayloadObj ? reviewPayloadObj.layers : null;
  const compareReview = comparePayloadObj ? comparePayloadObj.layers : null;
  const next = { ...state, config, compareConfig, review, compareReview };
  if (review && review.length) {
    const chosen = state.selectedLayerId && review.some((layer) => layer.id === state.selectedLayerId) ? state.selectedLayerId : selectedLayerIdOrFirst(config, review);
    next.selectedLayerId = chosen;
    next.cursor = cursorFor(review, chosen);
    const expanded = { ...state.expanded };
    if (!(chosen in expanded)) expanded[chosen] = true;
    next.expanded = expanded;
  }
  if (compareReview && compareReview.length) {
    next.compareSelectedLayerId = state.compareSelectedLayerId && compareReview.some((layer) => layer.id === state.compareSelectedLayerId)
      ? state.compareSelectedLayerId
      : selectedLayerIdOrFirst(compareConfig || config, compareReview);
    next.compareCursor = cursorFor(compareReview, next.compareSelectedLayerId);
    if (!(next.compareSelectedLayerId in next.expanded)) next.expanded = { ...next.expanded, [next.compareSelectedLayerId]: true };
  }
  next.sources = reviewPayloadObj ? reviewPayloadObj.sources : [];
  next.assembled = reviewPayloadObj ? reviewPayloadObj.assembled : null;
  next.totalTokens = reviewPayloadObj ? reviewPayloadObj.total.tokens : 0;
  next.totalChars = reviewPayloadObj ? reviewPayloadObj.total.chars : 0;
  next.compareAssembled = comparePayloadObj ? comparePayloadObj.assembled : null;
  return next;
}

/** @type {import('../../core/view/contract.js').ViewCore<ReviewState>} */
const core = {
  manifest: {
    id: 'prompt-review',
    title: 'Prompt Studio',
    subtitle: 'prompt assembly review + export',
    description: 'inspect assembled prompts, provenance, comments, and diffs',
  },

  init() {
    const config = normalizeConfig({ kind: DEFAULT_KIND, mode: DEFAULT_MODE, lifecycle: DEFAULT_LIFECYCLE, hasManager: DEFAULT_HAS_MANAGER, node: null });
    return {
      config,
      compareConfig: makeDefaultCompare(config),
      list: null,
      liveNodes: [],
      review: null,
      compareReview: null,
      sources: [],
      totalTokens: 0,
      totalChars: 0,
      assembled: null,
      compareAssembled: null,
      selectedLayerId: null,
      cursor: 0,
      scroll: 0,
      compareSelectedLayerId: null,
      compareCursor: 0,
      expanded: {},
      viewMode: 'layered',
      comments: [],
      draftComment: null,
      rawSelection: '',
      lastExportPath: null,
      compareOpen: true,
      lastFetch: 0,
      sourceError: null,
      auxiliaryError: null,
    };
  },

  sources: {
    list: listSource,
    nodes: nodeListSource,
    review: reviewSource,
  },

  commands: {
    export: exportCommand,
  },

  intents: {
    async refresh(ctx) {
      ctx.signal.setStatus('Loading Prompt Studio…');
      const config = normalizeConfig(ctx.state.config);
      const compareConfig = ctx.state.compareOpen && ctx.state.compareConfig ? normalizeConfig(ctx.state.compareConfig) : null;
      try {
        const result = await loadAll(ctx, config, compareConfig);
        ctx.set((s) => {
          const next = materialize({ ...s }, config, compareConfig, result.review, result.compareReview);
          next.list = result.list || s.list;
          next.liveNodes = result.liveNodes || s.liveNodes;
          next.sourceError = null;
          next.auxiliaryError = null;
          next.lastFetch = Date.now();
          return next;
        });
        if (result.list && result.liveNodes) ctx.signal.clearBanner();
        ctx.signal.setStatus(null);
      } catch (err) {
        const e = /** @type {SourceError} */ (err);
        ctx.set((s) => {
          const next = { ...s, lastFetch: Date.now() };
          if (!s.review) next.sourceError = e;
          else next.auxiliaryError = e;
          return next;
        });
        if (ctx.state.review) ctx.signal.setBanner(e.display.explanation || e.display.headline, e.display.level);
        ctx.signal.setStatus(null);
      }
    },

    setKind(ctx, kind) {
      ctx.set((s) => ({ ...s, config: { ...s.config, kind: str(kind) || DEFAULT_KIND } }));
      return ctx.dispatch('refresh');
    },

    setMode(ctx, mode) {
      ctx.set((s) => ({ ...s, config: { ...s.config, mode: mode === 'orchestrator' ? 'orchestrator' : 'base' } }));
      return ctx.dispatch('refresh');
    },

    setLifecycle(ctx, lifecycle) {
      ctx.set((s) => ({ ...s, config: { ...s.config, lifecycle: lifecycle === 'resident' ? 'resident' : 'terminal' } }));
      return ctx.dispatch('refresh');
    },

    toggleHasManager(ctx) {
      ctx.set((s) => ({ ...s, config: { ...s.config, hasManager: !s.config.hasManager } }));
      return ctx.dispatch('refresh');
    },

    setNode(ctx, node) {
      ctx.set((s) => ({ ...s, config: { ...s.config, node: node ? str(node) : null } }));
      return ctx.dispatch('refresh');
    },

    setCompareKind(ctx, kind) {
      ctx.set((s) => ({ ...s, compareConfig: { ...(s.compareConfig || makeDefaultCompare(s.config)), kind: str(kind) || DEFAULT_KIND } }));
      return ctx.dispatch('refresh');
    },

    setCompareMode(ctx, mode) {
      ctx.set((s) => ({ ...s, compareConfig: { ...(s.compareConfig || makeDefaultCompare(s.config)), mode: mode === 'orchestrator' ? 'orchestrator' : 'base' } }));
      return ctx.dispatch('refresh');
    },

    setCompareLifecycle(ctx, lifecycle) {
      ctx.set((s) => ({ ...s, compareConfig: { ...(s.compareConfig || makeDefaultCompare(s.config)), lifecycle: lifecycle === 'resident' ? 'resident' : 'terminal' } }));
      return ctx.dispatch('refresh');
    },

    toggleCompareHasManager(ctx) {
      ctx.set((s) => ({ ...s, compareConfig: { ...(s.compareConfig || makeDefaultCompare(s.config)), hasManager: !(s.compareConfig || makeDefaultCompare(s.config)).hasManager } }));
      return ctx.dispatch('refresh');
    },

    setCompareNode(ctx, node) {
      ctx.set((s) => ({ ...s, compareConfig: { ...(s.compareConfig || makeDefaultCompare(s.config)), node: node ? str(node) : null } }));
      return ctx.dispatch('refresh');
    },

    toggleCompareOpen(ctx) {
      ctx.set((s) => {
        const compareOpen = !s.compareOpen;
        // Reopening must seed a config — materialize nulls compareConfig on close, so without
        // this the diff panel comes back empty until another compare control fires.
        const compareConfig = compareOpen ? (s.compareConfig || makeDefaultCompare(s.config)) : s.compareConfig;
        return { ...s, compareOpen, compareConfig };
      });
      return ctx.dispatch('refresh');
    },

    setViewMode(ctx, mode) {
      ctx.set((s) => ({ ...s, viewMode: mode === 'raw' ? 'raw' : 'layered' }));
    },

    selectLayer(ctx, layerId) {
      ctx.set((s) => {
        const id = str(layerId) || s.selectedLayerId;
        const cursor = s.review ? Math.max(0, s.review.findIndex((layer) => layer.id === id)) : s.cursor;
        return { ...s, selectedLayerId: id, cursor };
      });
    },

    cursorDown(ctx) {
      ctx.set((s) => {
        if (!s.review || s.review.length === 0) return s;
        const cursor = Math.min(s.review.length - 1, s.cursor + 1);
        const layer = s.review[cursor];
        return { ...s, cursor, selectedLayerId: layer ? layer.id : s.selectedLayerId };
      });
    },

    cursorUp(ctx) {
      ctx.set((s) => {
        if (!s.review || s.review.length === 0) return s;
        const cursor = Math.max(0, s.cursor - 1);
        const layer = s.review[cursor];
        return { ...s, cursor, selectedLayerId: layer ? layer.id : s.selectedLayerId };
      });
    },

    selectCompareLayer(ctx, layerId) {
      ctx.set((s) => {
        const id = str(layerId) || s.compareSelectedLayerId;
        const compareCursor = s.compareReview ? Math.max(0, s.compareReview.findIndex((layer) => layer.id === id)) : s.compareCursor;
        return { ...s, compareSelectedLayerId: id, compareCursor };
      });
    },

    compareCursorDown(ctx) {
      ctx.set((s) => {
        if (!s.compareReview || s.compareReview.length === 0) return s;
        const compareCursor = Math.min(s.compareReview.length - 1, s.compareCursor + 1);
        const layer = s.compareReview[compareCursor];
        return { ...s, compareCursor, compareSelectedLayerId: layer ? layer.id : s.compareSelectedLayerId };
      });
    },

    compareCursorUp(ctx) {
      ctx.set((s) => {
        if (!s.compareReview || s.compareReview.length === 0) return s;
        const compareCursor = Math.max(0, s.compareCursor - 1);
        const layer = s.compareReview[compareCursor];
        return { ...s, compareCursor, compareSelectedLayerId: layer ? layer.id : s.compareSelectedLayerId };
      });
    },

    toggleLayerExpanded(ctx, layerId) {
      ctx.set((s) => ({ ...s, expanded: { ...s.expanded, [str(layerId)]: !s.expanded[str(layerId)] } }));
    },

    captureRawSelection(ctx, text) {
      ctx.set((s) => ({ ...s, rawSelection: stripSnippet(text) }));
    },

    beginComment(ctx) {
      const layer = selectedLayer(ctx.state);
      if (!layer) return;
      const anchor = ctx.state.viewMode === 'raw' ? (ctx.state.rawSelection || null) : null;
      ctx.set((s) => ({
        ...s,
        draftComment: {
          layerId: layer.id,
          label: layer.label,
          sourcePath: layer.sourcePath,
          scope: layer.scope,
          anchor,
          body: '',
        },
      }));
    },

    setCommentBody(ctx, body) {
      ctx.set((s) => (s.draftComment ? { ...s, draftComment: { ...s.draftComment, body: str(body) } } : s));
    },

    cancelComment(ctx) {
      ctx.set((s) => ({ ...s, draftComment: null }));
    },

    saveComment(ctx) {
      const draft = ctx.state.draftComment;
      if (!draft || !stripSnippet(draft.body)) return;
      ctx.set((s) => ({
        ...s,
        comments: [...s.comments, { ...draft, body: stripSnippet(draft.body) }],
        draftComment: null,
      }));
    },

    removeComment(ctx, idx) {
      const i = typeof idx === 'number' ? idx : Number(idx);
      if (!Number.isFinite(i) || i < 0) return;
      ctx.set((s) => ({ ...s, comments: s.comments.filter((_, n) => n !== i) }));
    },

    async exportComments(ctx) {
      if (!ctx.state.review) return;
      const payload = {
        config: ctx.state.config,
        comments: ctx.state.comments,
        sources: ctx.state.sources,
      };
      ctx.signal.setStatus('Exporting review…');
      const r = await ctx.execute(exportCommand, payload);
      if (!r.ok) {
        ctx.signal.setBanner(r.error.display.explanation || r.error.display.headline, r.error.display.level);
        ctx.signal.setStatus(null);
        return;
      }
      ctx.set((s) => ({ ...s, lastExportPath: r.data.path }));
      ctx.signal.setStatus(`Review copied: ${r.data.path}`);
    },

    copyRaw(ctx) {
      ctx.signal.setStatus('Use Copy raw in the web view; the TUI is read-only.');
    },
  },
};

export {
  configKey,
  configHeadline,
  diffReviews,
  layerLabel,
  makeDefaultCompare,
  reviewPayload,
  selectedLayer,
  compareSelectedLayer,
  composeAssembled,
  buildReviewLayers,
  kindLabel,
};

export default core;
