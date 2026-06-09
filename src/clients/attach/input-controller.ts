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
import type {
  BrokerSnapshot,
  ClientToBroker,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
} from '../../core/runtime/broker-protocol.js';
import { renderDialog, type DialogHandle } from './extension-dialogs.js';
import { readClipboardImage } from './clipboard-image.js';
import { dispatchSlashCommand, isSlashCommand, type SlashContext } from './slash-commands.js';

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
}

export class InputController {
  /** Images pasted since the last send, attached to the next prompt/follow-up. */
  private pendingImages: ImageContent[] = [];
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

    const images = this.takePendingImages();
    this.hooks.onCommand({ type: 'prompt', text: trimmed, images });
    if (trimmed) this.editor.addToHistory(trimmed);
    this.editor.setText('');
  }

  private handleFollowUp(): void {
    const text = this.editor.getText().trim();
    if (!text && this.pendingImages.length === 0) return;
    const images = this.takePendingImages();
    this.hooks.onCommand({ type: 'follow_up', text, images });
    if (text) this.editor.addToHistory(text);
    this.editor.setText('');
  }

  private async handlePaste(): Promise<void> {
    try {
      const result = await readClipboardImage();
      if (!result) {
        this.notify('No image in the clipboard');
        return;
      }
      this.pendingImages.push(result.image);
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

  /** Drain pending images into an `images?` payload (undefined when none). */
  private takePendingImages(): ImageContent[] | undefined {
    if (this.pendingImages.length === 0) return undefined;
    const images = this.pendingImages.slice();
    this.pendingImages = [];
    return images;
  }

  private notify(message: string): void {
    this.hooks.onNotice?.(message);
  }
}
