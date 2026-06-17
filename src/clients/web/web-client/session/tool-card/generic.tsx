/**
 * Generic tool card (design D10 fallback).
 *
 * For any tool without a bespoke renderer: tool name + pretty-printed args +
 * result text/images + error treatment. Args are formatted (indented), never a
 * raw single-line JSON blob, satisfying C.6's "structured card, never raw JSON".
 */

import { cn } from '@/lib/utils.js';
import { renderMarkdown } from '../../render/markdown.js';
import { ToolCardShell, ResultImages, prettyArgs, resultText, MD_CLASSES, EMPTY_CLASSES, TERM_ERR, type ToolCardProps } from './parts.js';

export type { ToolCardProps };

export function GenericCard(props: ToolCardProps) {
  const args = prettyArgs(props.call.arguments);
  const text = resultText(props.result);
  const isError = props.isError;
  const inProgress = props.inProgress;
  return (
    <ToolCardShell call={props.call} inProgress={inProgress} isError={isError}>
      {args && <pre className="m-0 px-3 py-2 bg-[#11161c] font-mono text-xs whitespace-pre-wrap overflow-auto max-h-60 border-b border-[#222b35]">{args}</pre>}
      {text && (
        <div
          className={cn(MD_CLASSES, isError && TERM_ERR)}
          style={{ padding: '8px 11px' }}
          dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
        />
      )}
      <ResultImages result={props.result} />
      {!args && !text && !inProgress && <div className={EMPTY_CLASSES}>no output</div>}
    </ToolCardShell>
  );
}
