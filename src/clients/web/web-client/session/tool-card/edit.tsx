/**
 * Edit tool card (spec C.6).
 *
 * DIFF view of the old → new strings from the call arguments. Lines are escaped
 * plain text (file content is not markdown). The result text (e.g. a success
 * confirmation or error) shows beneath the diff with error treatment.
 * Diff colors: add → cw-diff-add (success bg), del → cw-diff-del (destructive bg).
 */

import { cn } from '@/lib/utils.js';
import { escapeText } from '../../render/sanitize.js';
import { lineDiff } from './diff.js';
import { ToolCardShell, ResultImages, resultText, callSubtitle, TERM_CLASSES, TERM_ERR, EMPTY_CLASSES, type ToolCardProps } from './parts.js';

function pick(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (typeof args[k] === 'string') return args[k] as string;
  return '';
}

export function EditCard(props: ToolCardProps) {
  const args = props.call.arguments ?? {};
  const oldS = pick(args, ['old_string', 'oldText', 'old', 'before', 'search']);
  const newS = pick(args, ['new_string', 'newText', 'new', 'after', 'replace']);
  const diff = lineDiff(oldS, newS);
  const note = resultText(props.result);
  const isError = props.isError;
  return (
    <ToolCardShell call={props.call} subtitle={callSubtitle(props.call)} inProgress={props.inProgress} isError={isError}>
      {(oldS || newS)
        ? (
          <div className="m-0 font-mono text-xs overflow-auto max-h-[28rem]">
            {diff.map((ln, i) => (
              <div
                key={i}
                className={cn(
                  'px-3 whitespace-pre-wrap',
                  ln.kind === 'add' && 'bg-[rgba(46,160,67,0.18)] text-[#aef0bf]',
                  ln.kind === 'del' && 'bg-[rgba(192,57,43,0.18)] text-[#ffb4ab]',
                  ln.kind === 'ctx' && 'opacity-70',
                )}
                dangerouslySetInnerHTML={{ __html: (ln.kind === 'add' ? '+ ' : ln.kind === 'del' ? '- ' : '  ') + escapeText(ln.text) }}
              />
            ))}
          </div>
        )
        : <div className={EMPTY_CLASSES}>no diff available</div>
      }
      {note && (
        <div className={cn(TERM_CLASSES, isError && TERM_ERR)} dangerouslySetInnerHTML={{ __html: escapeText(note) }} />
      )}
      <ResultImages result={props.result} />
    </ToolCardShell>
  );
}
