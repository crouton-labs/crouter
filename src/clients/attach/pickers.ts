// pickers.ts — native interactive pickers for `crtr attach`, built against the
// operator-view wire contract (broker read-op `data` frames). Each builder turns
// a serialized picker payload into the REAL pi `*SelectorComponent`, wired so a
// selection dispatches the SAME command frame the text-arg slash path sends and
// `close()` tears the overlay down. InputController owns the overlay lifecycle
// (showOverlay/dismiss/focus) and the async data fetch; these are pure builders.
//
// FOCUS (load-bearing): some selectors put `handleInput` on an INNER list, not
// the outer Container (UserMessageSelectorComponent → getMessageList(),
// SettingsSelectorComponent → getSettingsList()). pi-tui drops every keystroke
// when the focused component has no `handleInput`, so each builder returns BOTH
// the overlay `component` AND the `focus` target the caller must focus — exactly
// as pi's own interactive-mode does (`{ component, focus }`).
//
// R1 (contract): the tree/fork/settings payloads are PURE DATA — their selectors
// build verbatim, no reconstruction. The MODEL picker's `ModelSelectorComponent`
// needs a live `ModelRegistry`/`SettingsManager`: we feed the REAL component a
// minimal in-memory `SettingsManager` plus a tiny `ModelRegistry` adapter (the
// component calls only refresh/getError/getAvailable/find — verified against
// model-selector.js), preserving its full search + scope-toggle UI without
// crossing engine state over the socket. The SESSION picker reconstructs
// faithfully from async loaders (no shim). The SCOPED-MODELS component is NOT
// re-exported by pi (through 0.79.1) AND has no mutation frame in the contract,
// so it renders read-only via a pi-tui SelectList.
//
// pi pin is `^0.79.1` (a RANGE): the duck-typed registry adapter relies on the
// component's current 4-method registry surface — a future 0.79.x adding a
// registry call would surface at runtime (caught by live verification).

import type { Api, Model } from '@earendil-works/pi-ai';
import {
  SelectList,
  type Component,
  type KeybindingsManager,
  type SelectItem,
  type SelectListTheme,
  type TUI,
} from '@earendil-works/pi-tui';
import {
  getSelectListTheme,
  ModelSelectorComponent,
  SessionSelectorComponent,
  SettingsSelectorComponent,
  TreeSelectorComponent,
  UserMessageSelectorComponent,
  SettingsManager,
  type ModelRegistry,
  type SettingsCallbacks,
  type SettingsConfig,
} from '@earendil-works/pi-coding-agent';
import type {
  ClientToBroker,
  GetSettingsData,
  GetTreeData,
  ListModelsData,
  ListScopedModelsData,
  ListSessionsData,
} from '../../core/runtime/broker-protocol.js';
import type { ReadOpRequest } from './view-socket.js';

/** A built picker overlay: the `component` to show, and the `focus` target the
 *  caller must `setFocus` (the component itself, or the inner list that owns
 *  `handleInput`). */
export interface Picker {
  component: Component;
  focus: Component;
}

/** Controls handed to a picker builder by InputController.showPicker. `close`
 *  tears the whole picker down + restores editor focus; `replace` swaps the
 *  CURRENTLY-mounted component for a new one IN THE SAME inline slot (no centered
 *  overlay), focusing it — used by multi-step flows like /login, where selecting
 *  a provider replaces the selector with the login dialog right under the editor. */
export interface PickerControls {
  close: () => void;
  replace: (component: Component, focus: Component) => void;
}

/** Send a command frame to the broker (= InputController hooks.onCommand). */
type Send = (frame: ClientToBroker) => void;
/** Issue a correlated read-op (lazy loaders need it after construction). */
type Request = (frame: ReadOpRequest) => Promise<unknown>;
/** Tear the picker overlay down (owned by InputController). */
type Close = () => void;
/** Surface a one-line viewer notice. */
type Notify = (message: string) => void;

/** Constructor param types we cannot name directly (pi does not re-export
 *  `SessionTreeNode` / its scoped item types) — pulled off the real ctors. */
