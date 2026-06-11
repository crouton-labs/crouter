// auth-pickers.ts — native /login and /logout overlays for `crtr attach`.
//
// Runs pi's REAL OAuth/API-key login flow locally in the viewer process.
// Since crtr attach is tmux-local only (viewer + broker = same machine, same
// filesystem), we can construct a local AuthStorage pointing at the SAME
// auth.json the broker uses — no socket round-trip needed for auth mutations.
//
// The OAuthSelectorComponent (provider picker) and LoginDialogComponent (the
// actual login flow UI) are pi's own exported components, used verbatim.

import { join } from 'node:path';
import { execFile } from 'node:child_process';
import {
  AuthStorage,
  ModelRegistry,
  OAuthSelectorComponent,
  LoginDialogComponent,
  type AuthStatus,
} from '@earendil-works/pi-coding-agent';

/** Provider entry for OAuthSelectorComponent. Mirrors the `AuthSelectorProvider`
 *  type defined in pi's oauth-selector (not re-exported from the package root). */
type AuthSelectorProvider = {
  id: string;
  name: string;
  authType: 'oauth' | 'api_key';
};
import type { TUI } from '@earendil-works/pi-tui';
import type { Picker, PickerControls } from './pickers.js';

/** Build an AuthStorage + ModelRegistry from the broker's agentDir (or pi's
 *  default). Both point at the SAME auth.json the broker uses — the viewer and
 *  broker share the filesystem (tmux-local invariant). */
function buildLocalAuth(agentDir: string): { authStorage: AuthStorage; registry: ModelRegistry } {
  const authPath = join(agentDir, 'auth.json');
  const modelsPath = join(agentDir, 'models.json');
  const authStorage = AuthStorage.create(authPath);
  const registry = ModelRegistry.create(authStorage, modelsPath);
  return { authStorage, registry };
}

/** Assemble the AuthSelectorProvider list for the OAuth selector: OAuth providers
 *  from authStorage.getOAuthProviders() (authType 'oauth') + API-key providers
 *  derived from the registry's known providers that aren't OAuth (authType 'api_key').
 *  Mirrors how pi's interactive mode composes its login list. */
function buildProviderList(
  authStorage: AuthStorage,
  registry: ModelRegistry,
): AuthSelectorProvider[] {
  const oauthProviders = authStorage.getOAuthProviders();
  const oauthIds = new Set(oauthProviders.map((p) => p.id));

  const providers: AuthSelectorProvider[] = oauthProviders.map((p) => ({
    id: p.id,
    name: p.name,
    authType: 'oauth' as const,
  }));

  // Add API-key providers from the registry that aren't OAuth providers.
  const allModels = registry.getAll();
  const seenProviders = new Set<string>(oauthIds);
  for (const m of allModels) {
    if (!seenProviders.has(m.provider)) {
      seenProviders.add(m.provider);
      providers.push({
        id: m.provider,
        name: registry.getProviderDisplayName(m.provider),
        authType: 'api_key' as const,
      });
    }
  }
  return providers;
}

/** Open the browser with a URL (best-effort; platform-specific). */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  execFile(cmd, [url], { timeout: 5_000 }, () => {
    /* best-effort: browser open is fire-and-forget */
  });
}

/** `/login` — show the provider selector, then run pi's native login flow in
 *  the viewer. On success, notifies the broker to reload auth via reload_auth.
 *  Returns a Picker (OAuthSelectorComponent as the overlay). */
