/**
 * Deck resolution flow (design §5.2) — ONE page rendering all five flows by deck
 * kind, both audiences. The kind comes straight from the humanloop data
 * (notify/validation/decision/context/error); each maps to a focused UI:
 *   notify     → read-and-dismiss card + context, single "Got it".
 *   validation → proposed action + full context, big Approve / Reject CTAs,
 *                optional comment.
 *   decision   → option cards (label + implication), pick one (or many where
 *                multiSelect), optional freetext.
 *   context    → a "why we need this" lead BEFORE a focused form.
 *   error      → plain-language explanation + recovery options; "take over"
 *                opens the conversation.
 * Approvals are meaningful, not rubber-stampable: each shows enough context to
 * decide; there is no blanket "approve all". Provenance is capability-gated
 * (DeckProvenance) — never a profile-name branch. A deck handled elsewhere
 * self-clears with the command's message; other load failures show a retry.
 */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, Check } from 'lucide-react';
import type { DeckAnswer, DeckDetail, DeckInteraction } from '@/shared/protocol.js';
import { getDeck, resolveDeck, isDeckGone } from '../lib/decks.js';
import { CommandError } from '../command-client.js';
import { renderMarkdown } from '../render/markdown.js';
import { sanitizeHtml } from '../render/sanitize.js';
import { deckKindMeta } from '../lib/deck-presentation.js';
import { DeckProvenance } from './inbox-page.js';
import { toast } from '../lib/toast.js';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { cn } from '@/lib/utils.js';

export function DeckPage({ deckId }: { deckId: string }) {
  const navigate = useNavigate();
  const [deck, setDeck] = useState<DeckDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [answers, setAnswers] = useState<Record<string, DeckAnswer>>({});
  const [busy, setBusy] = useState(false);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    let disposed = false;
    setDeck(null);
    setAnswers({});
    setLoadError(null);
    setBusy(false);
    setLoading(true);
    getDeck(deckId)
      .then((d) => {
        if (disposed) return;
        setDeck(d);
        setAnswers(Object.fromEntries(d.interactions.map((it) => [it.id, { id: it.id }])));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (disposed) return;
        if (isDeckGone(err)) {
          toast(err instanceof CommandError ? err.message : 'That request was already handled.');
          navigate('/inbox', { replace: true });
          return;
        }
        setLoadError(err instanceof Error ? err : new Error('Failed to load deck.'));
        setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [deckId, navigate, reloadNonce]);

  const setAnswer = (id: string, patch: Partial<DeckAnswer>): void =>
    setAnswers((prev) => ({ ...prev, [id]: { ...prev[id], id, ...patch } }));

  if (loading) return <DeckSkeleton />;
  if (loadError) {
    return (
      <DeckLoadError
        error={loadError}
        onRetry={() => setReloadNonce((n) => n + 1)}
        onBack={() => navigate('/inbox')}
      />
    );
  }
  if (!deck) return <DeckSkeleton />;

  const submit = async (override?: Record<string, DeckAnswer>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    const responses = Object.values(override ?? answers).map(({ selectedOptionId, ...rest }) => rest);
    try {
      await resolveDeck(deck.job_id, { responses });
      toast('Done — thanks!', 'success');
      navigate('/inbox', { replace: true });
    } catch (err) {
      if (isDeckGone(err)) {
        toast(err instanceof CommandError ? err.message : 'That request was already handled.');
        navigate('/inbox', { replace: true });
        return;
      }
      toast(err instanceof CommandError ? err.message : 'Something went wrong — try again.');
      setBusy(false);
    }
  };

  const single = deck.interactions.length === 1 ? deck.interactions[0]! : null;
  const Icon = deckKindMeta(deck.kind).icon;

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-2xl flex-col px-6 py-8">
      <button
        type="button"
        onClick={() => navigate('/inbox')}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Inbox
      </button>

      <header className="mb-5 flex items-start gap-3">
        <span
          className="mt-0.5 inline-flex size-10 shrink-0 items-center justify-center rounded-lg"
          style={{ border: '1px solid var(--line)', color: 'var(--ink2)', background: 'color-mix(in oklch, var(--ink) 4%, transparent)' }}
        >
          <Icon className="size-5" />
        </span>
        <div className="min-w-0">
          <h1 className="text-2xl" style={{ fontFamily: 'var(--font-display)', fontWeight: 460, letterSpacing: '-0.01em', color: 'var(--ink)' }}>{deck.title}</h1>
          {deck.subtitle && <p className="mt-0.5 text-sm" style={{ color: 'var(--mut)' }}>{deck.subtitle}</p>}
          <DeckProvenance deck={deck} className="mt-2" />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-6">
          {deck.interactions.map((it) => (
            <InteractionView
              key={it.id}
              interaction={it}
              answer={answers[it.id] ?? { id: it.id }}
              onChange={(patch) => setAnswer(it.id, patch)}
              conversationId={deck.conversation_id}
              busy={busy}
              // Single validation/notify decks resolve straight from their CTA.
              onResolveWith={single ? (a) => void submit({ [it.id]: a }) : undefined}
            />
          ))}
        </div>
      </div>

      {/* The shared submit — hidden for a lone notify/validation deck whose CTA
          resolves directly; shown for decisions, context, multi-question decks. */}
      {!isDirectResolve(single) && (
        <footer className="mt-6 flex shrink-0 items-center justify-end gap-2 border-t border-border pt-4">
          <Button variant="ghost" onClick={() => navigate('/inbox')} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !canSubmit(deck, answers)}>
            {busy ? 'Sending…' : 'Submit'}
          </Button>
        </footer>
      )}
    </div>
  );
}

