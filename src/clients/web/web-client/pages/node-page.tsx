/**
 * SessionScreen (spec §5.C/D/E/F/H) — ONE node page composed through the profile
 * slot registry (design §3.3). The layout places named slots (header, chrome,
 * stream, rail, arbitration, composer, trace); each slot is filled from the
 * registry below and rendered only if the active profile grants its capability.
 * Operator grants everything, so the rendered result is identical to the
 * pre-abstraction node page. The chat substrate (MessageList, tool cards,
 * session store) is shared and untouched. Orchestrates the dormant→live
 * transition: a static source shows read-only + revive, and the live snapshot
 * arrives over the SAME socket on revive (no page reload). broker_status
 * down/reconnecting freezes input.
 */

import { useState, useEffect, useRef, Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronLeft, ChevronDown } from 'lucide-react';
import type { Command, NodeDetail, ThinkingLevel } from '@/shared/protocol.js';
import type { Capability } from '../profile/types.js';
import { closeNode, getNode, messageNode, reviveNode, CommandError } from '../command-client.js';
import { useSessionStore, type SessionStore } from '../store/session-store.js';
import type { CSSProperties } from 'react';
import { TitleBar } from '../chrome/chrome-bar.js';
import { MetaStrip } from '../chrome/meta-strip.js';
import { InstrumentOverlay } from '../chrome/instrument-overlay.js';
import { GraphRail } from '../session/graph-rail.js';
import { Presence } from '../chrome/presence.js';
import { useTerm, useGrants, useCapability, useProfile } from '../profile/provider.js';
import { shouldResnapshot, resnapshotDelay } from '../lib/session-resnapshot.js';
import { handleComposerKeyDown } from '../lib/composer-keys.js';
import { Slot, Can, actionsFor, type SlotRegistry } from '../profile/slots.js';
import { cn } from '@/lib/utils.js';
import { CommandPalette } from '../command-palette/palette.js';
import { ExtensionDialog } from '../dialogs/extension-dialog.js';
import { MessageList } from '../session/message-list.js';
import { ActivityRail } from '../session/activity-rail.js';
import { InlineAsks } from '../session/inline-asks.js';
import { FilePeek } from '../session/file-peek.js';
import { PeekContext } from '../session/tool-card/parts.js';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select.js';
import {
  useTranscriptDetail,
  setTranscriptDetail,
  cycleTranscriptDetail,
  type TranscriptDetail,
} from '../lib/transcript-detail.js';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog.js';

const THINKING_LEVELS: ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'];

/** Reveal-stagger index for the `.in .rv` entrance animation. */
const rv = (i: number): CSSProperties => ({ ['--i' as string]: i }) as CSSProperties;
const CON_HEAD: CSSProperties = {
  borderBottom: '1px solid var(--line)',
  background: 'linear-gradient(180deg, rgba(33,31,25,.7), rgba(20,19,16,0))',
};

/** The session screen's named slots (design §3.3). `rail` and `trace` are part
 *  of the layout contract but unfilled in Phase 1 (Studio's ActivityRail and
 *  the EventInspector are later phases) — an unregistered slot renders nothing. */
type SessionSlot =
  | 'header'
  | 'chrome'
  | 'stream'
  | 'rail'
  | 'arbitration'
  | 'composer'
  | 'trace'
  | 'graphRail'
  | 'filePeek';

// ---------------------------------------------------------------------------
// NodePage (SessionScreen)
// ---------------------------------------------------------------------------

