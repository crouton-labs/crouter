/**
 * The application shell — the one place that turns a profile's composition axes
 * (nav manifest + density) into a layout. A comfortable-density profile (Studio)
 * gets a persistent left sidebar of its nav; a compact one (Operator) keeps its
 * page-owned top-chrome with the shell adding only the always-present header
 * switcher. This is the single sanctioned layout chooser the brief permits to
 * read density — every page/panel below stays profile-name-blind, driven by
 * capability/term/nav.
 *
 * When `views.host` is granted AND density is comfortable, the Studio views-first
 * top bar replaces the standard header: brand + view tabs in center + right icons.
 * Gated on capability, never profile name (design §3.4).
 */

import { useCallback, useState, type ReactNode } from 'react';
import { Link, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useProfile, useCapability } from '../profile/provider.js';
import { Sidebar } from './sidebar.js';
import { ProfileSwitcher } from './profile-switcher.js';
import { OperatorDock } from './operator-dock.js';
import { OperatorRail } from './operator-rail.js';
import { useViews } from '../lib/use-views.js';
import { useInboxCount } from '../lib/use-decks.js';
import { useGlobalKeydown } from '../lib/use-global-keydown.js';
import { startNewConversation } from '../lib/new-conversation.js';
import { NodeSwitcher } from '../command-palette/node-switcher.js';
import { MessagesSquare, Inbox, Plus } from 'lucide-react';
import { cn } from '@/lib/utils.js';

/** The node-console route collapses the dock to a 58px rail (Rail Mode). */
const RAIL_ROUTE = /^\/(nodes|c)\//;

export function AppShell({ children }: { children: ReactNode }) {
  const profile = useProfile();
  const location = useLocation();
  const navigate = useNavigate();
  const isViewsHost = useCapability('views.host');
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // App-wide keybinds (textarea-guarded by the hook). Collision audit: ⌥I,
  // ⌥D, '/', ⌥↑↓, Esc are taken — these two don't overlap.
  //   ⌘/⌃⇧O → new chat (open the composer on the list home).
  useGlobalKeydown(
    useCallback((e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === 'KeyO', []),
    useCallback(() => startNewConversation(navigate), [navigate]),
  );
  //   ⌘/⌃K → quick-switcher (jump between live/recent nodes).
  useGlobalKeydown(
    useCallback((e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.code === 'KeyK', []),
    useCallback(() => setSwitcherOpen((o) => !o), []),
  );

  // Layout chooser (the one permitted density read): comfortable → sidebar app
  // shell; compact → the Operator left dock wraps the page outlet.
  const sidebarLayout = profile.density === 'comfortable';
  // Views-first Studio bar: views.host granted + comfortable (Studio audience).
  const studioBar = isViewsHost && sidebarLayout;
  const home = profile.nav[0]?.path ?? '/';

  const switcher = <NodeSwitcher open={switcherOpen} onClose={() => setSwitcherOpen(false)} />;

  if (studioBar) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <StudioTopBar home={home} />
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        {switcher}
      </div>
    );
  }

  // Compact (Operator) audience → left dock, collapsed to a rail on the console
  // route. The dock owns the profile switcher in its footer.
  if (!sidebarLayout) {
    const rail = RAIL_ROUTE.test(location.pathname);
    return (
      <div className="flex h-full min-h-0">
        {rail ? (
          <OperatorRail nav={profile.nav} home={home} />
        ) : (
          <OperatorDock nav={profile.nav} home={home} />
        )}
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        {switcher}
      </div>
    );
  }

  // Fallback: a comfortable audience without views.host gets the header +
  // persistent left Sidebar.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-card/40 px-3">
        <Link to={home} className="text-sm font-semibold tracking-tight text-foreground">
          crouter
        </Link>
        <ProfileSwitcher />
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar nav={profile.nav} />
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
      </div>
      {switcher}
    </div>
  );
}

