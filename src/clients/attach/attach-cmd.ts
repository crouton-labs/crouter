// attach-cmd.ts — the `crtr attach` terminal viewer: core + registration (T7).
//
// Wires the already-built render layer (T5 ChatView + extension-dialogs) and
// input layer (T6 InputController + slash/config/clipboard) together over a
// single socket to a node's running headless broker, and drives the SAME engine
// as a controller (or read-only observer). The §0 ONE-WRITER INVARIANT holds by
// construction: this dir has ONLY a socket — no reviveNode, no `pi --session`,
// no SessionManager, no `.jsonl` write/open. attach does NOT launch the engine;
// if the broker isn't running it errors and exits (focus/T9 keeps a broker
// alive, not attach).
//
// Command shape (plan §3.6): the CLI path-walker forbids a flat top-level leaf
// (`defineRoot.subtrees` is `BranchDef[]`, and a top-level leaf crashes
// listing-completeness), and a branch rejects a bare positional — so the bare
// `crtr attach <node>` form is not expressible without a framework change. attach
// is therefore a BRANCH wrapping a single leaf: `crtr attach to <node>`.

import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  CombinedAutocompleteProvider,
  Container,
  ProcessTerminal,
  Text,
  TUI,
  matchesKey,
  truncateToWidth,
  type EditorTheme,
} from '@earendil-works/pi-tui';
import {
  CustomEditor,
  DynamicBorder,
  getSelectListTheme,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { defineBranch, defineLeaf } from '../../core/command.js';
import type { BranchDef, LeafDef } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { getNode, getRow } from '../../core/canvas/index.js';
// tmux driver verbs only through placement (the §5.1 model-over-driver seam) —
// never `core/runtime/tmux.js` directly.
import { setPaneOption, currentTmux } from '../../core/runtime/placement.js';
import type {
  BrokerSnapshot,
  BrokerToClient,
  ClientRole,
} from '../../core/runtime/broker-protocol.js';
import { climbRoot, visibleWidth } from '../../core/canvas/nav-model.js';
import { ChatView } from './chat-view.js';
import { InputController } from './input-controller.js';
import { buildCanvasPanelLines } from './canvas-panels.js';
import { GraphOverlay } from './graph-overlay.js';
import { slashCommandList } from './slash-commands.js';
import { applyTheme, attachPalette, createKeybindingsManager } from './config-load.js';
import { TitledEditor, thinkingBorderColor, thinkingTitleStyle, defaultTitleStyle } from './titled-editor.js';
import { fetchGitInfo, type GitInfo } from './git-info.js';
import { BrokerUnavailableError, ViewSocketClient, reconnectShouldGiveUp } from './view-socket.js';

/** Async per-node ask-map fetch (NON-blocking — the viewer must never block its
 *  input pump on a shell-out, unlike canvas-nav's execFileSync). Buckets a whole
 *  sub-DAG's pending asks in one `crtr` process; on any error the callback is not
 *  invoked, so the caller keeps its last good map. */
function fetchAsksAsync(rootId: string, cb: (counts: Record<string, number>) => void): void {
  execFile(
    'crtr',
    ['canvas', 'attention', 'map', '--view', rootId, '--json'],
    { timeout: 2_500, maxBuffer: 4 * 1024 * 1024 },
    (err, stdout) => {
      if (err) return;
      try {
        const parsed = JSON.parse(stdout.trim()) as { counts?: Record<string, number> };
        cb(parsed.counts ?? {});
      } catch {
        /* malformed — keep last map */
      }
    },
  );
}

/** `CustomEditor`'s ctor wants pi's app-subclass KeybindingsManager; our
 *  `createKeybindingsManager()` returns pi-tui's base manager. CustomEditor only
 *  calls `.matches()` on it (runtime-correct), so we widen via the ctor's own
 *  parameter type rather than importing pi's type-only core class. The SAME
 *  instance also feeds InputController (no cast there). */
type EditorKeybindings = ConstructorParameters<typeof CustomEditor>[2];

/** Run the interactive attach session against `nodeId`. Resolves when the
 *  viewer detaches (ctrl+c/ctrl+d), the broker goes away, or a signal lands —
 *  always restoring the terminal first. */
async function runAttach(nodeId: string, observer: boolean): Promise<void> {
  const meta = getNode(nodeId);
  if (meta === null) {
    throw new InputError({
      error: 'not_found',
      message: `no node: ${nodeId}`,
      received: nodeId,
      next: 'List nodes with `crtr node inspect list`.',
    });
  }

  const socket = new ViewSocketClient(nodeId);

  // Connect FIRST (race connect/error) so a missing broker exits non-zero
  // cleanly, BEFORE the TUI takes over the terminal.
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onErr = (err: Error): void => {
      cleanup();
      reject(err);
    };
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onErr);
    };
    socket.on('connect', onConnect);
    socket.on('error', onErr);
    socket.connect();
  }).catch((err: unknown) => {
    if (err instanceof BrokerUnavailableError) {
      throw new InputError({
        error: 'no_broker',
        message: err.message,
        received: nodeId,
        next: 'Focus or revive the node first — attach needs a running headless broker.',
      });
    }
    throw new InputError({
      error: 'socket_error',
      message: `could not attach to node ${nodeId}: ${String((err as Error)?.message ?? err)}`,
      received: nodeId,
      next: 'Check the node has a running headless broker.',
    });
  });

  // Self-tag this pane with the node it now views so the host-agnostic
  // `nodeInPane()` (node cycle/recycle/close/demote/lifecycle) resolves a
  // broker-hosted node from its VIEWER pane — the broker engine runs detached
  // (window=null), so a window→node lookup can't find it; this pane tag is the
  // handle. Set AFTER the connect proves a broker is here, mirrors view-run's
  // `@crtr_view` self-tag. Cleared on teardown so a stray tag can't outlive the
  // viewer (best-effort; tmux-only).
  const tagPane = process.env['TMUX_PANE'] ?? currentTmux()?.pane;
  if (tagPane !== undefined && tagPane !== '') {
    try { setPaneOption(tagPane, '@crtr_node', nodeId); } catch { /* best-effort */ }
  }
  const clearPaneTag = (): void => {
    if (tagPane !== undefined && tagPane !== '') {
      try { setPaneOption(tagPane, '@crtr_node', ''); } catch { /* best-effort */ }
    }
  };

  // 1. Theme + keybindings FIRST — pi's components throw "Theme not initialized"
  //    otherwise (T5 contract). One KeybindingsManager feeds BOTH editor + input.
  applyTheme({ cwd: meta.cwd });
  const pal = attachPalette();
  const km = createKeybindingsManager();

  // 2. TUI + layout containers + editor. Top-to-bottom render order (set at
  //    step 8): chat · rule · badge · managers (↑ subscriber) · editor (themed
  //    border) · reports (↓ subscriptions) · status bar. A themed DynamicBorder
  //    rule divides the scrolling chat from the fixed chrome below it. The badge
  //    sits in the BOTTOM-anchored chrome
  //    stack (directly above managers), NOT as the topmost child: pi-tui anchors
  //    the viewport to the cursor at the bottom, so a topmost badge scrolls off
  //    into scrollback the instant the chat exceeds one screen. The badge + the
  //    two canvas panels reproduce the pi-extension chrome natively (Unit Q).
  const tui = new TUI(new ProcessTerminal());
  const chatContainer = new Container();
  const chrome = new Container(); // a themed rule dividing scrolling chat from the fixed chrome below
  const managers = new Container();
  const reports = new Container();
  const queued = new Container(); // pending steering/follow-up messages, above the editor
  const pickerPanel = new Container(); // native pickers (/model etc.), inline directly under the editor
  const footer = new Container();
  chrome.addChild(new DynamicBorder(pal.border));
  const editorTheme: EditorTheme = { borderColor: pal.border, selectList: getSelectListTheme() };
  // TitledEditor paints the session name into its top border (solid-background
  // chip) and tracks a thinking-level border color, both set from live state below.
  const editor = new TitledEditor(tui, editorTheme, km as unknown as EditorKeybindings, { paddingX: 1 });
  // Slash-command autocomplete: builtins + native canvas commands now; enriched
  // with the broker's engine/extension/skill commands on the get_commands ack.
  const setCommands = (commands?: ReadonlyArray<{ name: string; description?: string }>): void => {
    editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommandList(commands), meta.cwd));
  };
  setCommands();

  // 3. Render layer (T5). ChatView owns the chat scroll + activity spinner; the
  //    footer/status line below is ours, so onFooterEvent is left unset (footer
  //    updates flow through handleBrokerFrame's single update path instead).
  const chatView = new ChatView(tui, chatContainer, { cwd: meta.cwd, palette: pal });

  // 4. Footer/status line — surfaces role + live state + transient notices.
  const clientId = randomUUID();
  let role: ClientRole = observer ? 'observer' : 'controller';
  let liveState: BrokerSnapshot['state'] | undefined;
  let notice = '';
  // A themed, aligned status bar: live state on the LEFT (role · model · streaming
  // · queued), the transient notice pushed to the RIGHT edge — not jammed inline.
  const renderFooter = (): void => {
    const segs: string[] = [
      role === 'controller' ? pal.active('● drive') : pal.muted('○ read-only'),
    ];
    if (liveState?.model) segs.push(pal.info(liveState.model));
    if (liveState?.isStreaming) segs.push(pal.active('streaming'));
    if (liveState && liveState.pendingMessageCount > 0) {
      segs.push(pal.muted(`queued ${liveState.pendingMessageCount}`));
    }
    const left = segs.join(pal.muted(' · '));
    const right = notice ? pal.warning(`⚠ ${notice}`) : '';
    // Text(_, 1, 0) pads 1 col each side, so the usable span is columns - 2.
    const span = Math.max(1, (process.stdout.columns ?? 80) - 2);
    const rightW = visibleWidth(right);
    // Truncate the left segment (ANSI-aware) so a long model/notice never wraps;
    // the right-aligned notice keeps its slot.
    const maxLeft = right ? Math.max(0, span - rightW - 1) : span;
    const leftFit = visibleWidth(left) > maxLeft ? truncateToWidth(left, maxLeft, '…') : left;
    const gap = Math.max(right ? 1 : 0, span - visibleWidth(leftFit) - rightW);
    const line = right ? leftFit + ' '.repeat(gap) + right : leftFit;
    footer.clear();
    footer.addChild(new Text(line, 1, 0));
    tui.requestRender();
  };
  const setNotice = (msg: string): void => {
    notice = msg;
    renderFooter();
  };


  // Subscribed-node panel — manager line above the editor, live reports below,
  // read straight from canvas.db via nav-model (Feature 2). asksMap is refreshed
  // by the low-rate poll below; beginFrame() inside buildCanvasPanelLines memoizes
  // the db reads for each rebuild.
  let asksMap: Record<string, number> = {};
  const renderPanels = (): void => {
    const { managers: mLines, reports: rLines } = buildCanvasPanelLines(nodeId, asksMap, pal);
    managers.clear();
    for (const l of mLines) managers.addChild(new Text(l, 1, 0));
    reports.clear();
    for (const l of rLines) reports.addChild(new Text(l, 1, 0));
    tui.requestRender();
  };

  // The alt+g GRAPH overlay (Feature 3) — a bounded, centered modal navigator
  // over the same nav-model graph, reading the live asksMap.
  const graphOverlay = new GraphOverlay(tui, nodeId, () => asksMap, pal);

  // Refresh all canvas chrome (panels + overlay if open) from canvas.db.
  const refreshChrome = (): void => {
    renderPanels();
    graphOverlay.refresh();
  };

  // Git context painted into the RIGHT of the editor's top border: cwd leaf ·
  // branch · status symbols (● dirty, ⇡ ahead, ⇣ behind). Refreshed by the poll.
  const renderGitInfo = (info: GitInfo): void => {
    const parts: string[] = [pal.muted(info.dir)];
    if (info.branch) parts.push(pal.info(`⎇ ${info.branch}`));
    const sym: string[] = [];
    if (info.dirty) sym.push(pal.warning('●'));
    if (info.ahead > 0) sym.push(pal.active(`⇡${info.ahead}`));
    if (info.behind > 0) sym.push(pal.active(`⇣${info.behind}`));
    if (sym.length > 0) parts.push(sym.join(''));
    // A trailing space keeps the symbols off the very last border cell.
    editor.info = ` ${parts.join(pal.muted(' · '))} `;
    tui.requestRender();
  };
  const pollGitInfo = (): void => fetchGitInfo(meta.cwd, renderGitInfo);

  // Queued steering/follow-up messages, shown above the editor so you can SEE
  // what is waiting (not just the footer count). Texts arrive on `queue_update`;
  // the welcome snapshot carries only a count, so the panel fills from the first
  // queue change after attach.
  let queuedMessages: string[] = [];
  const renderQueued = (): void => {
    queued.clear();
    if (queuedMessages.length > 0) {
      const span = Math.max(1, (process.stdout.columns ?? 80) - 4);
      queued.addChild(new Text(pal.muted(`queued (${queuedMessages.length}):`), 1, 0));
      for (const msg of queuedMessages) {
        const oneLine = msg.replace(/\s+/g, ' ').trim();
        queued.addChild(new Text(pal.faint(`  ⋯ ${truncateToWidth(oneLine, span, '…')}`), 1, 0));
      }
    }
    tui.requestRender();
  };

  // 5. Input layer (T6). onCommand/onDialogResponse → socket; onNotice → footer;
  //    nodeId/onGraph feed the slash context (/promote targets this node, /graph
  //    toggles the overlay); onRequest is the correlated read-op channel the
  //    native pickers ride on.
  const input = new InputController(tui, editor, km, {
    onCommand: (frame) => socket.send(frame),
    onDialogResponse: (resp) => socket.send(resp),
    onNotice: (msg) => setNotice(msg),
    nodeId,
    onGraph: () => graphOverlay.toggle(),
    // Global display toggles (Ctrl+O tools / Ctrl+T thinking) — pure render state
    // owned by ChatView, surfaced as a footer notice mirroring pi's status line.
    onToggleToolsExpand: () =>
      setNotice(chatView.toggleToolsExpanded() ? 'Tool output: expanded' : 'Tool output: collapsed'),
    onToggleThinking: () =>
      setNotice(chatView.toggleThinking() ? 'Thinking blocks: hidden' : 'Thinking blocks: visible'),
    // Wire the correlated read-op channel so the native pickers (/model,
    // /resume, /fork, /tree, /settings, /scoped-models) can fetch their payloads.
    // Without this every picker degrades to the "isn't available in this viewer"
    // notice (see slash-commands.ts + InputController.openPicker).
    onRequest: (frame) => socket.request(frame),
    // Mount the native pickers inline in the chrome stack, directly under the
    // editor (queued-panel pattern) — not as a floating centered modal — so a
    // picker reads as part of the editor, like pi's own selectors.
    onMountPicker: (component) => {
      pickerPanel.addChild(component);
      tui.requestRender();
    },
    onUnmountPicker: () => {
      pickerPanel.clear();
      tui.requestRender();
    },
  });

  // Feed fresh state into the input controller AND the footer. Steer-vs-prompt
  // routing (T6) reads `state.isStreaming`, so this must stay current — the
  // broker only ships full state in `welcome`, so we patch isStreaming/name/etc
  // from the relayed event stream below.
  const setLiveState = (state: BrokerSnapshot['state']): void => {
    liveState = state;
    input.setState(state);
    // The session name lives in the editor's top border (solid chip); the border
    // color tracks the agent's thinking level. Both follow live state.
    editor.title = state.sessionName ? `⬢ ${state.sessionName}` : '';
    editor.borderColor = thinkingBorderColor(state.thinkingLevel, pal.border);
    // Title chip background = the same thinking-level color (bold white text), so
    // the name chip and the border rule read as one hue.
    editor.titleStyle = thinkingTitleStyle(state.thinkingLevel, defaultTitleStyle);
    renderFooter();
    // Panel liveness rides the relayed event stream (agent_start/agent_end/
    // queue_update/session_info_changed all patch state through here) plus the
    // low-rate poll below for changes that emit no event (child status flips).
    refreshChrome();
  };
  const patchState = (patch: Partial<BrokerSnapshot['state']>): void => {
    if (liveState === undefined) return;
    setLiveState({ ...liveState, ...patch });
  };

  // 6. Drive every broker frame into both layers.
  const handleBrokerFrame = (frame: BrokerToClient): void => {
    switch (frame.type) {
      case 'welcome': {
        role = frame.role;
        chatView.applySnapshot(frame.snapshot);
        setLiveState(frame.snapshot.state);
        // Ask the broker for its merged command list (engine/extension/skill
        // commands) to enrich slash autocomplete beyond the builtins+canvas set.
        socket.send({ type: 'get_commands' });
        if (frame.pending_dialog != null) input.attachDialog(frame.pending_dialog);
        break;
      }
      case 'control_changed': {
        // We learn our own role by matching the broker's controller_id to the
        // client_id we sent in `hello`.
        role = frame.controller_id === clientId ? 'controller' : 'observer';
        renderFooter();
        break;
      }
      case 'model_changed': {
        // The broker's own post-set_model/cycle_model announcement (pi emits no
        // engine event for a model switch) — keeps the footer's model current.
        patchState({ model: frame.model });
        break;
      }
      case 'error': {
        if (frame.code === 'not_controller') {
          setNotice('read-only — another viewer is the controller');
        } else {
          setNotice(`error: ${frame.message}`);
        }
        break;
      }
      case 'ack': {
        // get_commands replies with the broker's merged command list as JSON in
        // `detail` — rebuild the autocomplete provider with it (slashCommandList
        // re-appends the native canvas commands, deduped).
        if (frame.for === 'get_commands' && frame.ok && frame.detail) {
          try {
            const list = JSON.parse(frame.detail) as Array<{ name: string; description?: string }>;
            setCommands(list);
          } catch {
            /* malformed — keep the current provider */
          }
          break;
        }
        // navigate_tree's detail is the navigated-to user message's text (pi
        // parity: the tree navigator restores it to the editor for re-editing);
        // the rewound transcript itself arrives via the broker's re-welcome.
        if (frame.for === 'navigate_tree' && frame.ok) {
          if (frame.detail) {
            editor.setText(frame.detail);
            tui.requestRender();
          }
          break;
        }
        if (!frame.ok) {
          setNotice(`command failed: ${frame.for}${frame.detail ? ` — ${frame.detail}` : ''}`);
        }
        break;
      }
      case 'extension_ui_request': {
        input.attachDialog(frame);
        break;
      }
      default: {
        // A relayed AgentSessionEvent — render it, and keep local state fresh.
        const event = frame as AgentSessionEvent;
        chatView.handleEvent(event);
        if (event.type === 'agent_start') patchState({ isStreaming: true });
        else if (event.type === 'agent_end') patchState({ isStreaming: false });
        else if (event.type === 'session_info_changed') patchState({ sessionName: event.name });
        else if (event.type === 'thinking_level_changed') {
          patchState({ thinkingLevel: event.level });
          setNotice(`Thinking level: ${event.level}`);
        }
        else if (event.type === 'queue_update') {
          queuedMessages = [...event.steering, ...event.followUp];
          renderQueued();
          patchState({ pendingMessageCount: queuedMessages.length });
        }
        break;
      }
    }
  };

  // 7. Lifecycle / teardown — always restore the terminal, exactly once.
  let restored = false;
  const restore = (): void => {
    if (restored) return;
    restored = true;
    try {
      tui.stop();
    } catch {
      /* best-effort terminal restore */
    }
  };
  process.once('exit', restore);

  let tornDown = false;
  // Last socket-level error, so a broker-gone teardown can report the precise
  // reason (e.g. an oversized-frame overflow) instead of the generic message.
  let lastSocketError: string | undefined;
  let resolveDone!: () => void;
  const done = new Promise<void>((r) => {
    resolveDone = r;
  });
  let asksTimer: ReturnType<typeof setInterval> | undefined;
  const teardown = (reason: 'detach' | 'broker-gone' | 'signal'): void => {
    if (tornDown) return;
    tornDown = true;
    if (asksTimer !== undefined) clearInterval(asksTimer);
    graphOverlay.close();
    clearPaneTag();
    removeKeyListener();
    // A clean detach tells the broker to drop this viewer (the engine runs on);
    // on broker-gone the socket is already dead, so skip `bye`.
    if (reason === 'detach') socket.send({ type: 'bye' });
    try {
      chatView.dispose();
    } catch {
      /* ignore */
    }
    socket.close();
    restore();
    if (reason === 'broker-gone') {
      const msg =
        lastSocketError ??
        `broker gone — node ${nodeId} is no longer running its engine. Re-focus to reattach.`;
      process.stderr.write(`\n${msg}\n`);
    }
    resolveDone();
  };

  // The handshake the viewer sends on connect AND on every successful redial.
  const sendHello = (): void => {
    socket.send({
      type: 'hello',
      role: observer ? 'observer' : 'controller',
      client_id: clientId,
      term: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
    });
  };

  // Reconnect supervisor. A resident broker node that yields EXITS its broker
  // (socket close) and is revived FRESH by the daemon on the SAME `view.sock`
  // path within a few seconds. So on close we HOLD the pane and re-dial while
  // the canvas-db row says the node is still alive (status active/idle), giving
  // up only when it is genuinely terminal (done/dead/canceled or row gone) or a
  // bounded ~30s of failed redials elapses (stale-row safety). A successful
  // redial re-sends `hello`; the new broker's `welcome` runs applySnapshot,
  // which resetChat()s the pane and rebuilds from the persisted .jsonl — a clean
  // "clear + continuation" for free.
  const RECONNECT_GIVEUP_MS = 30_000;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  let reconnecting = false;
  const attemptReconnect = async (): Promise<void> => {
    reconnecting = true;
    setNotice('↻ node refreshing — reconnecting…');
    const deadline = Date.now() + RECONNECT_GIVEUP_MS;
    let delay = 200;
    while (!tornDown && Date.now() < deadline) {
      if (reconnectShouldGiveUp(getRow(nodeId))) {
        break; // genuinely gone → fall through to broker-gone
      }
      try {
        await socket.redial();
        reconnecting = false;
        sendHello();
        setNotice('');
        return; // reconnected; the welcome snapshot clears + continues the pane
      } catch {
        // ENOENT (socket not recreated yet) / ECONNREFUSED (listen not ready) → retry.
        await sleep(Math.min(delay, 1000));
        delay *= 2;
      }
    }
    reconnecting = false;
    if (!tornDown) teardown('broker-gone');
  };

  // Permanent socket wiring (the connect-race listeners are gone).
  socket.on('frame', handleBrokerFrame);
  socket.on('error', (err) => {
    // Stash the reason; a 'close' follows and teardown converges there, where a
    // broker-gone message prefers this over the generic text.
    lastSocketError = err.message;
  });
  socket.on('close', () => {
    if (tornDown) return; // a real detach/signal already won
    if (reconnecting) return; // the dead socket's own close during the redial loop
    void attemptReconnect();
  });

  // ctrl+c / ctrl+d → detach (T6 left these unwired; lifecycle is ours). A
  // global TUI input listener fires BEFORE the focused component (and before any
  // dialog overlay), so detach is unconditional and consistent.
  const removeKeyListener = tui.addInputListener((data) => {
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) {
      teardown('detach');
      return { consume: true };
    }
    // alt+g toggles the GRAPH overlay. The global listener fires BEFORE the
    // focused component, so this works whether the editor or the overlay holds
    // focus (closing it from inside the overlay too).
    if (matchesKey(data, 'alt+g')) {
      graphOverlay.toggle();
      return { consume: true };
    }
    return undefined;
  });

  // Pane kill / daemon teardown arrives as a signal (raw mode swallows ctrl+c as
  // data, so SIGINT is unlikely, but handle it for completeness).
  const onSignal = (): void => teardown('signal');
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);
  process.once('SIGINT', onSignal);

  // 8. Lay out, focus the editor, start, then handshake. Starting before the
  //    handshake means the welcome's applySnapshot renders into a live TUI.
  tui.addChild(chatContainer);
  tui.addChild(chrome);
  tui.addChild(managers);
  tui.addChild(queued);
  tui.addChild(editor);
  tui.addChild(pickerPanel);
  tui.addChild(reports);
  tui.addChild(footer);
  tui.setFocus(editor);
  renderFooter();
  renderPanels();
  renderQueued();
  pollGitInfo();
  tui.start();

  sendHello();

  // Low-rate canvas-chrome refresh: repaint panels/overlay from canvas.db (child
  // status flips emit no broker event) and re-poll the ask map asynchronously.
  const ASKS_POLL_MS = 5_000;
  const pollChrome = (): void => {
    refreshChrome();
    pollGitInfo();
    fetchAsksAsync(climbRoot(nodeId), (counts) => {
      if (JSON.stringify(counts) !== JSON.stringify(asksMap)) {
        asksMap = counts;
        refreshChrome();
      }
    });
  };
  pollChrome();
  asksTimer = setInterval(pollChrome, ASKS_POLL_MS);
  if (typeof asksTimer.unref === 'function') asksTimer.unref();

  await done;
}

