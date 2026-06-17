/**
 * Per-node chrome. TitleBar = console identity (Fraunces name + status badge),
 * the `header` slot of the con-head (no capability — always present); it is kept
 * mockup-clean (no kind/mode/lifecycle meta). ChromePanel = the instrument
 * cluster (context-% and cost gauges + turns/msgs/tokens/tools dials), now
 * floated in the ⌥i HUD (see instrument-overlay.tsx) rather than an always-on
 * band. Identity comes from the page-fetched node detail; the gauges come from
 * the session store's server-pushed chrome + state (D12 — rendered, never
 * computed from raw events).
 * A dormant view (source==='static') is marked "last-known" and omits the
 * live-only readings (context %, tool activity, stats) per F.4.
 */

import type { ComponentType, ReactNode } from 'react';
import {
  AlertCircle,
  Circle,
  CircleCheck,
  CircleSlash,
  Loader,
  XCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.js';
import type { BrokerStatus, NodeDetail, SessionState } from '@/shared/protocol.js';
import type { NodeChrome } from '../store/session-store.js';
import { useCapability } from '../profile/provider.js';

/** §5 status map — a 14px lucide glyph per live status, carried in the badge
 *  (the con-head has no spine, so the glyph + word is the status carrier). */
const STATUS_GLYPH: Record<string, ComponentType<{ className?: string }>> = {
  active: Loader,
  idle: Circle,
  done: CircleCheck,
  dead: CircleSlash,
  canceled: XCircle,
  blocked: AlertCircle,
};

function StatusGlyph({ status }: { status: string }): ReactNode {
  const Glyph = STATUS_GLYPH[status] ?? Circle;
  return <Glyph className={cn('!size-3.5', status === 'active' && 'animate-spin')} />;
}

/** React-compatible subset of the session store — plain values, not signal accessors. */
export interface ChromeBarStore {
  chrome: NodeChrome;
  state: SessionState | null;
  source: 'broker' | 'static';
  brokerStatus: BrokerStatus;
}

/**
 * The status pill is derived from the LIVE connection/broker state, not the
 * (possibly stale) DB row carried on `detail`. After a revive the DB row can
 * still read "canceled"/"done" for a beat while the broker is already live;
 * deriving from `source`/`brokerStatus`/streaming keeps the pill honest.
 */
function livePillStatus(
  d: NodeDetail,
  source: 'broker' | 'static',
  brokerStatus: BrokerStatus,
  streaming: boolean,
): string {
  if (source === 'static') return d.status; // dormant — last-known DB row
  if (brokerStatus === 'down') return 'dead';
  if (brokerStatus === 'reconnecting') return 'idle';
  return streaming ? 'active' : 'idle'; // live broker — reflect live activity
}

/**
 * Status as a single plain-language word (Studio slim header). Derived from the
 * LIVE connection/broker state, not the (possibly stale) DB row — same honesty
 * rule as `livePillStatus`, just worded softly for a consumer.
 */
function statusWord(
  d: NodeDetail,
  source: 'broker' | 'static',
  brokerStatus: BrokerStatus,
  streaming: boolean,
): string {
  if (source === 'static') {
    return d.status === 'done' || d.status === 'dead' || d.status === 'canceled'
      ? 'Finished'
      : 'Paused';
  }
  if (brokerStatus === 'down' || brokerStatus === 'reconnecting') return 'Reconnecting…';
  return streaming ? 'Working…' : 'Idle';
}

/** Identity line — the `header` slot. Always present (no capability), but the
 *  internals audience (Operator) sees the full identity row while a consumer
 *  audience (Studio) sees a slim title + a status word. Capability-driven. */
export function TitleBar(props: {
  store: ChromeBarStore;
  detail: NodeDetail | null;
}): ReactNode {
  const dormant = props.store.source === 'static';
  const streaming = props.store.state?.isStreaming ?? false;
  const d = props.detail;
  const showInternals = useCapability('node.internals');

  if (!showInternals) {
    const word = d ? statusWord(d, props.store.source, props.store.brokerStatus, streaming) : '…';
    const working = word === 'Working…';
    return (
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-lg font-semibold truncate">{d?.name ?? '…'}</span>
        <span
          className={cn(
            'inline-flex items-center gap-1.5 text-sm',
            working ? 'text-success' : 'text-muted-foreground',
          )}
        >
          {working && <Loader className="size-3.5 animate-spin" />}
          {word}
        </span>
      </div>
    );
  }

  const pillStatus = d
    ? livePillStatus(d, props.store.source, props.store.brokerStatus, streaming)
    : null;

  if (!d) {
    return <h2 className={CON_TITLE}>…</h2>;
  }

  return (
    <>
      <h2 className={cn(CON_TITLE, 'min-w-0 truncate')} title={d.name}>
        {d.name}
      </h2>
      {pillStatus && (
        <Badge className={cn('gap-1.5', pillStatus)}>
          <StatusGlyph status={pillStatus} />
          {pillStatus}
        </Badge>
      )}
      {dormant && (
        <span
          className="font-mono text-xs"
          style={{ color: 'var(--idle)' }}
          title="dormant node — last-known values, not live"
        >
          last-known
        </span>
      )}
    </>
  );
}

/** Console identity title — the loudest mark in the con-head (Fraunces, 20px). */
const CON_TITLE = 'con-title font-display text-xl font-medium';


/**
 * Instrument cluster — the `chrome` slot's richer readout (capability
 * `node.internals`). Two gauges (context usage %, session cost) plus a row of
 * dials (turns, messages, tokens, tools). Quiet Instrument `.cluster` / `.gauge`
 * / `.gbar` / `.dials` / `.dial`. A dormant node omits the live-only readings
 * (context %, tool activity, stats) per F.4 — nothing to render → null.
 */
export function ChromePanel(props: {
  store: ChromeBarStore;
  detail: NodeDetail | null;
}): ReactNode {
  const chrome = props.store.chrome;
  const dormant = props.store.source === 'static';
  const streaming = props.store.state?.isStreaming ?? false;
  const ctx = chrome.context;
  const stats = chrome.stats;
  const tokens = chrome.tokens;

  // Context % is live-only (needs the window denominator); a dormant node shows
  // just the raw token count with no bar.
  const pct = ctx && !dormant ? ctx.percent : null;
  const cost = !dormant && stats?.cost !== undefined ? stats.cost : null;

  // Nothing meaningful to gauge yet → render nothing rather than an empty rail.
  if (!ctx && cost === null && !stats && !tokens) return null;

  return (
    <div className="cluster">
      {ctx && (
        <div className="gauge">
          <div className="glabel">
            <span className="instlabel">Context</span>
            <span className="gval">
              {pct === null ? '—' : fmtPercent(pct)}
              {pct !== null && <span className="u">%</span>}
            </span>
          </div>
          <div className="gbar">
            <i style={{ width: pct === null ? '0%' : `${Math.min(100, pct)}%` }} />
          </div>
          <div className="gsub">
            {ctx.tokens.toLocaleString()}
            {!dormant && <> / {ctx.window.toLocaleString()}</>}
          </div>
        </div>
      )}

      {cost !== null && (
        <div className="gauge">
          <div className="glabel">
            <span className="instlabel">Cost</span>
            <span className="gval">
              <span className="u" style={{ marginLeft: 0, marginRight: 2 }}>$</span>
              {cost.toFixed(2)}
            </span>
          </div>
          <div className="gbar">
            <i style={{ width: `${Math.min(100, (cost / 5) * 100)}%` }} />
          </div>
          {stats && <div className="gsub">{stats.turns} turns</div>}
        </div>
      )}

      <div className="dials">
        {/* turns lives in the Cost gauge sub-line when cost is present; otherwise
            surface it here so it is never lost. */}
        {!dormant && stats && cost === null && (
          <Dial value={String(stats.turns)} unit="turns" />
        )}
        {!dormant && stats && (
          <Dial
            value={`${stats.user_messages}/${stats.assistant_messages}`}
            unit="msgs"
          />
        )}
        {tokens && (
          <Dial
            value={`${fmtTokens(tokens.input)} → ${fmtTokens(tokens.output)}`}
            unit="tokens"
          />
        )}
        {!dormant && chrome.tool_calls !== null && (
          <Dial value={String(chrome.tool_calls)} unit="tools" hot={streaming} />
        )}
      </div>
    </div>
  );
}

/** A single dial readout: `value` over a dim `unit` label. */
function Dial({
  value,
  unit,
  hot,
}: {
  value: string;
  unit: string;
  hot?: boolean;
}): ReactNode {
  return (
    <div className="dial">
      <span className="dval" style={hot ? { color: 'var(--act)' } : undefined}>
        {value} <em>{unit}</em>
      </span>
    </div>
  );
}

/** Compact token count (e.g. 31480 → 31k). */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Context-usage percent to a single decimal (e.g. 13.347 → 13.3). */
function fmtPercent(percent: number): string {
  return (Math.round(percent * 10) / 10).toFixed(1);
}
