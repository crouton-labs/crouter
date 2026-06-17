/**
 * Bash / shell tool card (spec C.6).
 *
 * Terminal styling: the command echoed on a prompt line, then stdout/stderr in
 * a monospace block. Output is rendered as ESCAPED plain text (terminal output
 * is not markdown and must not be interpreted). Streams from
 * `tool_execution_update` — whatever `result()` content the store has each
 * render is shown.
 */

import { cn } from '@/lib/utils.js';
import { escapeText } from '../../render/sanitize.js';
import { ToolCardShell, ResultImages, resultText, TERM_CLASSES, TERM_ERR, type ToolCardProps } from './parts.js';

function command(args: Record<string, unknown>): string {
  const c = args.command ?? args.cmd ?? args.script;
  return typeof c === 'string' ? c : '';
}

export function BashCard(props: ToolCardProps) {
  const cmd = command(props.call.arguments ?? {});
  const out = resultText(props.result);
  const inProgress = props.inProgress;
  const isError = props.isError;
  return (
    <ToolCardShell call={props.call} subtitle="" inProgress={inProgress} isError={isError}>
      <pre className={cn(TERM_CLASSES, isError && TERM_ERR)}>
        {cmd && (
          <>
            <span style={{ opacity: 0.6 }}>$ </span>
            <span dangerouslySetInnerHTML={{ __html: escapeText(cmd) }} />
            {'\n'}
          </>
        )}
        <span dangerouslySetInnerHTML={{ __html: escapeText(out) }} />
        {inProgress && <span className="inline-block size-2 rounded-full bg-[#7fb3ff] ml-1.5 animate-pulse" />}
      </pre>
      <ResultImages result={props.result} />
    </ToolCardShell>
  );
}
