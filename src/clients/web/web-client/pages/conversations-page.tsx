/**
 * Studio home — the Conversations list (design §5.1, §4.3). The main column is
 * the spine-forest of broker-hosted roots, each row a human title + plain-
 * language preview + relative time + a state pill, sorted needs-you-first then
 * most-recent. "+ New chat" opens a focused composer that spawns a root
 * (kind `general`, mode `base`, headless, the first message as the prompt) and
 * routes to it. Empty = warm first-run with the composer inline; loading =
 * skeleton rows; canvas-unreachable = a non-blocking banner over the cached
 * list. This page is a consumer surface by construction — it never branches on
 * profile; it simply *is* the home a profile with this nav reaches.
 */

import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useCanvasStore } from '../lib/use-canvas-store.js';
import { useServerStatus } from '../lib/server-status.js';
import {
  buildConversations,
  previewLine,
  type Conversation,
  type ConversationState,
} from '../lib/conversations.js';
import { spawnNode, RestError } from '../net/rest-compat.js';
import { handleComposerKeyDown } from '../lib/composer-keys.js';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { cn } from '@/lib/utils.js';

const STARTER_CHIPS = [
  'Research a topic for me',
  'Help me write something',
  'Review my code',
  'Plan a project',
];

export function ConversationsPage() {
  const { nodes, loading } = useCanvasStore();
  const reachable = useServerStatus((s) => s.reachable);
  const conversations = useMemo(() => buildConversations(nodes), [nodes]);
  const [composing, setComposing] = useState(false);
  const [searchParams] = useSearchParams();

  // The shared `startNewConversation` helper lands here with `?new` set; open
  // the composer. We deliberately DON'T clear the flag: clearing re-renders the
  // parent HomeRoute, and for a `views`-home audience (Studio) the second render
  // re-fires the views redirect and unmounts this page before the composer ever
  // shows (the M1 bug). Leaving `?new` in the URL is benign — a refresh simply
  // re-opens the composer, and spawning/canceling navigates away from it.
  useEffect(() => {
    if (searchParams.get('new') !== null) setComposing(true);
  }, [searchParams]);

  const showEmpty = !loading && conversations.length === 0;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-3xl flex-col px-6 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <h1
          className="text-3xl"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 460,
            letterSpacing: '-0.01em',
            color: 'var(--ink)',
          }}
        >
          Conversations
        </h1>
        {!showEmpty && !composing && (
          <Button size="lg" onClick={() => setComposing(true)}>
            + New chat
          </Button>
        )}
      </div>

      {!reachable && (
        <div className="mb-4 rounded-lg border px-4 py-2.5 text-sm" style={{ borderColor: 'rgba(255,94,54,.3)', background: 'var(--blk-dim)', color: 'var(--ink2)' }}>
          Couldn&apos;t reach your agents — retrying…
        </div>
      )}

      {(composing || showEmpty) && (
        <NewChatComposer
          firstRun={showEmpty}
          onCancel={showEmpty ? undefined : () => setComposing(false)}
        />
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <SkeletonRows />
        ) : (
          <ul className="flex flex-col gap-2.5">
            {conversations.map((c) => (
              <ConversationRow key={c.id} conversation={c} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New chat composer
// ---------------------------------------------------------------------------

function NewChatComposer({
  firstRun,
  onCancel,
}: {
  firstRun: boolean;
  onCancel?: () => void;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    const prompt = text.trim();
    if (!prompt || busy) return;
    setBusy(true);
    setError(null);
    try {
      // A conversation is a root node with the `crtr node new` defaults:
      // kind `general`, mode `base`, headless, first message as the prompt.
      const res = await spawnNode({ prompt, kind: 'general', mode: 'base', root: true });
      navigate(`/c/${encodeURIComponent(res.node_id)}`);
    } catch (err) {
      setError(err instanceof RestError ? err.message : String(err));
      setBusy(false);
    }
  };

  // Plain Enter starts the chat; Shift+Enter and Alt/Option+Enter insert a
  // newline (R1).
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    handleComposerKeyDown(e, setText, () => void submit());
  };

  return (
    <div className="panel mb-6 p-5">
      {firstRun && (
        <p className="mb-3 text-base" style={{ fontFamily: 'var(--font-display)', fontStyle: 'italic', color: 'var(--ink2)' }}>Start a conversation with an agent.</p>
      )}
      <Textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.currentTarget.value)}
        onKeyDown={onKeyDown}
        rows={3}
        disabled={busy}
        placeholder="What do you want help with?"
        className="resize-none border-0 bg-transparent px-0 text-base shadow-none focus-visible:ring-0"
      />
      <div className="mt-2 flex flex-wrap gap-2">
        {STARTER_CHIPS.map((chip) => (
          <button
            key={chip}
            type="button"
            disabled={busy}
            onClick={() => setText(chip)}
            className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-[color:var(--line2)] hover:text-foreground"
          >
            {chip}
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex items-center justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        <Button onClick={() => void submit()} disabled={busy || !text.trim()}>
          {busy ? 'Starting…' : 'Start chat'}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversation row
// ---------------------------------------------------------------------------

function ConversationRow({ conversation: c }: { conversation: Conversation }) {
  const navigate = useNavigate();
  return (
    <li className="list-none">
      <button
        type="button"
        onClick={() => navigate(`/c/${encodeURIComponent(c.id)}`)}
        className="panel flex w-full items-center gap-4 px-4 py-3.5 text-left transition-colors hover:bg-[color-mix(in_oklch,var(--ink)_3%,transparent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {c.state === 'needs-you' && (
              <span className="dot blocked shrink-0" aria-label="needs you" />
            )}
            <span className="truncate text-sm" style={{ fontWeight: 500, color: 'var(--ink)' }}>{c.title}</span>
          </div>
          <p className="mt-0.5 truncate text-sm" style={{ color: 'var(--mut)' }}>{previewLine(c)}</p>
        </div>
        <div
          className="flex shrink-0 items-center gap-3 text-xs"
          style={{ fontFamily: 'var(--font-inst)', letterSpacing: '0.04em', color: 'var(--mut)' }}
        >
          {c.cycles !== undefined && <span title="cycles">⟳ {c.cycles}</span>}
          <span title="nodes in this conversation">◦ {c.nodeCount} {c.nodeCount === 1 ? 'node' : 'nodes'}</span>
          <span title="time since last work">{relativeTime(c.lastActivity)}</span>
        </div>
        <StatePill state={c.state} />
      </button>
    </li>
  );
}

function StatePill({ state }: { state: ConversationState }) {
  // Map conversation state onto the QI badge/dot variants.
  const meta: Record<ConversationState, { label: string; variant: string }> = {
    'needs-you': { label: 'Needs you', variant: 'blocked' },
    active: { label: 'Active', variant: 'active' },
    idle: { label: 'Idle', variant: 'idle' },
    done: { label: 'Finished', variant: 'done' },
  };
  const m = meta[state];
  return (
    <span className={cn('badge shrink-0', m.variant)}>
      <span className={cn('dot', m.variant)} />
      {m.label}
    </span>
  );
}

function SkeletonRows() {
  return (
    <ul className="flex flex-col gap-2.5">
      {[0, 1, 2, 3].map((i) => (
        <li
          key={i}
          className="panel flex items-center gap-4 px-4 py-3.5"
        >
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-4 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted/70" />
          </div>
          <div className="h-6 w-16 animate-pulse rounded-full bg-muted" />
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}
