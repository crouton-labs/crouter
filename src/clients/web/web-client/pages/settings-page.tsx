/**
 * Settings — deliberately quiet (design §4.4). Profile switch, theme toggle,
 * and room for future prefs. Minimal by design; the profile switch is the same
 * control as the header, surfaced here too for discoverability.
 */

import { useState } from 'react';
import { ProfileSwitcher } from '../shell/profile-switcher.js';
import { useProfile } from '../profile/provider.js';
import { Button } from '@/components/ui/button.js';

export function SettingsPage() {
  // Seed from the active profile's theme (the source of truth). Reading the
  // document `.dark` class during render is stale on first mount — the
  // ProfileProvider applies that class in a parent effect that fires *after*
  // this page renders, which inverted the label.
  const profile = useProfile();
  const [dark, setDark] = useState(() => profile.defaultTheme === 'dark');

  const toggleTheme = (): void => {
    const el = document.documentElement;
    const next = !el.classList.contains('dark');
    el.classList.toggle('dark', next);
    el.classList.toggle('light', !next);
    setDark(next);
  };

  return (
    <div className="mx-auto flex h-full min-h-0 max-w-2xl flex-col gap-8 overflow-auto px-6 py-8">
      <h1
        className="text-3xl"
        style={{
          fontFamily: 'var(--font-display)',
          fontWeight: 460,
          letterSpacing: '-0.01em',
          color: 'var(--ink)',
        }}
      >
        Settings
      </h1>

      <section className="space-y-2.5">
        <h2 className="instlabel">Profile</h2>
        <p className="text-sm" style={{ color: 'var(--mut)' }}>
          Choose the experience. You can also switch from the header at any time.
        </p>
        <ProfileSwitcher />
      </section>

      <section className="space-y-2.5">
        <h2 className="instlabel">Appearance</h2>
        <p className="text-sm" style={{ color: 'var(--mut)' }}>
          {dark ? 'Dark theme' : 'Light theme'} is active.
        </p>
        <Button variant="outline" onClick={toggleTheme}>
          Switch to {dark ? 'light' : 'dark'}
        </Button>
      </section>
    </div>
  );
}
