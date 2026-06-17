/**
 * Renders an array of ViewBlock[] — the typed content blocks within a view tab.
 * Three block kinds: kpis, barlist, markdown. Layout follows the Quiet Instrument
 * view host (design §7): KPIs span full width, then a barlist (chart panel) and a
 * markdown body (findings panel) pair side-by-side in a 7fr/5fr grid.
 */

import { useMemo } from 'react';
import type { ViewBlock } from '@/shared/protocol.js';
import { renderMarkdown } from '../render/markdown.js';
import { KpiGrid } from '../components/kpi-card.js';
import { FindingsList } from '../components/findings-list.js';

export function BlockRenderer({ blocks }: { blocks: ViewBlock[] }): React.ReactElement {
  const kpiBlocks = blocks.filter((b) => b.kind === 'kpis');
  const gridBlocks = blocks.filter((b) => b.kind === 'barlist' || b.kind === 'markdown');
  const paired = gridBlocks.length >= 2;

  return (
    <div>
      {kpiBlocks.map((block, i) =>
        block.kind === 'kpis' ? <KpiGrid key={i} items={block.items} /> : null,
      )}

      {gridBlocks.length > 0 && (
        <div
          style={
            paired
              ? { display: 'grid', gridTemplateColumns: '7fr 5fr', gap: '12px' }
              : { display: 'flex', flexDirection: 'column', gap: '12px' }
          }
        >
          {gridBlocks.map((block, i) => {
            if (block.kind === 'barlist') return <BarListBlock key={i} block={block} />;
            if (block.kind === 'markdown') return <MarkdownBlock key={i} block={block} />;
            return null;
          })}
        </div>
      )}
    </div>
  );
}

// ─── Bar list (chart panel) ──────────────────────────────────────────────────

function BarListBlock({
  block,
}: {
  block: Extract<ViewBlock, { kind: 'barlist' }>;
}): React.ReactElement {
  const { title, rows } = block;
  const maxVal = Math.max(...rows.map((r) => r.max ?? r.value), 1);

  return (
    <div className="panel" style={{ padding: '18px 20px 16px' }}>
      {/* chart-cap */}
      <div className="flex items-baseline" style={{ gap: '10px', marginBottom: '18px' }}>
        <span className="text-sm font-semibold" style={{ color: 'var(--ink)' }}>{title}</span>
      </div>

      {/* bars */}
      <div className="flex flex-col" style={{ gap: '11px' }}>
        {rows.map((row, i) => {
          const pct = Math.min(100, Math.round((row.value / maxVal) * 100));
          const top = i === 0;
          return (
            <div
              key={i}
              className="grid items-center"
              style={{ gridTemplateColumns: '158px 1fr 52px', gap: '12px' }}
            >
              {/* label */}
              <span
                className="truncate text-xs"
                style={{ color: 'var(--ink2)' }}
              >
                {row.label}
                {row.note && (
                  <em className="text-xs" style={{ fontStyle: 'normal', color: 'var(--dim)', marginLeft: '6px' }}>
                    {row.note}
                  </em>
                )}
              </span>

              {/* track */}
              <div
                className="relative overflow-hidden"
                style={{
                  height: '14px',
                  borderRadius: '4px',
                  background: 'color-mix(in oklch, var(--ink) 5%, transparent)',
                }}
              >
                <div
                  className="absolute inset-y-0 left-0"
                  style={{
                    width: `${pct}%`,
                    borderRadius: '4px',
                    background: top
                      ? 'linear-gradient(90deg, var(--act), color-mix(in oklch, var(--act) 50%, transparent))'
                      : 'linear-gradient(90deg, color-mix(in oklch, var(--ink) 28%, transparent), color-mix(in oklch, var(--ink) 16%, transparent))',
                  }}
                />
              </div>

              {/* value */}
              <span
                className="tabular-nums text-xs"
                style={{
                  fontFamily: 'var(--font-inst)',
                  textAlign: 'right',
                  color: top ? 'var(--act)' : 'var(--mut)',
                }}
              >
                {row.value}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Markdown block (findings panel) ─────────────────────────────────────────

/** Split a leading markdown heading off the body so the findings panel can host
 *  it in the cap row (with the status chip) instead of inside the prose. */
function splitLeadingHeading(text: string): { title?: string; body: string } {
  const m = text.match(/^\s*#{1,6}\s+(.+?)\s*(?:\n|$)/);
  if (!m) return { body: text };
  return { title: m[1], body: text.slice(m[0].length) };
}

function MarkdownBlock({
  block,
}: {
  block: Extract<ViewBlock, { kind: 'markdown' }>;
}): React.ReactElement {
  const src = block.source;
  const text = 'inline' in src ? src.inline : '';
  const sourcePath = 'path' in src ? src.path : undefined;

  // The QI findings panel hoists the body's leading heading into the cap row
  // (where the status chip lives) and renders only the list/prose beneath it.
  // Lift a leading `# …`/`## …` line into the title so it isn't duplicated.
  const { title, body } = useMemo(() => splitLeadingHeading(text), [text]);
  const html = useMemo(() => renderMarkdown(body), [body]);

  // Report files are named `<ts>-<kind>.md`; surface that kind as the panel's
  // status chip (e.g. `…-final.md` → FINAL), matching the QI findings mockup.
  const chip = sourcePath?.match(/-([a-z]+)\.md$/i)?.[1];

  return <FindingsList html={html} title={title} chip={chip} sourcePath={sourcePath} />;
}
