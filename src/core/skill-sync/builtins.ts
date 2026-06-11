/**
 * Built-in export registry for the skill-sync subsystem.
 *
 * These are the crtr-*generated* host artifacts — the `crtr-skills` boot skill
 * and any CLI slash-commands. Unlike the user-authored bidirectional manifest
 * pairs (engine.ts), an export pair has a single source of truth (code), so it
 * is one-way: render → marker-guarded write (see export.ts). The generators
 * (`bootSkillBody`, `renderSlashTemplate`) and their version markers were moved
 * here verbatim from bootstrap.ts when skill-sync became the sole host writer —
 * marker strings are byte-identical so already-deployed artifacts roll forward.
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
  /** Stable id for logging, e.g. `@boot/crtr-skills` or `@cmd/<name>`. */
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

// ── Boot skill ───────────────────────────────────────────────────────────────

const BOOT_SKILL_NAME = 'crtr-skills';
const BOOT_SKILL_MARKER = '<!-- crtr-boot-skill v2 -->';
export const BOOT_SKILL_MARKER_PREFIX = '<!-- crtr-boot-skill v';

function bootSkillBody(): string {
  return `---
name: crtr-skills
description: 'Author, list, search, and load crtr memory documents (knowledge, preferences) via the crtr CLI. These are durable agent memory — markdown future LLM sessions load on demand. Use when the user wants to remember/save knowledge, build a context primer, or recall a previously saved doc. Triggers: "save", "remember", "build context for", "what skills do we have", "skill for X".'
argument-hint: [topic or verb]
---

${BOOT_SKILL_MARKER}

# /crtr-skills — crtr memory router

crtr memory documents = durable agent memory (kind: knowledge or preference).
Written for **future LLM sessions**, not the user. \`crtr memory\` is the
surface — author, discover, and load them.

## Route by intent

- **Capture** ("save", "remember", "build context for", "make a skill"):
  \`crtr memory write <name> --kind <knowledge|preference>\` with the
  body piped on stdin — e.g.
  \`crtr memory write $ARGUMENTS --kind knowledge <<'EOF' … EOF\`. Run
  \`crtr memory write -h\` for the full frontmatter schema
  (--when-and-why-to-read, --short-form, --scope, visibility rungs), then
  \`crtr memory lint\` to validate what you wrote.
- **Find** ("what do we have on X"): \`crtr memory find "$ARGUMENTS"\` →
  \`crtr memory read <name>\` on the best hit (add --body/--grep to search
  bodies).
- **Load by name**: \`crtr memory read <name>\`.
- **List all**: \`crtr memory list\`.

If \`$ARGUMENTS\` is empty, ask the user what they want before running.

## Rules

- CLI stdout is the prompt — act on it, don't paraphrase to the user.
- Append \`-h\` at any leaf (\`crtr memory write -h\`) for its full schema
  before authoring.
- If \`crtr\` is not on PATH, tell the user and stop.
`;
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

/** The crtr-generated export artifacts for this command tree: the boot skill
 *  (both hosts, bundle layout) plus one pair per opted-in slash command (both
 *  hosts, file layout). */
export function builtinExportPairs(root: RootDef): ExportPair[] {
  const pairs: ExportPair[] = [
    {
      id: '@boot/crtr-skills',
      name: BOOT_SKILL_NAME,
      markerPrefix: BOOT_SKILL_MARKER_PREFIX,
      render: bootSkillBody,
      targets: [
        { host: 'claude', dir: claudeSkillsRoot, layout: 'bundle' },
        { host: 'pi', dir: piSkillsRoot, layout: 'bundle' },
      ],
    },
  ];

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
