/**
 * Read / view-file tool card (spec C.6).
 *
 * Shows the file body syntax-highlighted by extension. We reuse the sanitized
 * markdown path (`renderCodeBlock` of a fenced code block) so highlighting AND
 * the DOMPurify boundary both apply — the card never emits unsanitized HTML.
 */

import { renderCodeBlock } from '../../render/markdown.js';
import { ToolCardShell, ResultImages, resultText, callSubtitle, MD_CLASSES, EMPTY_CLASSES, type ToolCardProps } from './parts.js';

const EXT_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', diff: 'diff', patch: 'diff',
  html: 'html', htm: 'html', xml: 'xml', svg: 'xml',
  css: 'css', scss: 'css', md: 'markdown', markdown: 'markdown',
  yml: 'yaml', yaml: 'yaml',
};

function langFor(path: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  return (m && EXT_LANG[m[1].toLowerCase()]) || '';
}

export function ReadCard(props: ToolCardProps) {
  const path = callSubtitle(props.call);
  const body = resultText(props.result);
  const html = body ? renderCodeBlock(body, langFor(path)) : '';
  const inProgress = props.inProgress;
  return (
    <ToolCardShell call={props.call} inProgress={inProgress} isError={props.isError}>
      {body
        ? <div className={MD_CLASSES} style={{ padding: '4px 8px' }} dangerouslySetInnerHTML={{ __html: html }} />
        : (!inProgress && <div className={EMPTY_CLASSES}>no content</div>)
      }
      <ResultImages result={props.result} />
    </ToolCardShell>
  );
}
