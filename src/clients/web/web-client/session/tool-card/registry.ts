/**
 * Tool-card renderer registry (design D10, spec C.6/AC-7).
 *
 * Keyed by pi `toolName`. Each entry is a React component that renders a
 * STRUCTURED card for that tool — never a raw JSON dump. Unknown tools fall to
 * the generic card. Discrimination is on the `toolName` string only: pi exports
 * no `isBashToolResult`-style guards, so cards inspect `ToolResultMessage`
 * content/details directly.
 */

import type { ComponentType } from 'react';
import type { ToolCardProps } from './parts.js';

import { BashCard } from './bash.js';
import { ReadCard } from './read.js';
import { EditCard } from './edit.js';
import { WriteCard } from './write.js';
import { GrepCard } from './grep.js';
import { GenericCard } from './generic.js';

export type ToolCardComponent = ComponentType<ToolCardProps>;

/**
 * Canonical name → renderer. Aliases (the broker/tooling sometimes names the
 * same capability differently) collapse onto the canonical card.
 */
const REGISTRY: Record<string, ToolCardComponent> = {
  bash: BashCard,
  shell: BashCard,
  sh: BashCard,
  run: BashCard,
  terminal: BashCard,

  read: ReadCard,
  read_file: ReadCard,
  cat: ReadCard,
  view: ReadCard,

  edit: EditCard,
  str_replace: EditCard,
  apply_patch: EditCard,

  write: WriteCard,
  write_file: WriteCard,
  create: WriteCard,

  grep: GrepCard,
  search: GrepCard,
  rg: GrepCard,
};

/** Resolve the renderer for a tool name, falling back to the generic card. */
export function getToolCard(toolName: string): ToolCardComponent {
  return REGISTRY[(toolName || '').toLowerCase()] ?? GenericCard;
}

/** The registered (canonical + alias) keys — handy for tests/introspection. */
export const toolCardKeys: readonly string[] = Object.keys(REGISTRY);
