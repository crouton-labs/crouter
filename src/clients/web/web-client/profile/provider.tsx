/**
 * ProfileProvider — the single app-root holder of the active Profile and the
 * ONLY place that knows the profile *name* (design §3.1). Everything downstream
 * reads one of three derived axes through the hooks here: capabilities
 * (useCapability), vocabulary (useTerm), or composition (useProfile for
 * nav/density + the slot registry). The provider also reflects the profile onto
 * the document root: theme class (.dark/.light), data-profile, data-density —
 * so the same components express two characters without forking styles
 * (design §7).
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Capability, Profile, TermKey } from './types.js';
import { PROFILES, type ProfileId } from './profiles.js';
import { readProfileId, writeProfileId } from './selection.js';

interface ProfileContextValue {
  profile: Profile;
  /** Switch the active profile (persists). Phase 2's header switcher calls this. */
  setProfile: (id: ProfileId) => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function ProfileProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState<ProfileId>(() => readProfileId());
  const profile = PROFILES[id];

  // Reflect the profile onto the document root (design §7): theme default,
  // density, and a data-profile hook for any profile-scoped CSS.
  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle('dark', profile.defaultTheme === 'dark');
    el.classList.toggle('light', profile.defaultTheme === 'light');
    el.dataset.profile = profile.id;
    el.dataset.density = profile.density;
  }, [profile]);

  const value = useMemo<ProfileContextValue>(
    () => ({
      profile,
      setProfile: (next) => {
        writeProfileId(next);
        setId(next);
      },
    }),
    [profile],
  );

  return <ProfileContext.Provider value={value}>{children}</ProfileContext.Provider>;
}

function useProfileContext(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error('useProfile* must be used within a ProfileProvider');
  return ctx;
}

/** The active profile — for nav rendering and density only. Pages MUST NOT
 *  switch on `.id` (design §3.2). */
export function useProfile(): Profile {
  return useProfileContext().profile;
}

/** Switch the active profile (Phase 2 header switcher). */
export function useSetProfile(): (id: ProfileId) => void {
  return useProfileContext().setProfile;
}

/** Is a capability granted to the active profile? Gate rendering/actions on it. */
export function useCapability(cap: Capability): boolean {
  return useProfileContext().profile.grants.has(cap);
}

/** The active profile's full grant set — for the slot registry / actionsFor. */
export function useGrants(): Set<Capability> {
  return useProfileContext().profile.grants;
}

/** Resolve a label. Studio overrides; Operator falls back to the raw term. */
export function useTerm(key: TermKey): string {
  const { profile } = useProfileContext();
  return profile.terms[key] ?? key;
}
