/**
 * Findings panel for the view host (design §7 "View Grid"). Renders an
 * agent-authored markdown body inside a raised panel with the Quiet Instrument
 * "findings" treatment: zero-padded instrument counters down the margin, an
 * optional `final` chip in the header, and a mono source footer.
 *
 * The markdown is arbitrary HTML, so the counter/typography styling is applied
 * via a scoped stylesheet (`.qi-findings`) injected once — index.css is owned by
 * the foundation phase and must not be touched here. Ported verbatim from the
 * mockup `.findings` rules.
 */

const FINDINGS_CSS = `
.qi-findings { padding: 18px 20px; display: flex; flex-direction: column; }
.qi-findings .qi-t {
  font-size: 13.5px; font-weight: 600; margin-bottom: 13px;
  display: flex; align-items: center; gap: 9px; color: var(--ink);
}
.qi-findings .qi-t .chip { margin-left: auto; }
.qi-findings .qi-body { flex: 1; }
.qi-findings h1, .qi-findings h2 {
  font-family: var(--font-display); font-size: 15px; font-weight: 500;
  line-height: 1.3; margin-bottom: 13px; color: var(--ink);
}
.qi-findings ol, .qi-findings ul { list-style: none; counter-reset: f; margin: 0; padding: 0; }
.qi-findings li {
  counter-increment: f; position: relative;
  padding: 0 0 14px 38px; font-size: 12.5px; line-height: 1.6; color: var(--ink2);
}
.qi-findings li::before {
  content: counter(f, decimal-leading-zero);
  position: absolute; left: 0; top: 1px;
  font-family: var(--font-inst); font-size: 10px; color: var(--dim);
  border: 1px solid var(--line2); border-radius: 6px; padding: 3px 6px;
}
.qi-findings li b, .qi-findings li strong { color: var(--ink); font-weight: 600; }
.qi-findings p { font-size: 12.5px; line-height: 1.6; color: var(--ink2); margin-bottom: 10px; }
.qi-findings .qi-src {
  border-top: 1px solid var(--line); padding-top: 11px; margin-top: 4px;
  font-family: var(--font-code); font-size: 10px; color: var(--dim);
}
`;

if (typeof document !== 'undefined' && !document.getElementById('qi-findings-style')) {
  const el = document.createElement('style');
  el.id = 'qi-findings-style';
  el.textContent = FINDINGS_CSS;
  document.head.appendChild(el);
}

export function FindingsList({
  html,
  title,
  chip,
  sourcePath,
}: {
  html: string;
  title?: string;
  chip?: string;
  sourcePath?: string;
}): React.ReactElement {
  return (
    <div className="panel qi-findings">
      {(title || chip) && (
        <div className="qi-t">
          {title}
          {chip && <span className="chip ok">{chip}</span>}
        </div>
      )}
      <div className="qi-body" dangerouslySetInnerHTML={{ __html: html }} />
      {sourcePath && <div className="qi-src">source · {sourcePath}</div>}
    </div>
  );
}
