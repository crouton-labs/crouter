/**
 * KPI cards for the view host (design §7 "KPI Cards"). A four-up grid of raised
 * panels, each a Martian-Mono micro-label over a large value (instrument numerals
 * for figures, Fraunces italic for prose values) plus an optional sub-line.
 * Ported verbatim from the Quiet Instrument mockup `.kpis` / `.kpi`.
 */

export interface KpiItem {
  label: string;
  value: string;
  unit?: string;
  sub?: string;
}

/** Heuristic: a value that doesn't begin with a digit or $ reads as prose, so it
 *  gets the Fraunces treatment (`.kv.txt`) instead of instrument numerals. */
function isTextValue(value: string): boolean {
  return !/^[\d$]/.test(value.trim());
}

export function KpiGrid({ items }: { items: KpiItem[] }): React.ReactElement {
  return (
    <div
      className="grid"
      style={{ gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px', marginBottom: '14px' }}
    >
      {items.map((item, i) => (
        <KpiCard key={i} item={item} />
      ))}
    </div>
  );
}

export function KpiCard({ item }: { item: KpiItem }): React.ReactElement {
  const txt = isTextValue(item.value);
  return (
    <div className="panel" style={{ padding: '16px 18px 14px' }}>
      <span className="instlabel">{item.label}</span>
      <div
        className={`mt-2 ${txt ? 'text-lg' : 'text-xl'}`}
        style={
          txt
            ? {
                fontFamily: 'var(--font-display)',
                fontStyle: 'italic',
                fontWeight: 480,
                letterSpacing: 0,
                color: 'var(--ink)',
              }
            : {
                fontFamily: 'var(--font-inst)',
                fontWeight: 600,
                letterSpacing: '0.01em',
                color: 'var(--ink)',
              }
        }
      >
        {item.value}
        {item.unit && (
          <span className="text-xs" style={{ color: 'var(--mut)', fontWeight: 400 }}>{item.unit}</span>
        )}
      </div>
      {item.sub && (
        <div className="mt-1 text-xs" style={{ color: 'var(--mut)' }}>{item.sub}</div>
      )}
    </div>
  );
}