function DeckLoadError({
  error,
  onRetry,
  onBack,
}: {
  error: Error;
  onRetry: () => void;
  onBack: () => void;
}) {
  return (
    <div className="mx-auto flex h-full min-h-0 max-w-2xl flex-col justify-center px-6 py-8">
      <section className="panel p-5">
        <h1 className="text-lg font-semibold">Couldn’t load the deck</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-4 flex gap-2">
          <Button onClick={onRetry}>Retry</Button>
          <Button variant="ghost" onClick={onBack}>Back to inbox</Button>
        </div>
      </section>
    </div>
  );
}

/** A lone notify or validation deck resolves directly from its in-card CTA, so
 *  the shared footer Submit is suppressed. */
function isDirectResolve(single: DeckInteraction | null): boolean {
  return single !== null && (single.kind === 'notify' || single.kind === 'validation');
}

/** Decision/context need at least a selection or freetext before Submit enables. */
function canSubmit(deck: DeckDetail, answers: Record<string, DeckAnswer>): boolean {
  return deck.interactions.every((it) => {
    const a = answers[it.id];
    if (!a) return false;
    if (it.kind === 'notify' || it.kind === 'error') return true;
    const hasPick = !!a.selectedOptionIds?.length || !!a.freetext?.trim();
    // A context/decision interaction with neither options nor freetext is a bare
    // acknowledgement — always submittable.
    if (it.options.length === 0 && !it.allowFreetext) return true;
    return hasPick;
  });
}

// ---------------------------------------------------------------------------
// Per-interaction views
// ---------------------------------------------------------------------------

function InteractionView({
  interaction: it,
  answer,
  onChange,
  conversationId,
  busy,
  onResolveWith,
}: {
  interaction: DeckInteraction;
  answer: DeckAnswer;
  onChange: (patch: Partial<DeckAnswer>) => void;
  conversationId: string;
  busy: boolean;
  onResolveWith?: (answer: DeckAnswer) => void;
}) {
  switch (it.kind) {
    case 'notify':
      return <NotifyView interaction={it} onGotIt={() => onResolveWith?.({ id: it.id })} direct={!!onResolveWith} />;
    case 'validation':
      return (
        <ValidationView
          interaction={it}
          answer={answer}
          onChange={onChange}
          busy={busy}
          onResolveWith={onResolveWith}
        />
      );
    case 'context':
      return <ContextView interaction={it} answer={answer} onChange={onChange} />;
    case 'error':
      return <ErrorView interaction={it} answer={answer} onChange={onChange} conversationId={conversationId} />;
    case 'decision':
    default:
      return <DecisionView interaction={it} answer={answer} onChange={onChange} />;
  }
}

