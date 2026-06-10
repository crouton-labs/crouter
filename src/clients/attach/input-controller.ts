// input-controller.ts — the input half of `crtr attach` (T6).
//
// Owns the editor's behavior: turns keystrokes + submits into `ClientToBroker`
// command frames (sent via `hooks.onCommand`), reads pasted clipboard images to
// attach to the next message (review M1), and renders blocking extension dialogs
// (delegating to T5's `renderDialog`, routing the answer through
// `hooks.onDialogResponse`). It NEVER touches the session or spawns pi — it only
// produces frames; T7's `attach-cmd.ts` constructs it and wires the socket.
//
// Keybinding matching is delegated to CustomEditor + its KeybindingsManager
// (built by config-load with the vendored `app.*` defs + user overrides) — that
// is what calls `matchesKey` internally, so the controller wires intent via the
// editor's `onSubmit`/`onEscape`/`onPasteImage` hooks + `onAction(app.*)`
// registrations rather than matching raw keys itself.

import type { CustomEditor } from '@earendil-works/pi-coding-agent';
import type { KeybindingsManager, TUI } from '@earendil-works/pi-tui';
import type { ImageContent } from '@earendil-works/pi-ai';
import {
  BROKER_READ_CAPS,
  encodeFrame,
  type BrokerSnapshot,
  type ClientToBroker,
  type RpcExtensionUIRequest,
  type RpcExtensionUIResponse,
} from '../../core/runtime/broker-protocol.js';
import { renderDialog, type DialogHandle } from './extension-dialogs.js';
import { readClipboardImage } from './clipboard-image.js';
import { dispatchSlashCommand, isSlashCommand, type SlashContext } from './slash-commands.js';

/** Aggregate budget for images held for the next message (review M2). A drained
 *  prompt/steer/follow_up frame inlines ALL pending images as base64 in a single
 *  frame; these ceilings keep the images[] portion well within the broker's
 *  24 MiB line cap. Each clipboard image is ≤ 3 MiB base64 (clipboard-image
 *  MAX_BYTES), so the worst case is MAX_PENDING_IMAGES × 3 MiB = 12 MiB. A paste
 *  that would exceed EITHER bound is refused (not accumulated). The WHOLE frame
 *  (images + unbounded text + JSON envelope) is then bounded airtight by the
 *  MAX_FRAME_BYTES guard in `emitDrive` — this budget alone is not enough, since
 *  `text` is otherwise unbounded. */
const MAX_PENDING_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_IMAGES = 4;

/** Largest drive frame the controller will emit. The broker DESTROYS the viewer
 *  socket on any client line over BROKER_READ_CAPS.maxLineBytes (24 MiB), so we
 *  refuse to emit within a 4 MiB margin of that. `emitDrive` measures the ACTUAL
 *  encoded frame (text + base64 images[] + JSON envelope), so the cap holds no
 *  matter how the bytes split — closing the gap where a large text paste plus
 *  max images could otherwise overflow and tear down the socket. */
const MAX_FRAME_BYTES = BROKER_READ_CAPS.maxLineBytes - 4 * 1024 * 1024;

export interface InputControllerHooks {
  /** Send a command frame to the broker. */
  onCommand: (frame: ClientToBroker) => void;
  /** Answer a blocking extension dialog. */
  onDialogResponse: (resp: RpcExtensionUIResponse) => void;
  /** OPTIONAL (additive to the fixed interface): surface a transient notice in
   *  the viewer. The InputController does not own the layout (T5/T7 do), so it
   *  reports notices up the same way it reports commands. Absent → notices are
   *  dropped silently. */
  onNotice?: (message: string) => void;
  /** OPTIONAL: the canvas node this viewer is attached to — forwarded to the
   *  slash context so `/promote` targets it (Unit Q wires it from runAttach). */
  nodeId?: string;
  /** OPTIONAL: toggle the GRAPH overlay — forwarded to the slash context so
   *  `/graph` opens/closes it (Unit Q wires it from runAttach). */
  onGraph?: () => void;
}

