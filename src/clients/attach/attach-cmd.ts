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
import {
  Container,
  ProcessTerminal,
  Text,
  TUI,
  matchesKey,
  type EditorTheme,
} from '@earendil-works/pi-tui';
import {
  CustomEditor,
  getSelectListTheme,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import { defineBranch, defineLeaf } from '../../core/command.js';
import type { BranchDef, LeafDef } from '../../core/command.js';
import { InputError } from '../../core/io.js';
import { getNode } from '../../core/canvas/index.js';
import type {
  BrokerSnapshot,
  BrokerToClient,
  ClientRole,
} from '../../core/runtime/broker-protocol.js';
import { ChatView } from './chat-view.js';
import { InputController } from './input-controller.js';
import { applyTheme, createKeybindingsManager } from './config-load.js';
import { BrokerUnavailableError, ViewSocketClient } from './view-socket.js';

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

  // 1. Theme + keybindings FIRST — pi's components throw "Theme not initialized"
  //    otherwise (T5 contract). One KeybindingsManager feeds BOTH editor + input.
  applyTheme({ cwd: meta.cwd });
  const km = createKeybindingsManager();

  // 2. TUI + chat container + editor.
  const tui = new TUI(new ProcessTerminal());
  const chatContainer = new Container();
  const footer = new Container();
  const editorTheme: EditorTheme = { borderColor: (s) => s, selectList: getSelectListTheme() };
  const editor = new CustomEditor(tui, editorTheme, km as unknown as EditorKeybindings, { paddingX: 1 });

  // 3. Render layer (T5). ChatView owns the chat scroll + activity spinner; the
  //    footer/status line below is ours, so onFooterEvent is left unset (footer
  //    updates flow through handleBrokerFrame's single update path instead).
  const chatView = new ChatView(tui, chatContainer, { cwd: meta.cwd });

  // 4. Footer/status line — surfaces role + live state + transient notices.
  const clientId = randomUUID();
  let role: ClientRole = observer ? 'observer' : 'controller';
  let liveState: BrokerSnapshot['state'] | undefined;
  let notice = '';
  const renderFooter = (): void => {
    const bits: string[] = [role === 'controller' ? 'drive' : 'read-only'];
    if (liveState?.model) bits.push(liveState.model);
    if (liveState?.isStreaming) bits.push('streaming');
    if (liveState?.sessionName) bits.push(liveState.sessionName);
    if (liveState && liveState.pendingMessageCount > 0) bits.push(`queued ${liveState.pendingMessageCount}`);
    let line = `\x1b[2m${bits.join(' · ')}\x1b[22m`;
    if (notice) line += `   \x1b[33m${notice}\x1b[39m`;
    footer.clear();
    footer.addChild(new Text(line, 1, 0));
    tui.requestRender();
  };
  const setNotice = (msg: string): void => {
    notice = msg;
    renderFooter();
  };

  // 5. Input layer (T6). onCommand/onDialogResponse → socket; onNotice → footer.
  const input = new InputController(tui, editor, km, {
    onCommand: (frame) => socket.send(frame),
    onDialogResponse: (resp) => socket.send(resp),
    onNotice: (msg) => setNotice(msg),
  });

  // Feed fresh state into the input controller AND the footer. Steer-vs-prompt
  // routing (T6) reads `state.isStreaming`, so this must stay current — the
  // broker only ships full state in `welcome`, so we patch isStreaming/name/etc
  // from the relayed event stream below.
  const setLiveState = (state: BrokerSnapshot['state']): void => {
    liveState = state;
    input.setState(state);
    renderFooter();
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
      case 'error': {
        if (frame.code === 'not_controller') {
          setNotice('read-only — another viewer is the controller');
        } else {
          setNotice(`error: ${frame.message}`);
        }
        break;
      }
      case 'ack': {
        // Dynamic-command autocomplete (feeding get_commands into T6's palette)
        // is DEFERRED for Phase 4 (would require editing T6's input-controller —
        // out of my 3-file scope; the fall-through-to-prompt path already makes
        // extension commands functional). Surface only command failures here.
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
        else if (event.type === 'thinking_level_changed') patchState({ thinkingLevel: event.level });
        else if (event.type === 'queue_update') {
          patchState({ pendingMessageCount: event.steering.length + event.followUp.length });
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
  const teardown = (reason: 'detach' | 'broker-gone' | 'signal'): void => {
    if (tornDown) return;
    tornDown = true;
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

  // Permanent socket wiring (the connect-race listeners are gone).
  socket.on('frame', handleBrokerFrame);
  socket.on('error', (err) => {
    // Stash the reason; a 'close' follows and teardown converges there, where a
    // broker-gone message prefers this over the generic text.
    lastSocketError = err.message;
  });
  socket.on('close', () => teardown('broker-gone'));

  // ctrl+c / ctrl+d → detach (T6 left these unwired; lifecycle is ours). A
  // global TUI input listener fires BEFORE the focused component (and before any
  // dialog overlay), so detach is unconditional and consistent.
  const removeKeyListener = tui.addInputListener((data) => {
    if (matchesKey(data, 'ctrl+c') || matchesKey(data, 'ctrl+d')) {
      teardown('detach');
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
  tui.addChild(footer);
  tui.addChild(editor);
  tui.setFocus(editor);
  renderFooter();
  tui.start();

  socket.send({
    type: 'hello',
    role: observer ? 'observer' : 'controller',
    client_id: clientId,
    term: { cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 },
  });

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
