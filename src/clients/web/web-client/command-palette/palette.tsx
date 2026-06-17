/**
 * Slash command palette (spec §5.E). A `/`-triggered filter over the node's
 * command inventory (fetched by the page via rest.getCommands). The page drives
 * it: it passes the current input query and visible (input starts with `/`)
 * and an onSelect that inserts `/name ` into the input. Commands are filtered
 * by name/description/source against the text after the leading `/`; argument
 * hints are surfaced. Invocation flows through the normal prompt path
 * (controller-only) — the palette only edits the input.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Command } from '@/shared/protocol.js';

export function CommandPalette(props: {
  commands: Command[];
  /** The current input value. */
  query: string;
  /** Show the palette (typically: input starts with `/`). */
  visible: boolean;
  /** Insert the selected command's invocation into the input. */
  onSelect: (command: Command) => void;
}): ReactNode {
  const term = useMemo(() => {
    const q = props.query;
    return q.startsWith('/') ? q.slice(1).trimStart().toLowerCase() : '';
  }, [props.query]);

  const filtered = useMemo(() => {
    const cmds = props.commands;
    if (!term) return cmds;
    return cmds.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        c.description.toLowerCase().includes(term) ||
        c.source.toLowerCase().includes(term),
    );
  }, [term, props.commands]);

  if (!props.visible) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-1 max-h-72 overflow-auto rounded-md border border-border bg-popover shadow-lg">
      {filtered.length > 0 ? (
        <ul className="flex flex-col divide-y divide-border/40">
          {filtered.map((cmd) => (
            <li
              key={cmd.name}
              className="flex cursor-pointer flex-wrap items-baseline gap-x-2 gap-y-0.5 px-3 py-2 hover:bg-accent/50"
              onClick={() => props.onSelect(cmd)}
            >
              <span className="font-mono text-sm font-semibold text-primary">/{cmd.name}</span>
              {cmd.argument_hint && (
                <span className="font-mono text-xs text-muted-foreground/70">{cmd.argument_hint}</span>
              )}
              <span className="ml-auto font-mono text-xs text-muted-foreground/50">
                {cmd.source}
                {cmd.location && <> · {cmd.location}</>}
              </span>
              <span className="basis-full text-xs text-muted-foreground">{cmd.description}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 py-2 text-xs italic text-muted-foreground">no matching commands</div>
      )}
    </div>
  );
}
