/**
 * File peek panel (Phase 2c).
 *
 * A right-side panel that shows the contents of an absolute file path. Opens
 * when the user clicks a path in a tool-card subtitle; closes via the ✕ button
 * or the Escape key. Supports Pretty (markdown) and Raw (plain text) modes.
 *
 * Quiet Instrument `.peek` surface: panel gradient, mono rtl-truncated name,
 * Pretty/Raw/✕ act buttons, frontmatter `.fm-chip`s, `.md` body, footer kbd.
 */

import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils.js';
import { peekFile, type FilePeekResponse } from '../net/rest-compat.js';
import { renderMarkdown } from '../render/markdown.js';

export interface FilePeekProps {
  nodeId: string;
  path: string | null;
  onClose: () => void;
}

type Mode = 'pretty' | 'raw';

/** `.md` body styling — serif h1, square-bullet list, bold ink emphasis. */
const MD_CLASSES = [
  '[&_h1]:font-[family-name:var(--font-serif)] [&_h1]:text-xl [&_h1]:font-medium [&_h1]:leading-[1.3] [&_h1]:mb-4 [&_h1]:text-[var(--ink)]',
  '[&_h2]:font-[family-name:var(--font-serif)] [&_h2]:text-base [&_h2]:font-medium [&_h2]:mb-3 [&_h2]:mt-4 [&_h2]:text-[var(--ink)]',
  '[&_p]:text-xs [&_p]:leading-[1.65] [&_p]:text-[var(--ink2)] [&_p]:mb-3',
  '[&_ul]:list-none [&_ol]:list-none',
  '[&_li]:relative [&_li]:pl-5 [&_li]:pb-3.5 [&_li]:text-xs [&_li]:leading-[1.65] [&_li]:text-[var(--ink2)]',
  "[&_li]:before:content-[''] [&_li]:before:absolute [&_li]:before:left-[2px] [&_li]:before:top-[8px] [&_li]:before:size-1.5 [&_li]:before:border [&_li]:before:border-[var(--mut)] [&_li]:before:rounded-[2px] [&_li]:before:rotate-45",
  '[&_b]:text-[var(--ink)] [&_b]:font-semibold [&_strong]:text-[var(--ink)] [&_strong]:font-semibold',
  '[&_pre]:overflow-auto [&_pre]:p-[10px_12px] [&_pre]:rounded-md [&_pre]:bg-[oklch(0_0_0/0.28)] [&_pre]:text-xs',
  '[&_code]:font-mono [&_code]:text-xs',
  '[&_a]:text-[var(--bone)] [&_a]:underline [&_a]:decoration-dotted',
].join(' ');

export function FilePeek({ nodeId, path, onClose }: FilePeekProps) {
  const [mode, setMode] = useState<Mode>('pretty');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<FilePeekResponse | null>(null);

  // Load file whenever path changes
  useEffect(() => {
    if (!path) return;
    setLoading(true);
    setError(null);
    setData(null);
    peekFile(nodeId, path)
      .then((res) => {
        setData(res);
        setLoading(false);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
  }, [nodeId, path]);

  // Escape key closes
  useEffect(() => {
    if (!path) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [path, onClose]);

  if (!path) return null;

  return (
    <div
      className="relative z-[1] flex h-full w-[21.5rem] shrink-0 flex-col border-l border-[var(--line)] bg-[linear-gradient(180deg,var(--panel2),var(--panel))] shadow-[inset_1px_0_0_var(--raise)]"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3.5 py-3 border-b border-[var(--line)]">
        <span className="text-xs text-[var(--done)] shrink-0">◆</span>
        {/* rtl truncation shows the filename end */}
        <span
          className="font-mono text-xs text-[var(--ink2)] flex-1 truncate"
          style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
          title={path}
        >
          {path}
        </span>
        {/* Pretty/Raw/Close act buttons */}
        <div className="flex gap-1.5 shrink-0">
          <PeekActButton on={mode === 'pretty'} onClick={() => setMode('pretty')}>Pretty</PeekActButton>
          <PeekActButton on={mode === 'raw'} onClick={() => setMode('raw')}>Raw</PeekActButton>
          <PeekActButton onClick={onClose} aria-label="Close file peek">✕</PeekActButton>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto px-5 py-5">
        {loading && (
          <div className="flex items-center justify-center h-16 text-[var(--dim)] text-xs">
            <span className="animate-pulse">Loading…</span>
          </div>
        )}
        {error && <div className="text-xs text-[var(--blk)]">{error}</div>}
        {data && !loading && (
          <>
            {data.truncated && (
              <div className="mb-3 text-xs text-[var(--dim)]">
                File truncated — showing partial content
              </div>
            )}
            {mode === 'raw' ? (
              <pre className="text-xs font-mono text-[var(--ink2)] whitespace-pre-wrap break-all leading-[1.7]">{data.content}</pre>
            ) : (
              <PrettyView content={data.content} />
            )}
          </>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center gap-2 border-t border-[var(--line)] px-3.5 py-2.5 text-xs text-[var(--dim)]">
        any file path in the stream opens here
        <span className="kbd ml-auto">esc</span>
      </div>
    </div>
  );
}

function PeekActButton({
  on,
  onClick,
  children,
  ...rest
}: {
  on?: boolean;
  onClick: () => void;
  children: React.ReactNode;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'font-[family-name:var(--font-inst)] text-xs tracking-[0.1em] uppercase rounded-md px-2 py-1 border transition-all duration-[0.12s] cursor-pointer',
        on
          ? 'text-[var(--bone-ink)] bg-[var(--bone)] border-[var(--bone)]'
          : 'text-[var(--mut)] bg-transparent border-[var(--line)] hover:text-[var(--ink)] hover:border-[var(--line2)]',
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

function PrettyView({ content }: { content: string }) {
  // Check for YAML frontmatter
  if (content.startsWith('---\n') || content.startsWith('---\r\n')) {
    const endIdx = content.indexOf('\n---\n', 4);
    if (endIdx !== -1) {
      const fmRaw = content.slice(4, endIdx);
      const rest = content.slice(endIdx + 5);
      const pairs = fmRaw
        .split('\n')
        .map((line) => {
          const colon = line.indexOf(':');
          if (colon < 1) return null;
          return { key: line.slice(0, colon).trim(), val: line.slice(colon + 1).trim() };
        })
        .filter(Boolean) as { key: string; val: string }[];

      return (
        <>
          {pairs.length > 0 && (
            <div className="fm-chips">
              {pairs.map(({ key, val }) => (
                <span key={key} className="fm-chip">
                  {key} <b>{val}</b>
                </span>
              ))}
            </div>
          )}
          <div className={MD_CLASSES} dangerouslySetInnerHTML={{ __html: renderMarkdown(rest) }} />
        </>
      );
    }
  }

  return <div className={MD_CLASSES} dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
}