export function NodePage(props: { id: string }) {
  const navigate = useNavigate();
  const store = useSessionStore(props.id);
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [input, setInput] = useState('');
  const [reviving, setReviving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [peekedPath, setPeekedPath] = useState<string | null>(null);

  // --- derived liveness / capability flags ---
  const dormant = store.source === 'static';
  const brokerUp = store.brokerStatus === 'connected' || store.brokerStatus === 'revived';
  const isController = store.role === 'controller';
  const streaming = store.state?.isStreaming ?? false;
  /** Live driving needs the controller slot on a live, up broker AND a live server bridge. */
  const canDrive = isController && !dormant && brokerUp && store.serverConnected;

  // --- audience flags (capability-driven, never profile-name) ---
  // An audience without the manual arbitration UI (Studio) holds its own
  // conversation: it auto-requests control on open and renders contention as a
  // soft line instead of a request/release toolbar.
  const showArbitration = useCapability('node.arbitration');
  const showInternals = useCapability('node.internals');
  const showCommands = useCapability('commands.palette');
  const home = useProfile().nav[0] ?? { label: 'Home', path: '/' };
  const commands = store.commands;
  // Soft contention: someone else holds the controller slot of this conversation.
  const contended =
    !showArbitration && !dormant && brokerUp && store.role === 'observer' && !!store.presence.controller;

  useEffect(() => {
    getNode(props.id)
      .then(setDetail)
      .catch((err: unknown) => setActionError(asMessage(err)));
  }, [props.id]);

  // Cold-start re-snapshot (consumer first-impression fix). A node spawned via
  // "+ New chat" and entered before its broker finishes booting is served a
  // read-only static snapshot. While the node is actually live (status
  // 'active') but our stream is still stuck on that static snapshot, reconnect
  // with backoff: re-dialing the broker relay reaches the now-up broker socket
  // and streams its live snapshot — the same effect as a manual page reload. A
  // genuinely-dormant node (idle/done/…) never qualifies, so the explicit
  // Revive path and AC-21 auto-resume are untouched.
  const resnapshotRef = useRef(0);
  useEffect(() => {
    resnapshotRef.current = 0; // re-arm per node
  }, [props.id]);
  useEffect(() => {
    if (
      !shouldResnapshot({
        dormant,
        status: detail?.status,
        socketReady: store.socketReady,
        attempt: resnapshotRef.current,
      })
    )
      return;
    const attempt = resnapshotRef.current;
    resnapshotRef.current += 1;
    const timer = setTimeout(() => store.reconnect(), resnapshotDelay(attempt));
    return () => clearTimeout(timer);
  }, [dormant, detail?.status, store.socketReady, store.reconnect]);

  // Studio holds its own conversation: with no manual arbitration UI, auto-grab
  // the controller slot once the socket is open (design §4.3). Operator keeps
  // the explicit request/release affordance, so this is skipped there.
  const autoControlRef = useRef<string | null>(null);
  // Re-arm the auto-grab whenever the socket drops/reconnects: a reconnect (the
  // cold-start re-snapshot above, or a server restart) re-dials the verbatim
  // broker relay, and the broker arbitrates control with no controller held for
  // this tab, so we must request control again.
  useEffect(() => {
    if (!store.socketReady) autoControlRef.current = null;
  }, [store.socketReady]);
  useEffect(() => {
    if (showArbitration || dormant) return;
    if (!store.socketReady || !brokerUp) return;
    if (store.role === 'controller') return;
    if (autoControlRef.current === props.id) return; // already asked for this node
    autoControlRef.current = props.id;
    store.requestControl();
  }, [showArbitration, dormant, store.socketReady, brokerUp, store.role, props.id, store]);

  // Alt+D cycles the transcript Detail level (Focused→Standard→Verbose→wrap),
  // console-level so it works wherever focus is — except the composer textarea,
  // where typing must win. Matched on `code` (layout-stable).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.code !== 'KeyD') return;
      if (document.activeElement instanceof HTMLTextAreaElement) return;
      e.preventDefault();
      cycleTranscriptDetail();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- input actions ---
  const sendPrimary = (): void => {
    const text = input.trim();
    if (!text || !canDrive) return;
    // While streaming a controller's input steers the live turn (D.6);
    // otherwise it starts a new prompt. Slash commands ride the prompt path (E.4).
    if (streaming) store.steer(text);
    else store.prompt(text);
    setInput('');
  };

  // Plain Enter sends; Shift+Enter and Alt/Option+Enter insert a newline (R1).
  const onInputKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    handleComposerKeyDown(e, setInput, sendPrimary);
  };

  const selectCommand = (cmd: Command): void => {
    setInput(`/${cmd.name} `);
  };

  // --- lifecycle actions ---
  const doRevive = async (): Promise<void> => {
    setReviving(true);
    setActionError(null);
    try {
      await reviveNode(props.id);
      // Reconnect the broker socket now that the revived broker is live.
      store.reconnect();
    } catch (err) {
      setActionError(asMessage(err));
    } finally {
      setReviving(false);
    }
  };

  const doClose = async (): Promise<void> => {
    setActionError(null);
    try {
      await closeNode(props.id);
    } catch (err) {
      setActionError(asMessage(err));
    }
  };

  const tSteer = useTerm('steer');

  // The session screen's panel registry. Slots whose capability the active
  // profile withholds simply don't render (design §3.3). Render functions are
  // closures over the page's store + handlers — the chat substrate is shared.
  const slots: SlotRegistry<SessionSlot> = {
    header: { render: () => <TitleBar store={store} detail={detail} /> },
    chrome: { cap: 'node.internals', render: () => <MetaStrip store={store} detail={detail} /> },
    stream: { render: () => <MessageList messages={store.messages} streaming={streaming} /> },
    arbitration: { cap: 'node.arbitration', render: () => <Presence store={store} /> },
    rail: { cap: 'subnodes.activity', render: () => <ActivityRail rootId={props.id} /> },
    graphRail: {
      cap: 'node.graphRail',
      render: () => (
        <GraphRail currentId={props.id} onNavigate={(id) => navigate(`/nodes/${id}`)} />
      ),
    },
    filePeek: {
      cap: 'files.peek',
      render: () => (
        <FilePeek nodeId={props.id} path={peekedPath} onClose={() => setPeekedPath(null)} />
      ),
    },
    composer: {
      render: () =>
        dormant ? (
          <DormantBar id={props.id} reviving={reviving} onRevive={doRevive} onClose={doClose} />
        ) : (
          <>
            <Can cap="node.internals">
              <DriveToolbar store={store} canDrive={canDrive} streaming={streaming} onClose={doClose} />
            </Can>
            {/* Consumer audiences get a soft working banner + Stop instead of the
                raw drive toolbar's Abort. */}
            {!showInternals && streaming && (
              <div className="flex shrink-0 items-center gap-2 border-t border-border px-4 py-2 text-sm text-success">
                <span className="size-1.5 animate-pulse rounded-full bg-success" />
                Agent is working…
                <Button
                  variant="secondary"
                  size="sm"
                  className="ml-auto"
                  disabled={!canDrive}
                  onClick={() => store.abort()}
                >
                  Stop
                </Button>
              </div>
            )}
            <div className="relative flex shrink-0 flex-col gap-2 border-t border-border px-4 py-3">
              {showCommands && (
                <CommandPalette
                  commands={commands}
                  query={input}
                  visible={input.startsWith('/')}
                  onSelect={selectCommand}
                />
              )}
              <Textarea
                className={cn('resize-none text-sm', showInternals && 'font-mono')}
                value={input}
                onChange={(e) => setInput(e.currentTarget.value)}
                onKeyDown={onInputKeyDown}
                disabled={!canDrive}
                placeholder={inputPlaceholder(showInternals, showCommands, isController, brokerUp)}
                rows={3}
              />
              <div className="flex items-center justify-end gap-2">
                <Can cap="node.internals">
                  <InboxMessageButton id={props.id} />
                </Can>
                <Button
                  variant="default"
                  onClick={sendPrimary}
                  disabled={!canDrive || !input.trim()}
                >
                  {streaming ? tSteer : 'Send'}
                </Button>
              </div>
            </div>
          </>
        ),
    },
  };

  return (
    <PeekContext.Provider value={{ peekedPath, onPeek: setPeekedPath }}>
    <div className="in flex h-full min-h-0 flex-col">
      <div
        className={cn('con-head rv flex shrink-0 items-center gap-3 px-6 py-4', dormant && 'opacity-80')}
        style={{ ...CON_HEAD, ...rv(1) }}
      >
        <button
          type="button"
          onClick={() => navigate(home.path)}
          className="flex shrink-0 items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-[var(--ink)]"
        >
          <ChevronLeft className="size-4" />
          {home.label}
        </button>
        <Slot reg={slots} name="header" />
        <div className="flex-1" />
        <DetailControl />
        <Slot reg={slots} name="arbitration" />
      </div>
      <div className="rv" style={rv(2)}>
        <Slot reg={slots} name="chrome" />
      </div>

      <BrokerBanner state={store.brokerStatus} dormant={dormant} />
      {contended && (
        <div className="border-b border-border bg-muted/40 px-4 py-2 text-sm text-muted-foreground">
          Someone else is steering this conversation.
        </div>
      )}
      {/* Raw WS error codes are diagnostic — shown only to the internals
          audience; consumers get the calm broker/contention banners instead. */}
      {store.error && showInternals && (
        <div className="border-b border-destructive/30 bg-destructive/15 px-4 py-2 text-sm text-destructive">
          {store.error.code}: {store.error.message}
        </div>
      )}
      {actionError && (
        <div className="border-b border-destructive/30 bg-destructive/15 px-4 py-2 text-sm text-destructive">
          {showInternals ? actionError : 'Something went wrong — please try again.'}
        </div>
      )}

      {/* Asks raised anywhere in this conversation's sub-DAG, inline (design
          §4.3/§5.1) — tagged by conversation, resolved here for simple kinds or
          deep-linked into the Inbox for complex ones. Capability-neutral. */}
      <InlineAsks conversationId={props.id} />

      <div className="streamwrap relative flex min-h-0 flex-1 overflow-hidden">
        <Slot reg={slots} name="graphRail" />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="min-h-0 flex-1 overflow-auto">
            <Slot reg={slots} name="stream" />
          </main>
          <Slot reg={slots} name="rail" />
          <Slot reg={slots} name="composer" />
        </div>
        <Slot reg={slots} name="filePeek" />
      </div>

      <Slot reg={slots} name="trace" />

      {/* Telemetry HUD — ⌥i toggles the floated instrument cluster (was an
          always-on band). Internals audience only. */}
      <Can cap="node.internals">
        <InstrumentOverlay store={store} detail={detail} />
      </Can>

      <ExtensionDialog store={store} />
    </div>
    </PeekContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// DetailControl (design contract §4) — the renamed transcript-verbosity axis
// ---------------------------------------------------------------------------

/** Sticky con-head chrome: a compact Select labelled "Detail" driving the whole
 *  transcript (tools + thinking + prose) via the global transcript-detail store.
 *  Right-aligned in the con-head; Alt+D cycles it (handler lives in NodePage). */
const DETAIL_LEVELS: { value: TranscriptDetail; label: string }[] = [
  { value: 'focused', label: 'Focused' },
  { value: 'standard', label: 'Standard' },
  { value: 'verbose', label: 'Verbose' },
];

function DetailControl(): ReactNode {
  const detail = useTranscriptDetail();
  return (
    <div
      className="flex shrink-0 items-center gap-2"
      title="Transcript detail — Focused / Standard / Verbose  (⌥D to cycle)"
    >
      <span className="instlabel">Detail</span>
      <Select value={detail} onValueChange={(v) => setTranscriptDetail(v as TranscriptDetail)}>
        <SelectTrigger size="sm" className="text-sm" aria-label="Transcript detail">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {DETAIL_LEVELS.map((l) => (
            <SelectItem key={l.value} value={l.value}>
              {l.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function inputPlaceholder(
  showInternals: boolean,
  showCommands: boolean,
  controller: boolean,
  brokerUp: boolean,
): string {
  if (!showInternals) {
    return brokerUp ? 'Message your agent' : 'Reconnecting to your agent…';
  }
  if (!controller) return 'observer — request control to drive this session';
  if (!brokerUp) return 'broker is down — input is frozen';
  return showCommands ? 'Type a prompt, or / for commands…' : 'Type a prompt…';
}

// ---------------------------------------------------------------------------
// BrokerBanner
// ---------------------------------------------------------------------------

function BrokerBanner({ state, dormant }: { state: string; dormant: boolean }) {
  // Consumer audiences (no diagnostics) see one calm, de-jargoned line for both
  // the down and reconnecting states; the broker vocabulary never leaks.
  const friendly = !useCapability('diagnostics');
  if (dormant || (state !== 'down' && state !== 'reconnecting')) return null;
  if (friendly) {
    return (
      <div className="broker-banner border border-warning/30 bg-warning/15 px-4 py-2 text-sm">
        Reconnecting to your agent…
      </div>
    );
  }
  return (
    <div
      className={[
        'broker-banner border px-4 py-2 text-sm',
        state === 'down'
          ? 'bg-destructive/15 text-destructive border-destructive/30'
          : 'bg-warning/15 border-warning/30',
      ].join(' ')}
    >
      {state === 'down'
        ? 'Broker is down — history frozen, input disabled. Waiting for auto-revive…'
        : 'Reconnecting to the broker…'}
    </div>
  );
}

// ---------------------------------------------------------------------------
// DriveToolbar
// ---------------------------------------------------------------------------

function DriveToolbar({
  store,
  canDrive,
  streaming,
  onClose,
}: {
  store: SessionStore;
  canDrive: boolean;
  streaming: boolean;
  onClose: () => void;
}) {
  // Reflect the engine's live thinking level; an optimistic local override
  // shows the user's pick immediately (m4).
  const [override, setOverride] = useState<ThinkingLevel | null>(null);
  const thinking: ThinkingLevel = override ?? store.state?.thinkingLevel ?? 'medium';
  const tCompact = useTerm('compact');
  const tClose = useTerm('close');
  const tNode = useTerm('node');

  // Ranked, not flat (design contract §3b): Send is the sole primary (composer
  // footer); here the live-turn controls (Abort + thinking) lead, Cycle model /
  // Compact are demoted to ghost, and the destructive Close node is pushed to
  // the far right (ml-auto) so a lifecycle action never sits shoulder-to-
  // shoulder with a formatting toggle. All controls h-8 (size-sm).
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-2">
      {/* live-turn group */}
      <Button
        variant="secondary"
        size="sm"
        disabled={!canDrive || !streaming}
        onClick={() => store.abort()}
      >
        Abort
      </Button>
      {/* One `.tiny-sel` pill — CSS uppercases it to `THINKING HIGH ▾`. The native
          <select> sits transparent over the pill so it stays a real level picker
          (m4) while reading as a single instrument label. */}
      <label className="tiny-sel relative" aria-disabled={!canDrive}>
        thinking <b>{thinking}</b>
        <ChevronDown className="size-3.5" />
        <select
          disabled={!canDrive}
          value={thinking}
          onChange={(e) => {
            const level = e.currentTarget.value as ThinkingLevel;
            setOverride(level);
            store.setThinkingLevel(level);
          }}
          aria-label="Thinking level"
          className="absolute inset-0 cursor-pointer opacity-0"
        >
          {THINKING_LEVELS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
      </label>
      {/* demoted secondary controls */}
      <Button variant="ghost" size="sm" disabled={!canDrive} onClick={() => store.cycleModel()}>
        Cycle model
      </Button>
      <Button variant="ghost" size="sm" disabled={!canDrive} onClick={() => store.compact()}>
        {tCompact}
      </Button>
      {/* destructive lifecycle — pulled far-right, out of misclick range */}
      <Can cap="node.lifecycle.raw">
        <Button variant="destructive" size="sm" className="ml-auto" onClick={onClose}>
          {tClose} {tNode}
        </Button>
      </Can>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DormantBar
// ---------------------------------------------------------------------------

function DormantBar({
  id,
  reviving,
  onRevive,
  onClose,
}: {
  id: string;
  reviving: boolean;
  onRevive: () => void;
  onClose: () => void;
}) {
  const grants = useGrants();
  const showInternals = useCapability('node.internals');
  const tNode = useTerm('node');
  const tRevive = useTerm('revive');
  const tClose = useTerm('close');

  // Resuming ("Continue") is the core path for every audience — no capability.
  // Only the raw lifecycle controls (fresh-vs-resume choice, close) are gated.
  const actions: { key: string; cap?: Capability; node: ReactNode }[] = [
    {
      key: 'revive',
      node: (
        <Button variant="default" disabled={reviving} onClick={onRevive}>
          {reviving ? `${tRevive}…` : tRevive}
        </Button>
      ),
    },
    {
      key: 'close',
      cap: 'node.lifecycle.raw',
      node: (
        <Button variant="destructive" onClick={onClose}>
          {tClose} {tNode}
        </Button>
      ),
    },
  ];

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-4 py-3">
      <span className="text-muted-foreground text-sm">
        {showInternals
          ? `This ${tNode} is dormant (read-only). ${tRevive} to drive it live.`
          : `This ${tNode} is finished. ${tRevive} to keep going.`}
      </span>
      <Can cap="node.internals">
        <InboxMessageButton id={id} />
      </Can>
      {actionsFor(actions, grants).map((a) => (
        <Fragment key={a.key}>{a.node}</Fragment>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InboxMessageButton + InboxMessageDialog
// ---------------------------------------------------------------------------

/** Inbox message form — distinct from the live prompt; works on dormant nodes (G.2). */
function InboxMessageButton({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Message (inbox)
      </Button>
      <InboxMessageDialog id={id} open={open} onOpenChange={setOpen} />
    </>
  );
}

function InboxMessageDialog({
  id,
  open,
  onOpenChange,
}: {
  id: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [body, setBody] = useState('');
  const [tier, setTier] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  // M1: this dialog is permanently mounted and Radix-toggled, so reset the form
  // on each open edge — otherwise reopening shows stale body/tier/result.
  useEffect(() => {
    if (open) {
      setBody('');
      setTier('');
      setResult(null);
    }
  }, [open]);

  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (!body.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const res = await messageNode(id, {
        body: body.trim(),
        ...(tier.trim() ? { tier: tier.trim() } : {}),
      });
      setResult(`delivered=${String(res.delivered)} woke=${String(res.woke)}`);
      setBody('');
    } catch (err) {
      setResult(asMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Send an inbox message</DialogTitle>
          <DialogDescription>
            A directive deliverable to any node, including a dormant one.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.currentTarget.value)}
            rows={4}
            required
            placeholder="Message body…"
          />
          <label className="flex flex-col gap-1 text-sm">
            tier
            <input
              className="rounded border bg-transparent px-2 py-1 text-sm"
              value={tier}
              onChange={(e) => setTier(e.currentTarget.value)}
              placeholder="(default)"
            />
          </label>
          {result && <p className="text-muted-foreground text-sm">{result}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="secondary"
              onClick={() => onOpenChange(false)}
              disabled={busy}
            >
              Close
            </Button>
            <Button type="submit" variant="default" disabled={busy}>
              {busy ? 'Sending…' : 'Send'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asMessage(err: unknown): string {
  return err instanceof CommandError ? `${err.code}: ${err.message}` : String(err);
}