export function buildLoginPicker(
  tui: TUI,
  agentDir: string,
  onAuthReloaded: () => void,
  notify: (msg: string) => void,
  controls: PickerControls,
): Picker {
  const { close, replace } = controls;
  const { authStorage, registry } = buildLocalAuth(agentDir);
  const providers = buildProviderList(authStorage, registry);

  const getAuthStatus = (id: string): AuthStatus => authStorage.getAuthStatus(id);

  const onSelect = (providerId: string): void => {
    const provider = providers.find((p) => p.id === providerId);
    if (provider === undefined) {
      notify(`Unknown provider: ${providerId}`);
      close();
      return;
    }

    // `finish()` is the single idempotent exit for the login dialog: tear the
    // whole picker down (which restores editor focus), exactly once, no matter
    // which path (success, failure, or an Esc-cancel that aborts mid-flow) gets
    // there first. The OAuth/cancel paths resolve through DIFFERENT channels (the
    // login() promise vs the dialog's onComplete), so the guard prevents a double
    // close + double notify.
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      close();
    };

    const dialog = new LoginDialogComponent(
      tui,
      providerId,
      (success, message) => {
        // The dialog's own completion (chiefly an Esc-cancel). On a real OAuth
        // success the login() promise below already finished + notified, so the
        // settled guard makes this a no-op then.
        if (settled) return;
        if (success) {
          notify(`Logged in to ${provider.name}`);
          onAuthReloaded();
        } else {
          notify(message ? `Login failed: ${message}` : `Login to ${provider.name} was cancelled`);
        }
        finish();
      },
      provider.name,
    );

    // Swap the provider selector for the login dialog IN PLACE — it renders
    // inline under the editor (same slot as the model picker), not as a centered
    // overlay. `replace` focuses the dialog; `close()` (via finish) unmounts it.
    replace(dialog, dialog);

    if (provider.authType === 'oauth') {
      const isKnownOAuth = authStorage.getOAuthProviders().some((p) => p.id === providerId);
      if (!isKnownOAuth) {
        // An extension-registered provider: its OAuth impl lives in the broker's
        // registry, not the viewer's local one, so we cannot drive the flow here.
        dialog.showInfo([
          `Provider "${provider.name}" is extension-registered and cannot be logged in`,
          `from the viewer (the extension runs in the broker, not here).`,
          `Run /login directly in the node's terminal, or log in via the pi CLI.`,
        ]);
        // The dialog stays up; an Esc routes through onComplete → finish().
        return;
      }

      authStorage
        .login(providerId, {
          onAuth: (info: { url: string; instructions?: string }): void => {
            dialog.showAuth(info.url, info.instructions);
            openBrowser(info.url);
          },
          onDeviceCode: (info): void => {
            dialog.showDeviceCode(info);
            openBrowser(info.verificationUri);
          },
          onPrompt: (prompt: {
            message: string;
            placeholder?: string;
            allowEmpty?: boolean;
          }): Promise<string> => dialog.showPrompt(prompt.message, prompt.placeholder),
          onProgress: (message: string): void => {
            dialog.showProgress(message);
          },
          onManualCodeInput: (): Promise<string> =>
            dialog.showManualInput('Paste the code or URL:'),
          onSelect: async (prompt: {
            message: string;
            options: { id: string; label: string }[];
          }): Promise<string | undefined> => {
            const labels = prompt.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n');
            const answer = await dialog.showPrompt(`${prompt.message}\n${labels}`, '1');
            const idx = parseInt(answer, 10) - 1;
            return prompt.options[idx]?.id;
          },
          signal: dialog.signal,
        })
        .then(() => {
          if (settled) return; // a cancel/abort already closed it
          notify(`Logged in to ${provider.name}`);
          onAuthReloaded();
          finish();
        })
        .catch((err: unknown) => {
          // An Esc-cancel aborts the flow; the dialog's onComplete already
          // notified + finished, so only report a genuine error here.
          if ((err as Error)?.name !== 'AbortError') {
            notify(`Login error: ${String((err as Error)?.message ?? err)}`);
          }
          finish();
        });
    } else {
      // API-key provider: prompt for the key and persist it locally.
      dialog
        .showPrompt(`Enter API key for ${provider.name}:`, 'sk-...')
        .then((key) => {
          if (settled) return;
          if (key.trim()) {
            authStorage.set(providerId, { type: 'api_key', key: key.trim() });
            notify(`API key saved for ${provider.name}`);
            onAuthReloaded();
          } else {
            notify('No key entered — login cancelled');
          }
          finish();
        })
        .catch(() => finish());
    }
  };

  const component = new OAuthSelectorComponent(
    'login',
    authStorage,
    providers,
    onSelect,
    () => close(),
    getAuthStatus,
  );
  return { component, focus: component };
}

/** `/logout` — show the provider selector in logout mode. On select, calls
 *  authStorage.logout(providerId) directly, then notifies the broker to reload. */
export function buildLogoutPicker(
  agentDir: string,
  onAuthReloaded: () => void,
  notify: (msg: string) => void,
  close: () => void,
): Picker {
  const { authStorage, registry } = buildLocalAuth(agentDir);
  const providers = buildProviderList(authStorage, registry);

  const getAuthStatus = (id: string): AuthStatus => authStorage.getAuthStatus(id);

  const onSelect = (providerId: string): void => {
    const provider = providers.find((p) => p.id === providerId);
    authStorage.logout(providerId);
    close();
    notify(`Logged out of ${provider?.name ?? providerId}`);
    onAuthReloaded();
  };

  const component = new OAuthSelectorComponent(
    'logout',
    authStorage,
    providers,
    onSelect,
    () => close(),
    getAuthStatus,
  );
  return { component, focus: component };
}
