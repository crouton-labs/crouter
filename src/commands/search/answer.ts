import { defineLeaf } from '../../core/command.js';
import { exaAnswer } from './exa.js';

interface Citation { title?: string; url?: string }

export const answerLeaf = defineLeaf({
  name: 'answer',
  description: 'get one grounded, cited answer to a question',
  whenToUse:
    'you have a specific question and want a single synthesized answer grounded in sources, rather than a ranked list of pages to read yourself. Best for factual lookups and "what/who/when" questions where you want the conclusion plus its citations. Reach for `web` instead when you want to browse and judge the raw results, or when the task is open-ended research rather than one answerable question.',
  help: {
    name: 'search answer',
    summary: 'grounded answer via Exa — one synthesized natural-language answer plus the sources it cites',
    params: [
      { kind: 'positional', name: 'question', required: true, constraint: 'The question to answer. Natural language; phrase it as a question.' },
    ],
    output: [
      { name: 'answer', type: 'string', required: true, constraint: 'The synthesized natural-language answer grounded in the cited sources.' },
      { name: 'citations', type: 'object[]', required: true, constraint: 'The sources the answer draws on, each: title and url.' },
      { name: 'follow_up', type: 'string', required: true, constraint: 'Concrete next command — read a citation in full, or fall back to raw results.' },
    ],
    outputKind: 'object',
    effects: ['Sends one answer request to the Exa API (network). No local state changes.'],
  },
  run: async (input) => {
    const question = input['question'] as string;
    const res = await exaAnswer({ query: question });
    return {
      answer: res.answer ?? '',
      citations: res.citations ?? [],
      follow_up:
        'Read any cited source in full with `crtr search contents <url>`. Want raw ranked results instead of a synthesized answer? Use `crtr search web`.',
    };
  },
  render: (result) => {
    const answer = result['answer'] as string;
    const citations = result['citations'] as Citation[];
    const followUp = result['follow_up'] as string;

    if (answer.trim() === '') {
      return `No answer was returned.\n\n${followUp}`;
    }

    const lines = [answer.trim(), ''];
    if (citations.length > 0) {
      lines.push(`Sources (${citations.length}):`);
      citations.forEach((c, i) => {
        const title = c.title !== undefined && c.title !== '' ? c.title : '(untitled)';
        const url = c.url !== undefined ? ` — ${c.url}` : '';
        lines.push(`${i + 1}. ${title}${url}`);
      });
      lines.push('');
    }
    lines.push(followUp);
    return lines.join('\n');
  },
});
