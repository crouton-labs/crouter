/**
 * Instrument HUD overlay — the telemetry panel for the console's `.cluster`
 * readings (context-% + cost gauges, msgs/tokens/tools dials). The mockup
 * console has no always-on instrument band, so the readings live in a
 * dismissible HUD: default hidden, toggled by ⌥i, dismissed by Esc or a click
 * outside. The toggle is suppressed while the composer textarea is focused so
 * typing never summons it. Styled with the same `.cluster`/`.gauge`/`.dial`
 * atoms, floated in a `.panel` and entranced with the `rise` keyframe.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { ChromePanel, type ChromeBarStore } from './chrome-bar.js';
import type { NodeDetail } from '@/shared/protocol.js';

/** Single source of truth for the HUD toggle chord — `⌥i` (Option/Alt + I).
 *  Matched on `code` (layout-stable) so the macOS Option-dead-key never bites. */
export const INSTRUMENT_TOGGLE_CODE = 'KeyI';

export function InstrumentOverlay(props: {
  store: ChromeBarStore;
  detail: NodeDetail | null;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (e.altKey && e.code === INSTRUMENT_TOGGLE_CODE) {
        // Never fire while the composer textarea has focus — typing must win.
        if (document.activeElement instanceof HTMLTextAreaElement) return;
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!open) return null;

  return (
    <div
      className="in fixed inset-0 z-50 flex items-start justify-center pt-22"
      style={{ background: 'rgba(0,0,0,.42)', backdropFilter: 'blur(2px)' }}
      onMouseDown={(e) => {
        if (!panelRef.current?.contains(e.target as Node)) setOpen(false);
      }}
    >
      <div ref={panelRef} className="panel rv" style={PANEL}>
        <div style={HEAD}>
          <span className="instlabel">Instruments</span>
          <div style={{ flex: 1 }} />
          <span className="kbd">⌥i</span>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="transition-colors"
            style={{ color: 'var(--mut)' }}
            aria-label="Close instruments"
          >
            <X className="size-3.5" />
          </button>
        </div>
        <ChromePanel store={props.store} detail={props.detail} />
      </div>
    </div>
  );
}

const PANEL: CSSProperties = {
  minWidth: 'min(680px, 92vw)',
  overflow: 'hidden',
  ['--i' as string]: 0,
};

const HEAD: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  padding: '11px 30px',
  borderBottom: '1px solid var(--line)',
};