export class InputController {
  /** Images pasted since the last send, attached to the next prompt/follow-up. */
  private pendingImages: ImageContent[] = [];
  /** Running base64-byte total of `pendingImages` (review M2 aggregate budget). */
  private pendingImageBytes = 0;
  /** The currently-rendered blocking dialog, if any (for supersede/dismiss). */
  private dialog: DialogHandle | undefined;
  /** Latest engine state from `welcome`/`session_info_changed` (for `/session`). */
  private state: BrokerSnapshot['state'] | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly editor: CustomEditor,
    private readonly keybindings: KeybindingsManager,
    private readonly hooks: InputControllerHooks,
  ) {
    this.wire();
  }

  /** Render a blocking extension dialog and route its answer to the broker.
   *  Supersedes any dialog already on screen (e.g. a re-route on control
   *  handoff) by dismissing it first. */
  attachDialog(req: RpcExtensionUIRequest): void {
    this.dialog?.dismiss();
    this.dialog = renderDialog(
      this.tui,
      req,
      (resp) => {
        this.dialog = undefined;
        this.hooks.onDialogResponse(resp);
      },
      this.keybindings,
    );
    this.tui.requestRender();
  }

  /** Feed the latest engine state so read-only commands (e.g. `/session`) report
   *  current values. Optional; the controller works without it. */
  setState(state: BrokerSnapshot['state']): void {
    this.state = state;
  }

  // -------------------------------------------------------------------------

  private wire(): void {
    this.editor.onSubmit = (text) => this.handleSubmit(text);
    // Esc / app.interrupt → abort the running turn.
    this.editor.onEscape = () => this.hooks.onCommand({ type: 'abort' });
    // Ctrl+V / Alt+V → read clipboard image, hold it for the next message.
    this.editor.onPasteImage = () => {
      void this.handlePaste();
    };
    // Keyboard shortcuts that map 1:1 to a frame needing no engine-side data.
    this.editor.onAction('app.session.new', () => this.hooks.onCommand({ type: 'new_session' }));
    this.editor.onAction('app.model.cycleForward', () => this.hooks.onCommand({ type: 'cycle_model' }));
    this.editor.onAction('app.message.followUp', () => this.handleFollowUp());
  }

  private slashContext(): SlashContext {
    return {
      send: (frame) => this.hooks.onCommand(frame),
      notify: (message) => this.notify(message),
      state: this.state,
      cwd: process.cwd(),
      nodeId: this.hooks.nodeId,
      onGraph: this.hooks.onGraph,
    };
  }

  private handleSubmit(text: string): void {
    const trimmed = text.trim();
    if (!trimmed && this.pendingImages.length === 0) return;

    if (trimmed && isSlashCommand(trimmed)) {
      // Recognized builtin/scoped-out → handled here; unrecognized falls through
      // and is sent to the engine as a prompt (extension command).
      if (dispatchSlashCommand(trimmed, this.slashContext())) {
        this.editor.setText('');
        return;
      }
    }

    const images = this.pendingImagesPayload();
    // Submit-while-streaming = steer (pi-native parity): interject into the
    // running turn instead of queueing a fresh prompt. `isStreaming` is the
    // broker snapshot's busy signal; the broker routes `steer` → session.steer()
    // and `prompt` → session.prompt(). Idle / no state yet → prompt (safe default).
    const busy = this.state?.isStreaming === true;
    const frame: ClientToBroker = busy
      ? { type: 'steer', text: trimmed, images }
      : { type: 'prompt', text: trimmed, images };
    if (!this.emitDrive(frame)) return; // too large — keep editor + pending to trim
    this.clearPendingImages();
    if (trimmed) this.editor.addToHistory(trimmed);
    this.editor.setText('');
  }

  private handleFollowUp(): void {
    const text = this.editor.getText().trim();
    if (!text && this.pendingImages.length === 0) return;
    const images = this.pendingImagesPayload();
    if (!this.emitDrive({ type: 'follow_up', text, images })) return;
    this.clearPendingImages();
    if (text) this.editor.addToHistory(text);
    this.editor.setText('');
  }

  /** Send a drive frame iff the WHOLE encoded frame fits under MAX_FRAME_BYTES
   *  (the broker destroys the socket on any line over its 24 MiB read cap). Over
   *  the ceiling → notify + refuse so the caller leaves the editor + pending
   *  images intact for the user to trim, never a socket-destroying overflow. */
  private emitDrive(frame: ClientToBroker): boolean {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(encodeFrame(frame));
    } catch {
      this.notify('Message could not be encoded');
      return false;
    }
    if (bytes > MAX_FRAME_BYTES) {
      const mib = Math.round(bytes / (1024 * 1024));
      this.notify(`Message too large to send (${mib} MiB) — shorten the text or remove an attached image`);
      return false;
    }
    this.hooks.onCommand(frame);
    return true;
  }

  private async handlePaste(): Promise<void> {
    try {
      const result = await readClipboardImage();
      if (!result) {
        this.notify('No image in the clipboard');
        return;
      }
      // The clipboard layer read an image but DROPPED it (over its per-image
      // ceiling) — surface the reason and attach nothing.
      if (!result.image) {
        this.notify(result.note ?? 'Image not attached');
        return;
      }
      // Enforce the aggregate pending-image budget so the eventual drained frame
      // stays under the broker cap: refuse a paste that would breach the count or
      // byte ceiling rather than accumulate an over-cap images[] (review M2).
      const bytes = Buffer.byteLength(result.image.data);
      if (
        this.pendingImages.length + 1 > MAX_PENDING_IMAGES ||
        this.pendingImageBytes + bytes > MAX_PENDING_IMAGE_BYTES
      ) {
        this.notify('Image not attached: pending image budget exceeded — send your message first');
        return;
      }
      this.pendingImages.push(result.image);
      this.pendingImageBytes += bytes;
      this.notify(
        result.note
          ? `Image attached (${result.note}) — sends with your next message`
          : 'Image attached — sends with your next message',
      );
      this.tui.requestRender();
    } catch {
      this.notify('Could not read the clipboard image');
    }
  }

  /** Snapshot the pending images as an `images?` payload (undefined when none)
   *  WITHOUT clearing — so a frame refused by `emitDrive` (too large) keeps them
   *  for the user to trim. The caller clears via `clearPendingImages` only after a
   *  successful send. */
  private pendingImagesPayload(): ImageContent[] | undefined {
    return this.pendingImages.length === 0 ? undefined : this.pendingImages.slice();
  }

  /** Drop all pending images + reset the aggregate byte counter (after a send). */
  private clearPendingImages(): void {
    this.pendingImages = [];
    this.pendingImageBytes = 0;
  }

  private notify(message: string): void {
    this.hooks.onNotice?.(message);
  }
}
