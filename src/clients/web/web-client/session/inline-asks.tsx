/**
 * Inline asks in the conversation view (design §4.3/§5.1). When a node anywhere
 * in a conversation's sub-DAG raises a human ask, it surfaces right here in the
 * conversation — "Your agent needs a decision →" — tagged by conversation,
 * never by node id (Studio). Simple kinds (notify/validation) resolve inline;
 * complex kinds (decision/context/error) deep-link into the Inbox flow. Decks
 * are matched by conversation_id (the spine root), so this is correct for both
 * the Studio conversation and an Operator viewing a root node — no profile
 * branch.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Check } from 'lucide-react';
import type { DeckAnswer, DeckSummary } from '@/shared/protocol.js';
import { useConversationDecks, useDecks } from '../lib/use-decks.js';
import { resolveDeck, getDeck, RestError } from '../net/rest-compat.js';
import { deckKindMeta } from '../lib/deck-presentation.js';
import { toast } from '../lib/toast.js';
import { Button } from '@/components/ui/button.js';

const PROMPT: Record<DeckSummary['kind'], string> = {
  notify: 'Your agent has an update',
  validation: 'Your agent needs your approval',
  decision: 'Your agent needs a decision',
  context: 'Your agent needs more from you',
  error: 'Your agent hit a problem',
};

export function InlineAsks({ conversationId }: { conversationId: string }) {
  const decks = useConversationDecks(conversationId);
  if (decks.length === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-b border-primary/20 bg-primary/5 px-4 py-3">
      {decks.map((d) => (
        <InlineAsk key={d.id} deck={d} />
      ))}
    </div>
  );
}

function InlineAsk({ deck }: { deck: DeckSummary }) {
  const navigate = useNavigate();
  const { refetch } = useDecks();
  const [busy, setBusy] = useState(false);
  const Icon = deckKindMeta(deck.kind).icon;
  const simple = deck.kind === 'notify' || deck.kind === 'validation';

  // Inline resolve for simple kinds: fetch the deck to learn the option ids,
  // then write the answer back without leaving the conversation.
  const resolveInline = async (choice: 'ack' | 'yes' | 'no'): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const full = await getDeck(deck.job_id);
      const it = full.interactions[0]!;
      const answer: DeckAnswer =
        choice === 'ack'
          ? { id: it.id }
          : {
              id: it.id,
              selectedOptionId:
                (choice === 'yes'
                  ? it.options.find((o) => o.id === 'yes')?.id ?? it.options[0]?.id
                  : it.options.find((o) => o.id === 'no')?.id ?? it.options[1]?.id) ?? choice,
            };
      const responses: DeckAnswer[] = [
        answer.selectedOptionIds !== undefined
          ? answer
          : answer.selectedOptionId !== undefined
            ? { ...answer, selectedOptionIds: [answer.selectedOptionId] }
            : answer,
      ];
      await resolveDeck(deck.job_id, { responses });
      toast('Done — thanks!', 'success');
      refetch();
    } catch (err) {
      if (err instanceof RestError && (err.code === 'deck_already_resolved' || err.code === 'deck_not_found')) {
        toast('That request was already handled.');
        refetch();
        return;
      }
      toast('Something went wrong — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{PROMPT[deck.kind] ?? PROMPT.context}</p>
        <p className="truncate text-xs text-muted-foreground">{deck.title}</p>
      </div>
      {deck.kind === 'notify' && (
        <Button size="sm" disabled={busy} onClick={() => void resolveInline('ack')}>
          <Check className="mr-1 size-3.5" /> Got it
        </Button>
      )}
      {deck.kind === 'validation' && (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy} onClick={() => void resolveInline('yes')}>
            Approve
          </Button>
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void resolveInline('no')}>
            Reject
          </Button>
        </div>
      )}
      {!simple && (
        <Button
          size="sm"
          variant="secondary"
          onClick={() => navigate(`/inbox/${encodeURIComponent(deck.job_id)}`)}
        >
          Review <ArrowRight className="ml-1 size-3.5" />
        </Button>
      )}
    </div>
  );
}
