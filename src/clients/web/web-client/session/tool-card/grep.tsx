/**
 * Grep / search tool card (spec C.6).
 *
 * Renders the result as a match list (one escaped line per output line) under a
 * header showing the search pattern. Output is escaped plain text — match lines
 * are not markdown and must stay inert.
 */

import { escapeText } from '../../render/sanitize.js';
import { ToolCardShell, ResultImages, resultText, EMPTY_CLASSES, type ToolCardProps } from './parts.js';

function pattern(args: Record<string, unknown>): string {
  const p = args.pattern ?? args.query ?? args.regex ?? args.search;
  return typeof p === 'string' ? p : '';
}

export function GrepCard(props: ToolCardProps) {
  const pat = pattern(props.call.arguments ?? {});
  const text = resultText(props.result);
  const lines = text ? text.split('\n').filter((l) => l.length > 0) : [];
  const inProgress = props.inProgress;
  return (
    <ToolCardShell call={props.call} subtitle={pat} inProgress={inProgress} isError={props.isError}>
      {lines.length > 0
        ? (
          <div className="m-0 font-mono text-xs overflow-auto max-h-[28rem]">
            {lines.map((l, i) => (
              <div key={i} className="px-3 py-1 font-mono text-xs opacity-85" dangerouslySetInnerHTML={{ __html: escapeText(l) }} />
            ))}
          </div>
        )
        : (!inProgress && <div className={EMPTY_CLASSES}>no matches</div>)
      }
      <ResultImages result={props.result} />
    </ToolCardShell>
  );
}