/** Rendered markdown body (the proposed action / context / explanation). */
function Body({ body }: { body?: string }) {
  if (!body) return null;
  return (
    <div
      className="prose prose-sm max-w-none text-sm text-foreground/85 dark:prose-invert"
      dangerouslySetInnerHTML={{ __html: sanitizeHtml(renderMarkdown(body)) }}
    />
  );
}

function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return <section className={cn('panel p-5', className)}>{children}</section>;
}

function InteractionTitle({ it }: { it: DeckInteraction }) {
  return (
    <div className="mb-3">
      <h2 className="text-base font-semibold">{it.title}</h2>
      {it.subtitle && <p className="mt-0.5 text-sm text-muted-foreground">{it.subtitle}</p>}
    </div>
  );
}

// --- notify -----------------------------------------------------------------

function NotifyView({
  interaction: it,
  onGotIt,
  direct,
}: {
  interaction: DeckInteraction;
  onGotIt: () => void;
  direct: boolean;
}) {
  return (
    <Card>
      <InteractionTitle it={it} />
      <Body body={it.body} />
      {direct && (
        <div className="mt-4 flex justify-end">
          <Button onClick={onGotIt}>
            <Check className="mr-1.5 size-4" /> Got it
          </Button>
        </div>
      )}
    </Card>
  );
}

// --- validation -------------------------------------------------------------

function ValidationView({
  interaction: it,
  answer,
  onChange,
  busy,
  onResolveWith,
}: {
  interaction: DeckInteraction;
  answer: DeckAnswer;
  onChange: (patch: Partial<DeckAnswer>) => void;
  busy: boolean;
  onResolveWith?: (answer: DeckAnswer) => void;
}) {
  // Map the deck's options onto Approve / Reject. humanloop's approve decks use
  // ids yes/no; fall back to option order for any other validation shape.
  const yes = it.options.find((o) => o.id === 'yes') ?? it.options[0];
  const no = it.options.find((o) => o.id === 'no') ?? it.options[1];
  const choose = (optionId: string): void => {
    const next: DeckAnswer = { ...answer, id: it.id, selectedOptionIds: [optionId] };
    if (onResolveWith) onResolveWith(next);
    else onChange({ selectedOptionIds: [optionId], selectedOptionId: undefined });
  };
  return (
    <Card>
      <InteractionTitle it={it} />
      <Body body={it.body} />
      <div className="mt-4 flex flex-col gap-3">
        <Textarea
          rows={2}
          value={answer.freetext ?? ''}
          onChange={(e) => onChange({ freetext: e.currentTarget.value })}
          placeholder={it.freetextLabel ?? 'Add a comment (optional)'}
          className="resize-none text-sm"
        />
        <div className="flex gap-3">
          <Button
            className="flex-1"
            size="lg"
            disabled={busy}
            onClick={() => yes && choose(yes.id)}
          >
            {yes?.label ?? 'Approve'}
          </Button>
          <Button
            className="flex-1"
            size="lg"
            variant="outline"
            disabled={busy}
            onClick={() => no && choose(no.id)}
          >
            {no?.label ?? 'Reject'}
          </Button>
        </div>
        {!onResolveWith && answer.selectedOptionIds?.[0] && (
          <p className="text-xs text-muted-foreground">
            Selected: {it.options.find((o) => o.id === answer.selectedOptionIds?.[0])?.label}
          </p>
        )}
      </div>
    </Card>
  );
}

// --- decision ---------------------------------------------------------------

