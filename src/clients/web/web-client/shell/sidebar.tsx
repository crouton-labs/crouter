/**
 * Studio's persistent left navigation (design §5.1). Renders the active
 * profile's `nav` manifest as links — the shell never hardcodes which entries
 * exist; adding/removing a destination is a manifest edit, not a component
 * change. Highlights the active route with the single cyan accent.
 *
 * When `views.host` is granted the sidebar appends a dynamic "Views" section
 * listing each view by title, gated on the capability (not profile name).
 */

import { NavLink, useNavigate } from 'react-router-dom';
import type { NavItem } from '../profile/types.js';
import { cn } from '@/lib/utils.js';
import { useInboxCount } from '../lib/use-decks.js';
import { useCapability } from '../profile/provider.js';
import { useViews } from '../lib/use-views.js';

export function Sidebar({ nav }: { nav: NavItem[] }) {
  const hasViewsHost = useCapability('views.host');
  const { views } = useViews();
  const navigate = useNavigate();

  // Filter the static nav — the Views entry (id:'views') is replaced by the
  // dynamic section when views.host is granted, so hide the stub.
  const staticNav = hasViewsHost ? nav.filter((item) => item.id !== 'views') : nav;

  return (
    <nav
      aria-label="Primary"
      className="flex w-56 shrink-0 flex-col gap-1 border-r border-border bg-card/40 px-3 py-4"
    >
      {staticNav.map((item) => (
        <NavLink
          key={item.id}
          to={item.path}
          end={item.path === '/'}
          className={({ isActive }) =>
            cn(
              'flex items-center justify-between rounded-lg px-3 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'bg-primary/10 text-primary'
                : 'text-foreground/70 hover:bg-accent hover:text-foreground',
            )
          }
        >
          <span>{item.label}</span>
          {item.id === 'inbox' && <NavInboxBadge />}
        </NavLink>
      ))}

      {hasViewsHost && (
        <>
          <div className="instlabel mx-3 mb-0.5 mt-3 uppercase tracking-widest text-muted-foreground/60">
            Views
          </div>
          {views.map((view) => (
            <NavLink
              key={view.id}
              to={`/views/${encodeURIComponent(view.id)}`}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 truncate rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-primary/10 text-primary'
                    : 'text-foreground/70 hover:bg-accent hover:text-foreground',
                )
              }
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: 'var(--status-active, #3ba55d)' }}
              />
              <span className="truncate">{view.title}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => navigate('/views')}
            className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground/50 transition-colors hover:text-foreground"
          >
            <span className="text-base leading-none">+</span>
            <span>New view</span>
          </button>
        </>
      )}
    </nav>
  );
}

/** The pending-ask count badge for the Inbox nav entry. Absent when zero
 *  (design §4.1 — the badge disappears at inbox-zero, never shows '0'). */
export function NavInboxBadge() {
  const count = useInboxCount();
  if (count <= 0) return null;
  return (
    <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground">
      {count}
    </span>
  );
}
