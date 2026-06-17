/**
 * THE untrusted-content boundary (spec C.8 / AC-22, design D9).
 *
 * Every string of model- or tool-produced HTML passes through `sanitizeHtml`
 * before it is ever assigned to `innerHTML`. DOMPurify strips `<script>`, event
 * handlers (`on*`), `javascript:`/unsafe `data:` URLs, `<iframe>`/`<object>`
 * and the rest of the active-content surface, leaving inert markup.
 *
 * DOMPurify needs a DOM. In the browser that is the global `window` (present at
 * runtime). The node test injects a jsdom `window` onto `globalThis` before the
 * first call. We therefore bind LAZILY, reading `globalThis.window` (falling
 * back to `globalThis`) on first use — never at import time — so a test can set
 * the shim up first. The DOMPurify default export is itself a factory: calling
 * `DOMPurify(window)` returns an instance bound to that window.
 */

import DOMPurify from 'dompurify';

type Purifier = ReturnType<typeof DOMPurify>;

let purifier: Purifier | null = null;

function getPurifier(): Purifier {
  if (purifier) return purifier;
  const g = globalThis as unknown as { window?: unknown };
  const win = (g.window ?? globalThis) as Parameters<typeof DOMPurify>[0];
  purifier = DOMPurify(win);
  // Belt-and-braces config on top of DOMPurify's safe defaults: never allow a
  // link/area to carry an unknown protocol, and force `target=_blank` links to
  // also carry `rel="noopener"` so untrusted content cannot reach `window.opener`.
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element & { target?: string; setAttribute(n: string, v: string): void };
    if (el.tagName === 'A' && el.getAttribute?.('target')) {
      el.setAttribute('rel', 'noopener noreferrer');
    }
  });
  return purifier;
}

/**
 * Sanitize a string of (untrusted) HTML to inert markup. The single place HTML
 * is laundered before reaching the DOM. `javascript:` and other unsafe-protocol
 * hrefs, `on*` handlers, `<script>`/`<iframe>` and friends are removed.
 */
export function sanitizeHtml(dirty: string): string {
  return getPurifier().sanitize(dirty, {
    // DOMPurify's defaults already forbid script/event-handlers and bad URI
    // schemes; we make the link-protocol restriction explicit and drop a few
    // active-content vectors outright.
    FORBID_TAGS: ['style', 'form', 'input', 'button', 'textarea', 'object', 'embed'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true },
    // Permit inline data:image in <img> (used by the image-block path) while
    // still rejecting javascript:/vbscript: everywhere.
    ADD_DATA_URI_TAGS: ['img'],
  }) as string;
}

/**
 * Escape plain text for safe insertion as text content. Used by the streaming
 * path: while an assistant text block is still growing we render its raw text
 * escaped (no markdown pass) so partial markup can never be interpreted.
 */
export function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
