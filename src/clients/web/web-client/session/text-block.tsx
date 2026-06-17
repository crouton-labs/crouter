/**
 * Assistant/text content block (spec C.4 / C.8, design D9).
 *
 * Two rendering modes, switched on `inProgress`:
 *   - WHILE STREAMING (the trailing text block of the active assistant message):
 *     render ESCAPED PLAIN TEXT, updated incrementally on every `text_delta`.
 *     No markdown pass — partial markup must never be interpreted.
 *   - WHEN ENDED: run the full markdown + highlight + sanitize pass once and set
 *     the sanitized HTML via dangerouslySetInnerHTML. `renderMarkdown` always
 *     returns DOMPurify-laundered HTML, so this is safe (C.8).
 *
 * Wrapped in the Quiet Instrument `.prose` atom (flush on the page background,
 * em-dash bullets, paragraph rhythm). The assistant carries its role by the
 * ABSENCE of a surface — no word label; just a single phosphor role dot that
 * shows at `standard`+ detail and vanishes at `focused`. Only code/link styling
 * is layered on top so the `.prose` paragraph/list rules stay authoritative.
 */

import { useMemo } from 'react';
import { renderMarkdown } from '../render/markdown.js';
import { escapeText } from '../render/sanitize.js';
import { useTranscriptDetail } from '../lib/transcript-detail.js';
import { cn } from '@/lib/utils.js';

export interface TextBlockProps {
  text: string;
  /** True while this is the still-growing trailing text block. */
  inProgress: boolean;
}

/** Code/link styling only — `.prose` owns paragraph + list rhythm. */
const CODE_CLASSES = [
  '[&_pre]:overflow-auto [&_pre]:p-[10px_12px] [&_pre]:rounded-md [&_pre]:bg-[oklch(0_0_0/0.28)]',
  '[&_code]:font-mono [&_code]:text-xs',
  '[&_:not(pre)>code]:bg-[oklch(0_0_0/0.28)] [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded',
  '[&_a]:text-[var(--bone)] [&_a]:underline [&_a]:decoration-dotted',
].join(' ');

// Prose reading plane per Detail level (design contract §4): focused is tight
// `text-sm`, standard is the relaxed reading default, verbose is generous.
const LEVEL_CLASSES = {
  focused: 'text-sm leading-snug',
  standard: 'text-sm leading-relaxed',
  verbose: 'text-base leading-relaxed',
} as const;

export function TextBlock({ text, inProgress }: TextBlockProps) {
  // Only recomputed when the ended text changes; never runs the markdown pass
  // while streaming.
  const html = useMemo<string>(() => {
    if (inProgress) return '';
    return renderMarkdown(text ?? '');
  }, [inProgress, text]);

  const detail = useTranscriptDetail();
  const levelClass = LEVEL_CLASSES[detail];

  return (
    <div className={cn('prose', levelClass)}>
      {detail !== 'focused' && (
        <div className="role">
          <span className="rdot" />
        </div>
      )}
      {inProgress ? (
        // escapeText output → dangerouslySetInnerHTML: entities render as literal
        // text; no markup can be interpreted mid-stream.
        <div
          className="whitespace-pre-wrap"
          dangerouslySetInnerHTML={{ __html: escapeText(text ?? '') }}
        />
      ) : (
        <div className={cn(CODE_CLASSES, levelClass)} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
