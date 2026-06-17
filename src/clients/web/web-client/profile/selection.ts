/**
 * Profile selection (design §2.3). localStorage is the source of truth; a
 * `?profile=studio` URL override selects (and persists) for sharing/demoing.
 * Operator is the default. This is deliberately trivial so Phase 2's header
 * switcher only needs to call the provider's setProfile — the mechanism is
 * already here.
 */

import { PROFILES, DEFAULT_PROFILE_ID, type ProfileId } from './profiles.js';

const STORAGE_KEY = 'crouter-web:profile';

export function isProfileId(value: string | null | undefined): value is ProfileId {
  return value != null && Object.prototype.hasOwnProperty.call(PROFILES, value);
}

/** Resolve the active profile id: URL override wins (and persists), then the
 *  persisted setting, then the Operator default. */
export function readProfileId(): ProfileId {
  const fromUrl = new URLSearchParams(window.location.search).get('profile');
  if (isProfileId(fromUrl)) {
    writeProfileId(fromUrl);
    return fromUrl;
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isProfileId(stored)) return stored;
  } catch {
    /* storage unavailable (private mode) — fall through to default */
  }
  return DEFAULT_PROFILE_ID;
}

export function writeProfileId(id: ProfileId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* storage unavailable — selection stays in-memory only */
  }
}
