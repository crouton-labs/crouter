// pickers.ts — native interactive pickers for `crtr attach`, built against the
// operator-view wire contract (broker read-op `data` frames). Each builder turns
// a serialized picker payload into the REAL pi `*SelectorComponent`, wired so a
// selection dispatches the SAME command frame the text-arg slash path sends and
// `close()` tears the overlay down. InputController owns the overlay lifecycle
// (showOverlay/dismiss) and the async data fetch; these are pure builders.
//
// R1 (contract): the tree/fork/settings payloads are PURE DATA — their selectors
// build verbatim, no reconstruction. The MODEL picker's `ModelSelectorComponent`
// needs a live `ModelRegistry`/`SettingsManager`: we feed the REAL component a
// minimal in-memory `SettingsManager` plus a tiny `ModelRegistry` adapter (the
// component calls only refresh/getError/getAvailable/find), preserving its full
// search + scope-toggle UI without crossing engine state over the socket. The
// SESSION picker reconstructs faithfully from async loaders (no shim). The
// SCOPED-MODELS component is NOT re-exported by pi 0.79.0 AND has no mutation
// frame in the contract, so it renders read-only via a pi-tui SelectList.

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
  ThinkingSelectorComponent,
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

/** A minimal `ModelRegistry` for `ModelSelectorComponent`: the component calls
 *  only `refresh()`, `getError()`, `getAvailable()`, and `find()` (verified
 *  against pi 0.79.0 `model-selector.js`). We satisfy exactly those from the
 *  wire payload — no auth/registry state crosses the socket — and cast to the
 *  nominal class the ctor wants. (Pin is exact at 0.79.0; if a future pi calls
 *  another method this fails fast at runtime, surfaced by live verification.) */
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
export function buildModelPicker(tui: TUI, data: ListModelsData, send: Send, close: Close): Component {
  const all = data.models;
  const availableSet = new Set(data.availableIds);
  const available = all.filter((m) => availableSet.has(`${m.provider}/${m.id}`));
  const current = data.current
    ? all.find((m) => m.provider === data.current!.provider && m.id === data.current!.id)
    : undefined;
  return new ModelSelectorComponent(
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
): Component {
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
  return new SessionSelectorComponent(
    currentLoader,
    allLoader,
    (path) => {
      send({ type: 'switch_session', path });
      close();
    },
    () => close(),
    () => close(),
    () => tui.requestRender(),
    { showRenameHint: false, keybindings },
    prefetchedCwd.currentSessionFile,
  );
}

/** `/tree` — the real tree navigator (pure data). Select → `navigate_tree`.
 *  Label-edit is out of scope (no command frame) → no `onLabelChange`. */
export function buildTreePicker(tui: TUI, data: GetTreeData, send: Send, close: Close): Component {
  const terminalHeight = process.stdout.rows ?? 24;
  return new TreeSelectorComponent(
    data.tree as unknown as TreeArg,
    data.currentLeafId,
    terminalHeight,
    (entryId) => {
      send({ type: 'navigate_tree', targetId: entryId });
      close();
    },
    () => close(),
  );
}

/** `/fork` — the real prior-user-message selector (pure data, from
 *  `get_tree.forkPoints`). Select → `fork`. */
export function buildForkPicker(data: GetTreeData, send: Send, close: Close): Component {
  return new UserMessageSelectorComponent(
    data.forkPoints,
    (entryId) => {
      send({ type: 'fork', entryId });
      close();
    },
    () => close(),
  );
}

/** `/settings` — the real settings menu (the wire `settings` IS a SettingsConfig
 *  superset). Only the contract-enumerated mutations are wired: thinking level →
 *  `set_thinking_level`, auto-compact → `set_auto_compaction`. Every other toggle
 *  has no command frame (out of scope), so its callback notifies rather than
 *  silently lying that the change took. The theme submenu is viewer-local (CTO). */
export function buildSettingsPicker(data: GetSettingsData, send: Send, close: Close, notify: Notify): Component {
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
    onClearOnShrinkChange: out,
    onShowTerminalProgressChange: out,
    onWarningsChange: out,
  };
  return new SettingsSelectorComponent(data.settings as SettingsConfig, callbacks);
}

/** Standalone thinking-level picker (pure data, from `get_settings`). Not bound
 *  to a slash command itself, but available for a keybinding/caller that wants
 *  just the level menu. Select → `set_thinking_level`. */
export function buildThinkingPicker(data: GetSettingsData, send: Send, close: Close): Component {
  return new ThinkingSelectorComponent(
    data.settings.thinkingLevel,
    data.settings.availableThinkingLevels,
    (level) => {
      send({ type: 'set_thinking_level', level });
      close();
    },
    () => close(),
  );
}

/** `/scoped-models` — READ-ONLY via a pi-tui SelectList. CONTRACT GAP: pi 0.79.0
 *  does not re-export `ScopedModelsSelectorComponent`, and the contract exposes no
 *  command frame for its enable/disable/persist mutations, so a faithful editable
 *  picker is not buildable in scope. This shows the registry with the enabled set
 *  marked; select notifies that toggling is unsupported. */
export function buildScopedModelsPicker(data: ListScopedModelsData, close: Close, notify: Notify): Component {
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
  return list;
}
