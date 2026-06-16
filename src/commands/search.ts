// `crtr search` subtree — web search for agents, backed by the Exa API. Three
// leaves: web (find pages), answer (one grounded cited answer), contents
// (extract from URLs you already have). API key resolves from EXA_API_KEY or
// ~/.crouter/exa.key (see ./search/exa.ts).

import { defineBranch } from '../core/command.js';
import type { BranchDef } from '../core/command.js';
import { webLeaf } from './search/web.js';
import { answerLeaf } from './search/answer.js';
import { contentsLeaf } from './search/contents.js';

export function registerSearch(): BranchDef {
  return defineBranch({
    name: 'search',
    rootEntry: {
      concept: 'web search for agents — find pages, get grounded answers, extract page content (Exa)',
      desc: 'search the web, answer a question with citations, or extract content from known URLs',
      useWhen:
        'you need information from the live web — current events, documentation, sources, facts beyond your training. `crtr search web "<query>"` finds relevant pages with excerpts; `crtr search answer "<question>"` returns one synthesized, cited answer; `crtr search contents <url>` extracts clean content from URLs you already hold. Needs an Exa API key (EXA_API_KEY or ~/.crouter/exa.key).',
    },
    help: {
      name: 'search',
      summary: 'web search via the Exa API — find pages, answer questions with citations, extract page content',
      model:
        'Three leaves split by what you have and what you want. `web` is the default: a query in, ranked pages out with query-relevant highlight excerpts (or full text with --text) — use it for discovery and research. `answer` collapses a question into one synthesized, source-cited answer — use it when you want the conclusion, not a reading list. `contents` does no searching; it extracts cleaned content from URLs you already hold. Highlights are the default content mode everywhere (token-predictable); full text is opt-in and length-capped. Every leaf needs an Exa API key from EXA_API_KEY or ~/.crouter/exa.key.',
    },
    children: [webLeaf, answerLeaf, contentsLeaf],
  });
}
