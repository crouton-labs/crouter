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

export interface ConfigSkillEntry {
  enabled: boolean;
}

export type AutoUpdateMode = 'notify' | 'apply' | false;

export interface AutoUpdateConfig {
  crtr: AutoUpdateMode;
  content: AutoUpdateMode;
  interval_hours: number;
}

export interface ScopeConfig {
  schema_version: number;
  marketplaces: Record<string, ConfigMarketplaceEntry>;
  plugins: Record<string, ConfigPluginEntry>;
  skills: Record<string, ConfigSkillEntry>;
  auto_update: AutoUpdateConfig;
  max_panes_per_window: number;
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

export interface Skill {
  name: string;
  plugin: string;
  scope: Scope;
  path: string;
  pluginRoot: string;
  frontmatter: SkillFrontmatter;
  enabled: boolean;
  disabledIn?: Scope;
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
  /** Plugin the subagent belongs to, or SCOPE_SKILL_PLUGIN ('_') for a
   *  scope-root agent stored at `<scope-root>/agents/<name>.md`. */
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
// Sentinel plugin name for skills that live at a scope root (no plugin wrapper).
// Stored as `<scope-root>/skills/<name>/SKILL.md`. Shown in listings without the
// `_/` prefix.
export const SCOPE_SKILL_PLUGIN = '_';

export const DEFAULT_MAX_PANES_PER_WINDOW = 3;

export function defaultScopeConfig(): ScopeConfig {
  return {
    schema_version: SCHEMA_VERSION,
    marketplaces: {},
    plugins: {},
    skills: {},
    auto_update: { crtr: 'notify', content: 'notify', interval_hours: 24 },
    max_panes_per_window: DEFAULT_MAX_PANES_PER_WINDOW,
  };
}

export function skillConfigKey(plugin: string, name: string): string {
  return `${plugin}/${name}`;
}

export function defaultScopeState(): ScopeState {
  return { marketplaces: {}, plugins: {} };
}
