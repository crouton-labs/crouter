/**
 * Thinking content block (spec C.5 / AC-8, design contract §4).
 *
 * Visually distinct collapsible block, separate from assistant text. The Detail
 * level (§4) sets its default posture: `focused` keeps it to a terse collapsed
 * disclosure line, `standard` is the collapsed `Thinking` disclosure, `verbose`
 * shows it inline expanded. While streaming it always auto-expands so progress
 * is visible. The body shows the growing `thinking` text as escaped plain text
 * (no markdown; escaping keeps embedded markup inert).
 */

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { escapeText } from '../render/sanitize.js';
import { useTranscriptDetail } from '../lib/transcript-detail.js';

export interface ThinkingBlockProps {
  thinking: string;
  /** True while still streaming — auto-expands so progress is visible. */
  inProgress: boolean;
}

export function ThinkingBlock({ thinking, inProgress }: ThinkingBlockProps) {
  const detail = useTranscriptDetail();
  const [open, setOpen] = useState(false);
  // Verbose shows thinking inline by default; while streaming we always reveal;
  // the user toggle still wins thereafter. `focused` uses a terser label.
  const bodyVisible = inProgress || open || detail === 'verbose';
  const label = detail === 'focused' ? 'Thought' : 'Thinking';

  return (
    <div className={cn('thinking', bodyVisible && 'open')}>
      <div className="think-toggle" onClick={() => setOpen((v) => !v)}>
        <ChevronDown className={cn('size-3.5 transition-transform', !bodyVisible && '-rotate-90')} />
        {label}{inProgress ? '…' : ''}
      </div>
      <div
        className="think-body whitespace-pre-wrap"
        dangerouslySetInnerHTML={{ __html: escapeText(thinking) }}
      />
    </div>
  );
}
