// extension-dialogs.ts — the blocking-dialog renderer for `crtr attach` (T5).
//
// The broker forwards an extension's user-blocking UI request as an
// `extension_ui_request` frame (RpcExtensionUIRequest). The viewer renders it
// with pi's matching exported component and ships the resolved
// `extension_ui_response` (RpcExtensionUIResponse) back over the socket.
//
// Only the 4 blocking methods carry behavior — and they are the only ones the
// broker ever routes as a request: `makeBrokerUiContext` (broker.ts) no-ops
// notify/setStatus/setWidget/setTitle/set_editor_text, so those never arrive as
// a blocking dialog. `isBlockingDialog` lets the caller filter cleanly; for a
// non-blocking method, `renderDialog` returns an inert handle (no overlay, no
// response — there is nothing to answer).
//
// Mapping (mirrors interactive-mode.js): select → ExtensionSelectorComponent;
// confirm → the SAME selector over ["Yes","No"] (pi has no separate confirm
// component, :1658); input → ExtensionInputComponent; editor →
// ExtensionEditorComponent. The select/input components run their own
// timeout/countdown when `req.timeout` is present; editor takes none. The broker
// ALSO arms a default timeout, so a dialog may be superseded by the broker
// resolving first — `dismiss()` tears the overlay down cleanly without
// responding (the response would be a no-op the broker drops by id).

import {
  KeybindingsManager,
  TUI_KEYBINDINGS,
  type Component,
  type OverlayHandle,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  ExtensionEditorComponent,
  ExtensionInputComponent,
  ExtensionSelectorComponent,
} from '@earendil-works/pi-coding-agent';
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from '../../core/runtime/broker-protocol.js';

/** Handle for a rendered dialog: tear it down (without responding) when the
 *  request is superseded — e.g. the broker resolves it on its own timeout, or a
 *  control handoff re-routes it. */
export interface DialogHandle {
  dismiss(): void;
}

/** The 4 user-blocking dialog methods. The other 5 RpcExtensionUIRequest methods
 *  are non-blocking display ops (notify/setStatus/setWidget/setTitle/
 *  set_editor_text) the broker never forwards as a request. */
export function isBlockingDialog(req: RpcExtensionUIRequest): boolean {
  return (
    req.method === 'select' ||
    req.method === 'confirm' ||
    req.method === 'input' ||
    req.method === 'editor'
  );
}

/** pi's CORE KeybindingsManager type, as `ExtensionEditorComponent` expects it —
 *  taken from the constructor signature so we needn't import the type-only class. */
type EditorKeybindings = ConstructorParameters<typeof ExtensionEditorComponent>[1];

const INERT: DialogHandle = { dismiss: () => {} };

const OVERLAY_OPTIONS = { anchor: 'center', width: '70%', maxHeight: '80%' } as const;

/**
 * Render a blocking extension dialog as a focused overlay over `tui`, and resolve
 * by invoking `onRespond` with the matching `extension_ui_response` (or a
 * `cancelled` response on user-cancel/timeout). Returns a {@link DialogHandle}
 * whose `dismiss()` removes the overlay without responding (idempotent; safe to
 * call after the dialog already resolved).
 *
 * @param keybindings - used only by the `editor` dialog, which calls
 *   `keybindings.matches(key, "app.editor.external")` for the Ctrl+G external-editor
 *   shortcut. Defaults to a fresh `KeybindingsManager(TUI_KEYBINDINGS)` — that
 *   knows the base TUI bindings but not pi's app-level `app.editor.external`, so
 *   Ctrl+G is inert until the input controller (T6) passes the app keybindings
 *   manager. `ExtensionEditorComponent` is typed against pi's CORE
 *   KeybindingsManager (a subclass of pi-tui's), so we widen via the constructor's
 *   own parameter type rather than importing the core class (type-only export).
 */
export function renderDialog(
  tui: TUI,
  req: RpcExtensionUIRequest,
  onRespond: (resp: RpcExtensionUIResponse) => void,
  keybindings?: KeybindingsManager,
): DialogHandle {
  if (!isBlockingDialog(req)) return INERT;

  let done = false;
  let handle: OverlayHandle | undefined;
  let component: Component | undefined;

  const teardown = (): void => {
    handle?.hide();
    const disposable = component as { dispose?: () => void } | undefined;
    try {
      disposable?.dispose?.();
    } catch {
      /* ignore dispose errors during teardown */
    }
  };

  const respond = (resp: RpcExtensionUIResponse): void => {
    if (done) return;
    done = true;
    teardown();
    onRespond(resp);
  };

  const cancel = (): void => respond({ type: 'extension_ui_response', id: req.id, cancelled: true });

  switch (req.method) {
    case 'select':
      component = new ExtensionSelectorComponent(
        req.title,
        req.options,
        (option) => respond({ type: 'extension_ui_response', id: req.id, value: option }),
        cancel,
        { tui, timeout: req.timeout },
      );
      break;

    case 'confirm':
      component = new ExtensionSelectorComponent(
        `${req.title}\n${req.message}`,
        ['Yes', 'No'],
        (option) => respond({ type: 'extension_ui_response', id: req.id, confirmed: option === 'Yes' }),
        cancel,
        { tui, timeout: req.timeout },
      );
      break;

    case 'input':
      component = new ExtensionInputComponent(
        req.title,
        req.placeholder,
        (value) => respond({ type: 'extension_ui_response', id: req.id, value }),
        cancel,
        { tui, timeout: req.timeout },
      );
      break;

    case 'editor':
      component = new ExtensionEditorComponent(
        tui,
        (keybindings ?? new KeybindingsManager(TUI_KEYBINDINGS)) as EditorKeybindings,
        req.title,
        req.prefill,
        (value) => respond({ type: 'extension_ui_response', id: req.id, value }),
        cancel,
      );
      break;

    default:
      return INERT;
  }

  handle = tui.showOverlay(component, OVERLAY_OPTIONS);

  return {
    dismiss: () => {
      if (done) return;
      done = true;
      teardown();
    },
  };
}
