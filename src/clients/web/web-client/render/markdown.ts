/**
 * Sanitized markdown rendering with syntax highlighting (design D9).
 *
 * `renderMarkdown` parses CommonMark with markdown-it, highlights fenced code
 * with a CURATED highlight.js language set, and ALWAYS launders the result
 * through `sanitizeHtml` before returning. It NEVER returns unsanitized HTML —
 * `markdown-it` runs with `html: false` (raw HTML in the source is escaped, not
 * passed through) and the sanitize pass is the belt over that brace.
 *
 * Small-bundle rule: we build on `highlight.js/lib/core` and register only the
 * dozen languages an agent session actually emits, instead of pulling all ~190
 * (which would dwarf the bundle). Adding a language is one import + one
 * `registerLanguage` line below.
 */

import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';

import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import python from 'highlight.js/lib/languages/python';
import diff from 'highlight.js/lib/languages/diff';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import markdown from 'highlight.js/lib/languages/markdown';
import yaml from 'highlight.js/lib/languages/yaml';
import plaintext from 'highlight.js/lib/languages/plaintext';

import { sanitizeHtml } from './sanitize.js';

let registered = false;

function registerLanguages(): void {
  if (registered) return;
  registered = true;
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('shell', shell);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('diff', diff);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('markdown', markdown);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('plaintext', plaintext);
  // Common aliases so fences like ```ts / ```tsx / ```jsx / ```sh / ```html
  // / ```py / ```yml resolve to a registered language.
  hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' });
  hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' });
  hljs.registerAliases(['sh', 'zsh', 'console'], { languageName: 'bash' });
  hljs.registerAliases(['py'], { languageName: 'python' });
  hljs.registerAliases(['html', 'xhtml', 'svg'], { languageName: 'xml' });
  hljs.registerAliases(['yml'], { languageName: 'yaml' });
  hljs.registerAliases(['md'], { languageName: 'markdown' });
  hljs.registerAliases(['text', 'txt'], { languageName: 'plaintext' });
}

/** True iff highlight.js knows the language (after registration). */
export function isLanguageSupported(lang: string): boolean {
  registerLanguages();
  return !!lang && !!hljs.getLanguage(lang);
}

/**
 * Highlight a code body to `<span class="hljs-…">`-annotated HTML. Falls back
 * to escaped plain text when the language is unknown. The output is later run
 * through DOMPurify with the rest of the document, so it never needs to be
 * trusted on its own.
 */
export function highlightCode(code: string, lang: string): string {
  registerLanguages();
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      /* fall through to escaped */
    }
  }
  return md.utils.escapeHtml(code);
}

const md: MarkdownIt = new MarkdownIt({
  html: false, // never trust raw HTML in the source; sanitize is the second gate
  linkify: true,
  breaks: false,
  highlight(code, lang): string {
    const body = highlightCode(code, (lang || '').toLowerCase());
    const cls = lang ? `language-${lang} hljs` : 'hljs';
    return `<pre class="hljs"><code class="${md.utils.escapeHtml(cls)}">${body}</code></pre>`;
  },
});

/**
 * Render an untrusted markdown string to SANITIZED, inert HTML. The ONLY
 * markdown entry point for finished (non-streaming) text blocks. Always passes
 * through `sanitizeHtml` — callers may assign the result to `innerHTML`.
 */
export function renderMarkdown(src: string): string {
  registerLanguages();
  return sanitizeHtml(md.render(src ?? ''));
}

/**
 * Render a code body as a single highlighted, SANITIZED `<pre><code>` block,
 * WITHOUT round-tripping through a markdown fence. A fence-string approach
 * (`'```'+lang+'\n'+body+'\n```'`) breaks out of the fence whenever the body
 * itself contains a line of three backticks (common in Markdown files), so the
 * tail renders as live markdown. This builds the block directly — the body can
 * never escape it. Used by the read/write tool cards.
 */
export function renderCodeBlock(code: string, lang: string): string {
  registerLanguages();
  const body = highlightCode(code ?? '', (lang || '').toLowerCase());
  const cls = lang ? `language-${lang} hljs` : 'hljs';
  return sanitizeHtml(`<pre class="hljs"><code class="${md.utils.escapeHtml(cls)}">${body}</code></pre>`);
}

/** Render a single line of markdown (no block wrapper), sanitized. */
export function renderMarkdownInline(src: string): string {
  registerLanguages();
  return sanitizeHtml(md.renderInline(src ?? ''));
}
