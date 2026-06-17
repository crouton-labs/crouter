/**
 * Consumer tool-card titles (design §5.1). The same tool cards render in both
 * audiences; Operator shows the raw pi tool name (mono), Studio shows a plain-
 * language title. This is the card-title map the design calls for — "Ran a
 * command", "Read a file", "Searched the web" — keyed on the canonical tool
 * name (same alias collapsing as the renderer registry). The picker in
 * ToolCardShell chooses raw vs friendly by capability, never by profile name.
 */

import type { ToolCall } from '@/shared/protocol.js';

const TITLES: Record<string, string> = {
  bash: 'Ran a command',
  shell: 'Ran a command',
  sh: 'Ran a command',
  run: 'Ran a command',
  terminal: 'Ran a command',

  read: 'Read a file',
  read_file: 'Read a file',
  cat: 'Read a file',
  view: 'Read a file',

  edit: 'Edited a file',
  str_replace: 'Edited a file',
  apply_patch: 'Edited a file',

  write: 'Wrote a file',
  write_file: 'Wrote a file',
  create: 'Wrote a file',

  grep: 'Searched the files',
  rg: 'Searched the files',
  search: 'Searched the files',

  web_search: 'Searched the web',
  websearch: 'Searched the web',
  web: 'Searched the web',

  fetch: 'Read a web page',
  curl: 'Read a web page',
  http: 'Read a web page',
};

/** Title-case a raw tool name as a last-resort friendly label. */
function humanize(name: string): string {
  const words = (name || 'tool').replace(/[_-]+/g, ' ').trim();
  return words ? `Used ${words}` : 'Used a tool';
}

/** A plain-language title for a tool call (Studio). */
export function friendlyToolTitle(call: ToolCall): string {
  return TITLES[(call.name || '').toLowerCase()] ?? humanize(call.name);
}