type TreeArg = ConstructorParameters<typeof TreeSelectorComponent>[0];
type SessionInfoLike = Awaited<ReturnType<ConstructorParameters<typeof SessionSelectorComponent>[0]>>[number];
/** pi's CORE KeybindingsManager (a subclass of pi-tui's) that
 *  `SessionSelectorComponent`'s options expect — widened from the ctor so we
 *  needn't import the type-only core class (mirrors extension-dialogs.ts). */
type SessionKeybindings = NonNullable<ConstructorParameters<typeof SessionSelectorComponent>[6]>['keybindings'];

/** A minimal `ModelRegistry` for `ModelSelectorComponent`: the component calls
 *  only `refresh()`, `getError()`, `getAvailable()`, and `find()` (verified
 *  against pi `model-selector.js`). We satisfy exactly those from the wire
 *  payload — no auth/registry state crosses the socket — and cast to the nominal
 *  class the ctor wants. */
function modelRegistryAdapter(all: Model<Api>[], available: Model<Api>[]): ModelRegistry {
  const adapter = {
    refresh(): void {},
    getError(): string | undefined {
      return undefined;
    },
    getAvailable(): Model<Api>[] {
      return available;
    },
    find(provider: string, id: string): Model<Api> | undefined {
      return all.find((m) => m.provider === provider && m.id === id);
    },
  };
  return adapter as unknown as ModelRegistry;
}

/** `/model` (and ctrl+l) — the real model selector with search + scope toggle.
 *  Select → `set_model` with the resolved `provider/id` (the broker's
 *  `findModelSpec` requires that form). */
export function buildModelPicker(tui: TUI, data: ListModelsData, send: Send, close: Close): Picker {
  const all = data.models;
  const availableSet = new Set(data.availableIds);
  const available = all.filter((m) => availableSet.has(`${m.provider}/${m.id}`));
  const current = data.current
    ? all.find((m) => m.provider === data.current!.provider && m.id === data.current!.id)
    : undefined;
  const component = new ModelSelectorComponent(
    tui,
    current,
    SettingsManager.inMemory(),
    modelRegistryAdapter(all, available),
    data.scopedModels,
    (model) => {
      send({ type: 'set_model', model: `${model.provider}/${model.id}` });
      close();
    },
    () => close(),
  );
  return { component, focus: component };
}

/** `/resume` — the real session selector. Reconstructs from async loaders that
 *  fetch each scope on demand (cwd is pre-fetched so the current-session marker
 *  shows immediately; the `all` scope loads only on toggle). Select →
 *  `switch_session`. Rename/delete are out of scope (no command frame). */
export function buildSessionPicker(
  tui: TUI,
  prefetchedCwd: ListSessionsData,
  request: Request,
  keybindings: KeybindingsManager,
  send: Send,
  close: Close,
): Picker {
  const revive = (d: ListSessionsData): SessionInfoLike[] =>
    d.sessions.map(
      (s) => ({ ...s, created: new Date(s.created), modified: new Date(s.modified) }) as unknown as SessionInfoLike,
    );
  let firstCwd = true;
  const currentLoader = async (): Promise<SessionInfoLike[]> => {
    if (firstCwd) {
      firstCwd = false;
      return revive(prefetchedCwd);
    }
    return revive((await request({ type: 'list_sessions', scope: 'cwd' })) as ListSessionsData);
  };
  const allLoader = async (): Promise<SessionInfoLike[]> =>
    revive((await request({ type: 'list_sessions', scope: 'all' })) as ListSessionsData);
  const component = new SessionSelectorComponent(
    currentLoader,
    allLoader,
    (path) => {
      send({ type: 'switch_session', path });
      close();
    },
    () => close(),
    () => close(),
    () => tui.requestRender(),
    { showRenameHint: false, keybindings: keybindings as unknown as SessionKeybindings },
    prefetchedCwd.currentSessionFile,
  );
  return { component, focus: component };
}

/** `/tree` — the real tree navigator (pure data). Select → `navigate_tree`.
 *  Label-edit is out of scope (no command frame) → no `onLabelChange`. */