function DecisionView({
  interaction: it,
  answer,
  onChange,
}: {
  interaction: DeckInteraction;
  answer: DeckAnswer;
  onChange: (patch: Partial<DeckAnswer>) => void;
}) {
  const selectedIds = new Set(answer.selectedOptionIds ?? []);
  const toggle = (optionId: string): void => {
    if (it.multiSelect) {
      const next = new Set(selectedIds);
      next.has(optionId) ? next.delete(optionId) : next.add(optionId);
      onChange({ selectedOptionIds: [...next], selectedOptionId: undefined });
    } else {
      onChange({ selectedOptionIds: [optionId], selectedOptionId: undefined });
    }
  };
  return (
    <Card>
      <InteractionTitle it={it} />
      <Body body={it.body} />
      <ul className="mt-4 flex flex-col gap-2">
        {it.options.map((o) => {
          const active = selectedIds.has(o.id);
          return (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => toggle(o.id)}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                  active
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-primary/40 hover:bg-accent/40',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center border',
                    it.multiSelect ? 'rounded' : 'rounded-full',
                    active ? 'border-primary bg-primary text-primary-foreground' : 'border-muted-foreground/40',
                  )}
                >
                  {active && <Check className="size-3" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{o.label}</span>
                  {o.description && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {it.allowFreetext && (
        <Textarea
          rows={2}
          value={answer.freetext ?? ''}
          onChange={(e) => onChange({ freetext: e.currentTarget.value })}
          placeholder={it.freetextLabel ?? 'Anything else? (optional)'}
          className="mt-3 resize-none text-sm"
        />
      )}
    </Card>
  );
}

// --- context ----------------------------------------------------------------

function ContextView({
  interaction: it,
  answer,
  onChange,
}: {
  interaction: DeckInteraction;
  answer: DeckAnswer;
  onChange: (patch: Partial<DeckAnswer>) => void;
}) {
  const selected = answer.selectedOptionIds?.[0];
  return (
    <Card>
      <InteractionTitle it={it} />
      {/* Why we need this — shown BEFORE the field (agentic-ux). */}
      {it.body && (
        <div className="mb-4 rounded-xl border border-border p-3" style={{ background: 'color-mix(in oklch, var(--ink) 3%, transparent)' }}>
          <p className="instlabel mb-1.5">
            Why we&apos;re asking
          </p>
          <Body body={it.body} />
        </div>
      )}
      {it.options.length > 0 && (
        <ul className="mb-3 flex flex-col gap-2">
          {it.options.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                onClick={() => onChange({ selectedOptionIds: [o.id], selectedOptionId: undefined })}
                className={cn(
                  'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
                  selected === o.id
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-primary/40 hover:bg-accent/40',
                )}
              >
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{o.label}</span>
                  {o.description && (
                    <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {(it.allowFreetext || it.options.length === 0) && (
        <Textarea
          autoFocus
          rows={3}
          value={answer.freetext ?? ''}
          onChange={(e) => onChange({ freetext: e.currentTarget.value })}
          placeholder={it.freetextLabel ?? 'Your answer'}
          className="resize-none text-sm"
        />
      )}
    </Card>
  );
}

// --- error ------------------------------------------------------------------

function ErrorView({
  interaction: it,
  answer,
  onChange,
  conversationId,
}: {
  interaction: DeckInteraction;
  answer: DeckAnswer;
  onChange: (patch: Partial<DeckAnswer>) => void;
  conversationId: string;
}) {
  const navigate = useNavigate();
  return (
    <Card className="border-destructive/30">
      <InteractionTitle it={it} />
      <Body body={it.body} />
      <div className="mt-4 flex flex-col gap-2">
        {it.options.map((o) => (
          <button
            key={o.id}
            type="button"
            onClick={() => onChange({ selectedOptionIds: [o.id], selectedOptionId: undefined })}
            className={cn(
              'flex w-full items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors',
              answer.selectedOptionIds?.[0] === o.id
                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                : 'border-border hover:border-primary/40 hover:bg-accent/40',
            )}
          >
            <span className="min-w-0">
              <span className="block text-sm font-medium">{o.label}</span>
              {o.description && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{o.description}</span>
              )}
            </span>
          </button>
        ))}
        {/* Take over → open the conversation to drive it directly. */}
        <button
          type="button"
          onClick={() => navigate(`/c/${encodeURIComponent(conversationId)}`)}
          className="flex w-full items-center gap-2 rounded-xl border border-border px-4 py-3 text-left text-sm font-medium transition-colors hover:border-primary/40 hover:bg-accent/40"
        >
          Take over — open the conversation
        </button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------

function DeckSkeleton() {
  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col gap-5 px-6 py-8">
      <div className="h-4 w-16 animate-pulse rounded bg-muted" />
      <div className="h-7 w-1/2 animate-pulse rounded bg-muted" />
      <div className="h-40 w-full animate-pulse rounded-2xl bg-muted/60" />
    </div>
  );
}
