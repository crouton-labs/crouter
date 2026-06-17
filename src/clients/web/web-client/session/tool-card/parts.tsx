/**
 * Shared tool-card scaffolding (spec C.6/AC-7, design D10).
 *
 * `ToolCardProps` is the contract every card renders against (plain values, not
 * accessors); `ToolCardShell` gives the common chrome (tool name + subtitle +
 * status pill + error border) built from shadcn Card primitives; the helpers
 * pull text/images out of `ToolResultMessage.content` and pretty-print args
 * WITHOUT ever dumping raw JSON as the card body.
 */

import { type ReactNode, createContext, useContext, useState } from 'react';
import { Loader2, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import type {
  ToolCall,
  ToolResultMessage,
  TextContent,
  ImageContent,
} from '@/shared/protocol.js';
import { ImageBlock } from '../image-block.js';
import { useCapability } from '../../profile/provider.js';
import { friendlyToolTitle } from './friendly-titles.js';
import { isPeekablePath } from '../../lib/file-link.js';
import { useTranscriptDetail } from '../../lib/transcript-detail.js';

// ---------------------------------------------------------------------------
// PeekContext — set at the node-page level, consumed by ToolCardShell
// ---------------------------------------------------------------------------

export interface PeekContextValue {
  peekedPath: string | null;
  onPeek: (path: string) => void;
}

export const PeekContext = createContext<PeekContextValue>({
  peekedPath: null,
  onPeek: () => {},
});

export function usePeek() {
  return useContext(PeekContext);
}

/** Markdown-body styling (the `.cw-md` equivalent; mirrors text-block). */
export const MD_CLASSES =
  '[&_pre]:overflow-auto [&_pre]:p-[10px_12px] [&_pre]:rounded-md [&_pre]:bg-muted [&_code]:font-mono [&_code]:text-xs [&_:not(pre)>code]:bg-muted [&_:not(pre)>code]:px-1.5 [&_:not(pre)>code]:py-0.5 [&_:not(pre)>code]:rounded [&_p]:my-[0.4em] [&_a]:text-primary';

/** Terminal output block (`.cw-term`); pair with `TERM_ERR` via `cn` for errors. */
export const TERM_CLASSES =
  'm-0 px-3 py-2 bg-[#0c0f13] text-[#d6dde6] font-mono text-xs whitespace-pre-wrap overflow-auto max-h-[26rem]';
export const TERM_ERR = 'text-[#ff9b8a]';

/** Italic muted placeholder (`.cw-empty`). */
export const EMPTY_CLASSES = 'px-3 py-2 opacity-50 text-xs italic';

/**
 * Quiet Instrument tool glyph — the monogram in the `.tool-glyph` square,
 * keyed on canonical tool name (same alias collapsing as the registry). All
 * glyphs are Unicode text, no images (mockup convention).
 */
const TOOL_GLYPH: Record<string, string> = {
  bash: '❯', shell: '❯', sh: '❯', run: '❯', terminal: '❯',
  read: '≣', read_file: '≣', cat: '≣', view: '≣',
  edit: '✎', str_replace: '✎', apply_patch: '✎',
  write: '✚', write_file: '✚', create: '✚',
  grep: '⌕', search: '⌕', rg: '⌕',
  web_search: '◎', websearch: '◎', web: '◎',
  fetch: '⤓', curl: '⤓', http: '⤓',
};

function toolGlyph(name: string): string {
  return TOOL_GLYPH[(name || '').toLowerCase()] ?? '◆';
}

/** Contract for every tool-card renderer (paired call + result). */
export interface ToolCardProps {
  /** The assistant's tool-call block (name + structured arguments). */
  call: ToolCall;
  /** The matching tool result, or undefined until it arrives. */
  result: ToolResultMessage | undefined;
  /** True while the tool is still executing (no/empty result + streaming). */
  inProgress: boolean;
  /** True when the tool reported an error. */
  isError: boolean;
}

/** Concatenate the text blocks of a tool result. */
export function resultText(result: ToolResultMessage | undefined): string {
  if (!result) return '';
  return result.content
    .filter((b): b is TextContent => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

/** The image blocks of a tool result. */
export function resultImages(result: ToolResultMessage | undefined): ImageContent[] {
  if (!result) return [];
  return result.content.filter((b): b is ImageContent => b.type === 'image');
}

/** Pretty-print tool arguments as readable text (NOT a raw JSON dump body). */
export function prettyArgs(args: Record<string, unknown> | undefined): string {
  if (!args || Object.keys(args).length === 0) return '';
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

/** A one-line subtitle summarising the call (path/command/pattern). */
export function callSubtitle(call: ToolCall): string {
  const a = call.arguments ?? {};
  const pick = (k: string): string | undefined =>
    typeof a[k] === 'string' ? (a[k] as string) : undefined;
  return (
    pick('command') ??
    pick('cmd') ??
    pick('path') ??
    pick('file_path') ??
    pick('filename') ??
    pick('pattern') ??
    pick('query') ??
    ''
  );
}

export interface ShellProps {
  call: ToolCall;
  subtitle?: string;
  inProgress: boolean;
  isError: boolean;
  children: ReactNode;
}

/** Common card chrome: header (tool name, subtitle, status pill) + body slot. */
export function ToolCardShell({ call, subtitle, inProgress, isError, children }: ShellProps) {
  const sub = subtitle ?? callSubtitle(call);
  // Audience copy: the internals audience (Operator) reads the raw pi tool name
  // in mono; a consumer audience (Studio) reads a plain-language title in sans.
  // Capability-driven — never branched on profile name.
  const raw = useCapability('node.internals');
  const title = raw ? call.name : friendlyToolTitle(call);

  const detail = useTranscriptDetail();
  const { peekedPath, onPeek } = usePeek();

  // Detail level (§4) sets the auto posture: verbose = expanded; standard =
  // collapsed but in-progress auto-expands; focused = one-line, click to open.
  // A user toggle (null until clicked) overrides the auto posture and wins
  // thereafter — so the con-head Detail control re-flows untouched cards live.
  const autoExpanded = detail === 'verbose' || (detail === 'standard' && inProgress);
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const bodyVisible = userExpanded ?? autoExpanded;

  return (
    <div
      className={cn('tool', bodyVisible && 'open')}
      style={isError ? { borderColor: 'var(--blk)' } : undefined}
    >
      {/* Header — clickable toggle */}
      <div className="tool-head" onClick={() => setUserExpanded(!bodyVisible)}>
        <span className="tool-glyph">{toolGlyph(call.name)}</span>
        <span className={cn('tool-name', !raw && 'normal-case font-sans tracking-normal text-xs')}>{title}</span>
        {sub && (
          <span className="tool-arg">
            {isPeekablePath(sub) ? (
              <span
                className={cn('filelink', peekedPath === sub && 'peeked')}
                onClick={(e) => { e.stopPropagation(); onPeek(sub); }}
              >
                {sub}
              </span>
            ) : (
              sub
            )}
          </span>
        )}
        {/* Status chip — .chip atom + state-tinted variants */}
        <span className="ml-auto shrink-0 flex items-center">
          {inProgress ? (
            <span
              className="chip inline-flex items-center gap-1"
              style={{ color: 'var(--idle)', background: 'var(--idle-dim)', border: '1px solid var(--line2)' }}
            >
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
              running
            </span>
          ) : isError ? (
            <span
              className="chip"
              style={{ color: 'var(--blk)', background: 'var(--blk-dim)', border: '1px solid var(--blk)' }}
            >
              error
            </span>
          ) : (
            <span className="chip ok">done</span>
          )}
        </span>
        <ChevronDown
          className={cn('size-3.5 text-[var(--dim)] transition-transform', !bodyVisible && '-rotate-90')}
        />
      </div>
      {/* Body — always in DOM; `.tool-body` CSS hides it unless `.open` is set. */}
      <div className="tool-body">{children}</div>
    </div>
  );
}

/** Render any image blocks attached to a tool result. */
export function ResultImages({ result }: { result: ToolResultMessage | undefined }) {
  const images = resultImages(result);
  if (images.length === 0) return null;
  return (
    <>
      {images.map((img, i) => (
        <div key={i} className="px-3 py-1">
          <ImageBlock image={img} />
        </div>
      ))}
    </>
  );
}