export function buildTreePicker(tui: TUI, data: GetTreeData, send: Send, close: Close): Picker {
  const terminalHeight = process.stdout.rows ?? 24;
  const component = new TreeSelectorComponent(
    data.tree as unknown as TreeArg,
    data.currentLeafId,
    terminalHeight,
    (entryId) => {
      send({ type: 'navigate_tree', targetId: entryId });
      close();
    },
    () => close(),
  );
  return { component, focus: component };
}

/** `/fork` — the real prior-user-message selector (pure data, from
 *  `get_tree.forkPoints`). Select → `fork`. The outer component has no
 *  `handleInput`; the inner `getMessageList()` does (focus target). */
export function buildForkPicker(data: GetTreeData, send: Send, close: Close): Picker {
  const component = new UserMessageSelectorComponent(
    data.forkPoints,
    (entryId) => {
      send({ type: 'fork', entryId });
      close();
    },
    () => close(),
  );
  return { component, focus: component.getMessageList() };
}

/** `/settings` — the real settings menu (the wire `settings` IS a SettingsConfig
 *  superset). Only the contract-enumerated mutations are wired: thinking level →
 *  `set_thinking_level`, auto-compact → `set_auto_compaction`. Every other toggle
 *  has no command frame (out of scope), so its callback notifies rather than
 *  silently lying that the change took. The theme submenu is viewer-local (CTO).
 *  The outer component has no `handleInput`; `getSettingsList()` is the focus
 *  target. */
export function buildSettingsPicker(data: GetSettingsData, send: Send, close: Close, notify: Notify): Picker {
  const out = (): void => notify('Only thinking level + auto-compaction are adjustable over view.sock');
  const callbacks: SettingsCallbacks = {
    onThinkingLevelChange: (level) => send({ type: 'set_thinking_level', level }),
    onAutoCompactChange: (enabled) => send({ type: 'set_auto_compaction', enabled }),
    onCancel: () => close(),
    onShowImagesChange: out,
    onImageWidthCellsChange: out,
    onAutoResizeImagesChange: out,
    onBlockImagesChange: out,
    onEnableSkillCommandsChange: out,
    onSteeringModeChange: out,
    onFollowUpModeChange: out,
    onTransportChange: out,
    onHttpIdleTimeoutMsChange: out,
    onThemeChange: out,
    onHideThinkingBlockChange: out,
    onCollapseChangelogChange: out,
    onEnableInstallTelemetryChange: out,
    onDoubleEscapeActionChange: out,
    onTreeFilterModeChange: out,
    onShowHardwareCursorChange: out,
    onEditorPaddingXChange: out,
    onAutocompleteMaxVisibleChange: out,
    onQuietStartupChange: out,
    onDefaultProjectTrustChange: out,
    onClearOnShrinkChange: out,
    onShowTerminalProgressChange: out,
    onWarningsChange: out,
  };
  const component = new SettingsSelectorComponent(data.settings as SettingsConfig, callbacks);
  return { component, focus: component.getSettingsList() };
}

/** `/scoped-models` — READ-ONLY via a pi-tui SelectList. CONTRACT GAP: pi (through
 *  0.79.1) does not re-export `ScopedModelsSelectorComponent`, and the contract
 *  exposes no command frame for its enable/disable/persist mutations, so a
 *  faithful editable picker is not buildable in scope. This shows the registry
 *  with the enabled set marked; select notifies that toggling is unsupported. */
export function buildScopedModelsPicker(data: ListScopedModelsData, close: Close, notify: Notify): Picker {
  const enabled = data.enabledModelIds;
  const isEnabled = (m: Model<Api>): boolean => {
    if (enabled === null) return true; // null = no scoping, every model cycles
    const ref = `${m.provider}/${m.id}`;
    return enabled.includes(ref) || enabled.includes(m.id) || enabled.includes('*');
  };
  const items: SelectItem[] = data.allModels.map((m) => ({
    value: `${m.provider}/${m.id}`,
    label: `${isEnabled(m) ? '✓' : ' '} ${m.provider}/${m.id}`,
    description: m.name,
  }));
  const theme: SelectListTheme = getSelectListTheme();
  const list = new SelectList(items, 12, theme);
  list.onSelect = () => notify("Enabling/disabling scoped models isn't supported over view.sock yet");
  list.onCancel = () => close();
  return { component: list, focus: list };
}
