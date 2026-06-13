export type Scope = 'user' | 'project' | 'builtin';

export const ExitCode = {
  SUCCESS: 0,
  GENERAL: 1,
  USAGE: 2,
  NOT_FOUND: 3,
  AMBIGUOUS: 4,
  NETWORK: 5,
} as const;
export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode];

export const SCHEMA_VERSION = 2;

export interface OwnerRef {
  name?: string;
  email?: string;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  source?: string;
  owner?: OwnerRef;
  kinds?: string[];
}

export interface MarketplacePluginEntry {
  name: string;
  source: string;
  version?: string;
  description?: string;
  keywords?: string[];
}

export interface MarketplaceManifest {
  name: string;
  version?: string;
  owner?: OwnerRef;
  plugins: MarketplacePluginEntry[];
}

export interface ConfigMarketplaceEntry {
  url: string;
  ref: string;
  installed_at: string;
}

export interface ConfigPluginEntry {
  enabled: boolean;
  source_marketplace?: string;
  version?: string;
}

export type AutoUpdateMode = 'notify' | 'apply' | false;

export interface AutoUpdateConfig {
  crtr: AutoUpdateMode;
  content: AutoUpdateMode;
  interval_hours: number;
}

/** One canvas-nav action binding: a `crtr` argv string (templated with
 *  {id|self|name|manager|subtree}) plus optional confirm gate + menu label.
 *  `run` of the sentinel `__graph__` toggles the in-pi GRAPH modal instead of
 *  shelling a command. */
export interface CanvasBind {
  run: string;
  confirm?: boolean;
  desc?: string;
}

/** Canvas-nav config (`canvasNav` in config.json). `prefixBinds` are consumed
 *  at the tmux alt+c menu layer; `graphBinds` are consumed in-process by the
 *  canvas-nav pi extension while in GRAPH. Built-in GRAPH keys
 *  (j/k/h/l/g/G/enter/m/e/x/esc) are reserved — `graphBinds` is strictly
 *  additive. */
export interface CanvasNavConfig {
  /** Fallback pi shortcut for GRAPH toggle when NOT in tmux. Default 'alt+g'. */
  prefixKey?: string;
  /** chord key (after alt+c) → action; tmux-menu layer. */
  prefixBinds: Record<string, CanvasBind>;
  /** extra raw key in GRAPH → action; pi-extension layer (additive only). */
  graphBinds: Record<string, CanvasBind>;
}

export type ModelStrength = 'ultra' | 'strong' | 'medium' | 'light';
export type ModelProvider = 'anthropic' | 'openai';

export interface ModelLaddersConfig {
  /** Optional default provider for bare strengths. If unset, runtime falls back
   *  to CRTR_MODEL_PROVIDER, then anthropic. */
  defaultProvider?: ModelProvider;
  anthropic: Record<ModelStrength, string>;
  openai: Record<ModelStrength, string>;
}

export interface ScopeConfig {
  schema_version: number;
  marketplaces: Record<string, ConfigMarketplaceEntry>;
  plugins: Record<string, ConfigPluginEntry>;
  auto_update: AutoUpdateConfig;
  max_panes_per_window: number;
  canvasNav: CanvasNavConfig;
  modelLadders: ModelLaddersConfig;
  personaStrengths: Record<string, ModelStrength>;
}

export interface ScopeState {
  marketplaces: Record<string, { last_updated?: string }>;
  plugins: Record<string, { last_updated?: string }>;
  last_self_check?: string;
  bootstrap_done?: boolean;
}

export const SKILL_TYPES = ['playbook', 'primer', 'reference', 'runbook', 'freeform'] as const;
export type SkillType = (typeof SKILL_TYPES)[number];

export function isSkillType(v: unknown): v is SkillType {
  return typeof v === 'string' && (SKILL_TYPES as readonly string[]).includes(v);
}

export interface SkillFrontmatter {
  name: string;
  description?: string;
  keywords?: string[];
  type?: SkillType;
}

export interface SubagentFrontmatter {
  name: string;
  description?: string;
  /** Tool allow-list (pi tool names). Passed through to pi via `--tools`. */
  tools?: string[];
  /** Model pattern/id passed to the agent CLI via `--model`. */
  model?: string;
}

export interface Subagent {
  name: string;
  /** Plugin the subagent belongs to, or the sentinel '_' for a scope-root
   *  agent stored at `<scope-root>/agents/<name>.md`. */
  plugin: string;
  scope: Scope;
  /** Absolute path to the agent's .md file. */
  path: string;
  frontmatter: SubagentFrontmatter;
  /** Markdown body — used as the spawned agent's appended system prompt. */
  systemPrompt: string;
}

export interface InstalledPlugin {
  name: string;
  scope: Scope;
  root: string;
  manifest: PluginManifest;
  enabled: boolean;
  builtin?: boolean;
  sourceMarketplace?: string;
  version?: string;
}

export interface InstalledMarketplace {
  name: string;
  scope: Scope;
  root: string;
  manifest: MarketplaceManifest;
  url: string;
  ref: string;
}

export const PLUGIN_MANIFEST_DIR = '.crouter-plugin';
export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const MARKETPLACE_MANIFEST_DIR = '.crouter-marketplace';
export const MARKETPLACE_MANIFEST_FILE = 'marketplace.json';
export const CRTR_DIR_NAME = '.crouter';
export const CONFIG_FILE = 'config.json';
export const STATE_FILE = 'state.json';
export const SKILL_ENTRY_FILE = 'SKILL.md';
export const SKILLS_DIR = 'skills';
// Subagent definitions live as flat `<name>.md` files under `<root>/agents/`,
// for both scope roots and plugins. Mirrors SKILLS_DIR.
export const AGENTS_DIR = 'agents';
export const DEFAULT_MAX_PANES_PER_WINDOW = 3;

export function defaultScopeConfig(): ScopeConfig {
  return {
    schema_version: SCHEMA_VERSION,
    marketplaces: {},
    plugins: {},
    auto_update: { crtr: 'notify', content: 'notify', interval_hours: 24 },
    max_panes_per_window: DEFAULT_MAX_PANES_PER_WINDOW,
    canvasNav: defaultCanvasNavConfig(),
    modelLadders: defaultModelLaddersConfig(),
    personaStrengths: {},
  };
}

/** Built-in canvas-nav binds so an absent config still gives the intended UX.
 *  prefixBinds: g→GRAPH toggle (sentinel), m→focus manager.
 *  1..9 (focus report N) are generated by the menu layer, not literal entries.
 *  graphBinds: empty — built-in GRAPH keys are reserved, custom keys add on. */
export function defaultCanvasNavConfig(): CanvasNavConfig {
  return {
    prefixKey: 'alt+g',
    prefixBinds: {
      g: { run: '__graph__', desc: 'graph view' },
      m: { run: 'node focus {manager}', desc: 'focus manager' },
    },
    graphBinds: {},
  };
}

export function defaultModelLaddersConfig(): ModelLaddersConfig {
  return {
    anthropic: {
      ultra: 'anthropic/claude-fable-5:high',
      strong: 'anthropic/claude-opus-4-8:high',
      medium: 'anthropic/claude-sonnet-4-6:high',
      light: 'anthropic/claude-haiku-4-5:high',
    },
    openai: {
      ultra: 'openai-codex/gpt-5.5:xhigh',
      strong: 'openai-codex/gpt-5.5:high',
      medium: 'openai-codex/gpt-5.4-mini:medium',
      light: 'openai-codex/gpt-5.3-codex-spark',
    },
  };
}

export function defaultScopeState(): ScopeState {
  return { marketplaces: {}, plugins: {} };
}