// ---------------------------------------------------------------------------
// Command registration (§3.6)
// ---------------------------------------------------------------------------

const attachToLeaf: LeafDef = defineLeaf({
  name: 'to',
  description: 'attach an interactive terminal viewer to a node\'s running broker',
  whenToUse:
    'you want to WATCH or DRIVE a headless node live in this pane — it connects over the node\'s unix socket to the broker that is already hosting the engine and renders the same chat stream, letting you type prompts (as the controller) or follow read-only (as an observer). It does NOT start the engine: the node must already have a running headless broker (focus or revive it first). One controller drives; extra viewers are read-only. ctrl+c / ctrl+d detaches and leaves the engine running',
  help: {
    name: 'attach to',
    summary:
      'attach a terminal viewer to a headless node\'s running broker (controller by default, --observer for read-only); detach with ctrl+c/ctrl+d, the engine runs on',
    params: [
      {
        kind: 'positional',
        name: 'node',
        required: true,
        constraint: 'Node id to attach to. Must already have a running headless broker.',
      },
      {
        kind: 'flag',
        name: 'observer',
        type: 'bool',
        required: false,
        default: false,
        constraint:
          'Attach READ-ONLY: never claim control even if it is free. Default: drive (claim control if available, else fall back to read-only).',
      },
    ],
    output: [
      {
        name: 'note',
        type: 'string',
        required: false,
        constraint: 'Only set on the non-TTY/piped path (a static notice); the interactive path returns nothing.',
      },
    ],
    outputKind: 'object',
    effects: [
      'Takes over the current pane in raw mode and renders the node\'s live engine stream until you detach (ctrl+c/ctrl+d) or the broker exits.',
      'As controller: sends prompts/steers/dialog answers to the engine over the socket. As observer: read-only.',
      'NEVER spawns pi and NEVER writes the session — it holds only a socket to the existing broker.',
      'Outside a TTY (piped): prints a short notice and exits 0 — attach is an interactive program, not a pipe stage.',
    ],
  },
  run: async (input) => {
    const nodeId = input['node'] as string;
    const observer = (input['observer'] as boolean | undefined) ?? false;

    // attach IS the in-pane interactive program — it only needs a TTY (crtr is
    // tmux-only, but the pane itself is the surface). Non-TTY (piped) → static
    // notice + exit, never a non-tmux interactive fallback.
    if (!process.stdout.isTTY) {
      return {
        note: `crtr attach is an interactive terminal viewer — run it in a tmux pane (a TTY), not a pipe. Node: ${nodeId}`,
      };
    }

    await runAttach(nodeId, observer);
    return;
  },
  render: (result) => (result['note'] !== undefined ? String(result['note']) : ''),
});

export function registerAttach(): BranchDef {
  return defineBranch({
    name: 'attach',
    rootEntry: {
      concept: 'a terminal viewer for a headless node — connect over its socket and drive (or watch) the live engine',
      desc: 'attach a terminal viewer to a headless node',
      useWhen:
        'you want to open a headless node live in this pane — watch its engine stream and drive it by typing, without the node ever running pi in your window. The node must already have a running headless broker; attach connects to it over a unix socket and never starts the engine itself. Detach (ctrl+c/ctrl+d) and the engine keeps running.',
    },
    help: {
      name: 'attach',
      summary: 'attach a terminal viewer to a headless node\'s running broker',
      model:
        '`to <node>` opens the viewer in the current pane (tmux-only; a TTY is required — piped it prints a notice and exits). By default it claims control and drives the engine (type to prompt; while the engine is streaming a submit steers the running turn); pass --observer to follow read-only. One controller + N observers per node. ctrl+c / ctrl+d detaches cleanly and the engine runs on; if the broker exits the viewer reports "broker gone" and exits. attach NEVER spawns pi or writes the session — it holds only a socket to the broker, which must already be running (focus or revive the node first).',
    },
    children: [attachToLeaf],
  });
}
