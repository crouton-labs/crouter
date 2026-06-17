/**
 * Write tool card (spec C.6).
 *
 * Shows the NEW file content (the whole body is the "diff" for a create). The
 * body is syntax-highlighted via the sanitized markdown fence path so the
 * DOMPurify boundary applies. Result note (bytes written / error) shows below.
 */

import { cn } from '@/lib/utils.js';
import { renderCodeBlock } from '../../render/markdown.js';
import { escapeText } from '../../render/sanitize.js';
import { ToolCardShell, ResultImages, resultText, callSubtitle, MD_CLASSES, EMPTY_CLASSES, TERM_CLASSES, TERM_ERR, type ToolCardProps } from './parts.js';

const EXT_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', json: 'json', sh: 'bash',
  py: 'python', html: 'html', xml: 'xml', css: 'css', md: 'markdown', yml: 'yaml', yaml: 'yaml',
};

function pick(args: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) if (typeof args[k] === 'string') return args[k] as string;
  return '';
}

export function WriteCard(props: ToolCardProps) {
  const args = props.call.arguments ?? {};
  const path = callSubtitle(props.call);
  const content = pick(args, ['content', 'contents', 'text', 'body', 'new_string', 'file_text']);
  const note = resultText(props.result);
  const isError = props.isError;
  const html = (() => {
    if (!content) return '';
    const m = /\.([a-z0-9]+)$/i.exec(path);
    const lang = (m && EXT_LANG[m[1].toLowerCase()]) || '';
    return renderCodeBlock(content, lang);
  })();
  return (
    <ToolCardShell call={props.call} subtitle={path} inProgress={props.inProgress} isError={isError}>
      {content
        ? <div className={MD_CLASSES} style={{ padding: '4px 8px' }} dangerouslySetInnerHTML={{ __html: html }} />
        : <div className={EMPTY_CLASSES}>no content</div>
      }
      {note && (
        <div className={cn(TERM_CLASSES, isError && TERM_ERR)} dangerouslySetInnerHTML={{ __html: escapeText(note) }} />
      )}
      <ResultImages result={props.result} />
    </ToolCardShell>
  );
}
