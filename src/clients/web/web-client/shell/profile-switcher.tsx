/**
 * The header profile switcher (design §2.3). An always-present, one-click
 * control that flips the active audience via the Phase-1 selection mechanism
 * (ProfileProvider → localStorage + re-render). This is the dev-facing switch:
 * Operator is the global default, and a developer flips to Studio to see the
 * consumer experience. It reads the profile list and the active id only to
 * render the toggle — it is the chrome, not a page, so it is the one sanctioned
 * place a profile *name* is referenced.
 */

import { useProfile, useSetProfile } from '../profile/provider.js';
import { PROFILES, type ProfileId } from '../profile/profiles.js';
import { cn } from '@/lib/utils.js';

const ORDER: ProfileId[] = ['operator', 'studio'];

export function ProfileSwitcher() {
  const active = useProfile();
  const setProfile = useSetProfile();

  return (
    <div
      role="group"
      aria-label="Switch profile"
      className="inline-flex items-center rounded-md border border-border bg-card/50 p-0.5 text-xs"
    >
      {ORDER.map((id) => {
        const selected = active.id === id;
        return (
          <button
            key={id}
            type="button"
            aria-pressed={selected}
            onClick={() => setProfile(id)}
            className={cn(
              'inline-flex h-8 items-center rounded px-3 font-medium transition-colors',
              selected
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {PROFILES[id].label}
          </button>
        );
      })}
    </div>
  );
}