// ─── Studio views-first top bar ───────────────────────────────────────────────

function StudioTopBar({ home }: { home: string }) {
  const { views } = useViews();
  const inboxCount = useInboxCount();
  const navigate = useNavigate();

  return (
    <header
      className="flex h-13 shrink-0 items-center gap-0 border-b px-9"
      style={{ borderColor: 'rgba(40,36,26,.1)', background: 'var(--card)' }}
    >
      {/* brand */}
      <Link to={home} className="flex items-center gap-2 shrink-0">
        <span
          className="flex size-5.5 items-center justify-center rounded-md text-xs font-bold"
          style={{
            fontFamily: 'var(--font-inst)',
            background: 'var(--foreground)',
            color: 'var(--background)',
          }}
        >
          cr
        </span>
        <span
          className="text-lg"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 500,
            color: 'var(--foreground)',
          }}
        >
          crouter
        </span>
      </Link>

      {/* view tabs */}
      <div className="ml-3.5 flex items-center gap-1 overflow-x-auto">
        {views.map((view) => (
          <NavLink
            key={view.id}
            to={`/views/${encodeURIComponent(view.id)}`}
            className={({ isActive }) =>
              cn(
                'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-3.5 py-1.5 text-sm font-medium transition-colors',
                isActive
                  ? 'border-border/50 bg-background text-foreground shadow-sm'
                  : 'border-transparent text-muted-foreground hover:bg-accent/40 hover:text-foreground',
              )
            }
            style={({ isActive }) =>
              isActive
                ? { boxShadow: '0 6px 16px -10px rgba(60,50,30,.5), inset 0 1px 0 rgba(255,255,255,.9)' }
                : {}
            }
          >
            <span
              className="size-1.5 shrink-0 rounded-full"
              style={{ background: '#247d4b' }}
            />
            {view.title}
          </NavLink>
        ))}

        {/* + new chat tab — routes through the shared helper (R2). */}
        <button
          type="button"
          onClick={() => startNewConversation(navigate)}
          className="flex shrink-0 items-center rounded-lg border border-transparent px-3 py-1.5 text-muted-foreground/50 transition-colors hover:text-foreground"
          title="New chat (⌘⇧O)"
          aria-label="New chat"
        >
          <Plus className="size-4" />
        </button>
      </div>

      {/* right actions */}
      <div className="ml-auto flex items-center gap-2">
        {/* Audience switcher — always present so Studio can return to Operator. */}
        <ProfileSwitcher />

        {/* Chats */}
        <button
          type="button"
          onClick={() => navigate('/')}
          className="flex size-9 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:text-foreground"
          style={{ borderColor: 'rgba(40,36,26,.1)', background: 'rgba(255,255,255,.4)' }}
          title="Chats"
          aria-label="Chats"
        >
          <MessagesSquare className="size-4" />
        </button>

        {/* Inbox with badge */}
        <button
          type="button"
          onClick={() => navigate('/inbox')}
          className="relative flex size-9 items-center justify-center rounded-lg border text-muted-foreground transition-colors hover:text-foreground"
          style={{ borderColor: 'rgba(40,36,26,.1)', background: 'rgba(255,255,255,.4)' }}
          title="Inbox"
          aria-label="Inbox"
        >
          <Inbox className="size-4" />
          {inboxCount > 0 && (
            <span
              className="absolute -right-1 -top-1 rounded-full bg-destructive px-1 text-xs font-bold text-white"
              style={{ fontFamily: 'var(--font-inst)', minWidth: '14px', lineHeight: '14px' }}
            >
              {inboxCount}
            </span>
          )}
        </button>

        {/* Profile placeholder */}
        <div
          className="size-8 shrink-0 rounded-full border-2 border-white"
          style={{
            background: 'linear-gradient(135deg,#d8b97a,#b08b4a)',
            boxShadow: '0 2px 8px rgba(60,50,30,.25)',
          }}
        />
      </div>
    </header>
  );
}
