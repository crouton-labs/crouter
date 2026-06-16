/**
 * Built-in export registry for crtr-generated host artifacts.
 *
 * Slash-command templates are one-way exports: code is the single source of
 * truth, so crtr renders them into host prompt/command dirs with marker-guarded
 * writes (see export.ts). Legacy generated Agent Skills are listed only as
 * cleanup targets; crouter's first-class guidance surface is memory docs.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { collectSlashSpecs } from '../command.js';
import type { RootDef, SlashSpec } from '../command.js';

/** A host runtime crtr exports generated artifacts into. */
export type Host = 'claude' | 'pi';

/** One destination for an export artifact. Only targets whose host root exists
 *  are written — crtr never creates `~/.claude` or `~/.pi` itself (export.ts). */
export interface HostTarget {
  host: Host;
  /** The leaf dir the artifact is written into (never the host root). */
  dir: () => string;
  /** `bundle` → `<dir>/<name>/SKILL.md` ; `file` → `<dir>/<name>.md`. */
  layout: 'bundle' | 'file';
}

/** One crtr-generated export artifact and every host it reaches. */
export interface ExportPair {
  /** Stable id for logging, e.g. `@cmd/<name>`. */
  id: string;
  /** On-disk artifact name (bundle dir name or file stem). */
  name: string;
  /** Marker prefix identifying a crtr-owned file (the clobber guard). */
  markerPrefix: string;
  /** Full file content incl. frontmatter + version marker. */
  render: () => string;
  /** Every host destination. Targets with an absent host root are skipped. */
  targets: HostTarget[];
}

/** A legacy crtr-generated artifact that should be removed if still present. */
export interface LegacyExportArtifact {
  /** Stable id for logging/debugging. */
  id: string;
  /** On-disk artifact name (bundle dir name or file stem). */
  name: string;
  /** Marker prefix identifying a crtr-owned file. Markerless files are user-owned. */
  markerPrefix: string;
  /** Every host destination. Targets with an absent host root are skipped. */
  targets: HostTarget[];
}

// ── Slash commands ───────────────────────────────────────────────────────────

const SLASH_CMD_MARKER = '<!-- crtr-mode-cmd v1 -->';
export const SLASH_CMD_MARKER_PREFIX = '<!-- crtr-mode-cmd v';

/** Render a SlashSpec to a full template file (frontmatter + marker + body). */
function renderSlashTemplate(spec: SlashSpec): string {
  const hint = spec.argumentHint !== undefined
    ? `argument-hint: ${JSON.stringify(spec.argumentHint)}\n`
    : '';
  return `---\ndescription: ${spec.description}\n${hint}---\n\n${SLASH_CMD_MARKER}\n\n${spec.body}\n`;
}

// ── Host roots ───────────────────────────────────────────────────────────────

function claudeSkillsRoot(): string {
  return join(homedir(), '.claude', 'skills');
}
function piSkillsRoot(): string {
  return join(homedir(), '.pi', 'agent', 'skills');
}
function claudeCommandsRoot(): string {
  return join(homedir(), '.claude', 'commands');
}
function piPromptsRoot(): string {
  return join(homedir(), '.pi', 'agent', 'prompts');
}

// ── Registry ─────────────────────────────────────────────────────────────────

const LEGACY_BOOT_SKILL_MARKER_PREFIX = '<!-- crtr-boot-skill v';

/** Legacy crtr-generated exports that should not survive after the memory cutover. */
export function legacyExportArtifacts(): LegacyExportArtifact[] {
  return [
    {
      id: '@legacy/crtr-skills',
      name: 'crtr-skills',
      markerPrefix: LEGACY_BOOT_SKILL_MARKER_PREFIX,
      targets: [
        { host: 'claude', dir: claudeSkillsRoot, layout: 'bundle' },
        { host: 'pi', dir: piSkillsRoot, layout: 'bundle' },
      ],
    },
  ];
}

/** The crtr-generated export artifacts for this command tree: one pair per
 *  opted-in slash command (both hosts, file layout). */
export function builtinExportPairs(root: RootDef): ExportPair[] {
  const pairs: ExportPair[] = [];

  for (const spec of collectSlashSpecs(root)) {
    pairs.push({
      id: `@cmd/${spec.name}`,
      name: spec.name,
      markerPrefix: SLASH_CMD_MARKER_PREFIX,
      render: () => renderSlashTemplate(spec),
      targets: [
        { host: 'claude', dir: claudeCommandsRoot, layout: 'file' },
        { host: 'pi', dir: piPromptsRoot, layout: 'file' },
      ],
    });
  }

  return pairs;
}
