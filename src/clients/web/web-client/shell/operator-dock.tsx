/**
 * The Operator left dock (Quiet Instrument "Dock (Sidebar)" surface). The
 * expanded 228px navigation column shown on the Canvas/Views routes: brand
 * glyph, the profile's nav manifest as links (inbox blocked-count in ember), a
 * dynamic "Views" section when `views.host` is granted, then a footer with the
 * profile switcher. Its collapsed twin is `OperatorRail` (the node-console
 * route). Both are profile-name-blind — they render the nav manifest + view
 * list, never branch on which audience is active.
 */

import { Link, NavLink, useNavigate } from 'react-router-dom';
import {
  Network,
  MessagesSquare,
  Inbox,
  LayoutDashboard,
  Settings,
  CircleUser,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import type { NavItem } from '../profile/types.js';
import { cn } from '@/lib/utils.js';
import { useInboxCount } from '../lib/use-decks.js';
import { useCapability } from '../profile/provider.js';
import { useViews } from '../lib/use-views.js';
import { startNewConversation } from '../lib/new-conversation.js';
import { ProfileSwitcher } from './profile-switcher.js';

// ── Shared lucide nav vocabulary (consumed by the rail too) ──────────────────

/** The lucide glyph for a static nav entry, keyed by manifest id. */
const NAV_ICONS: Record<string, LucideIcon> = {
  canvas: Network,
  conversations: MessagesSquare,
  inbox: Inbox,
  views: LayoutDashboard,
  settings: Settings,
};

export function navIcon(id: string): LucideIcon {
  return NAV_ICONS[id] ?? LayoutDashboard;
}

/** Every view row gets the same mark — rows differentiate by title, not glyph. */
export const ViewIcon: LucideIcon = LayoutDashboard;

/** A dock link's class set. Active state mirrors the mockup's `.dock a.on`. */
function linkClass(isActive: boolean): string {
  return cn(
    'flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm font-medium no-underline transition-all',
    isActive
      ? '[color:var(--ink)] [background:rgba(232,228,216,.06)] [border:1px_solid_var(--line)] [box-shadow:inset_0_1px_0_var(--raise)]'
      : 'border border-transparent [color:var(--ink2)] hover:[color:var(--ink)] hover:[background:rgba(232,228,216,.04)]',
  );
}

export function OperatorDock({ nav, home }: { nav: NavItem[]; home: string }) {
  const hasViewsHost = useCapability('views.host');
  const { views } = useViews();
  const navigate = useNavigate();

  // When views.host is granted, the static 'views' stub is replaced by the
  // dynamic section below — hide the stub link.
  const staticNav = hasViewsHost ? nav.filter((item) => item.id !== 'views') : nav;

  return (
    <aside
      aria-label="Primary"
      className="flex w-57 flex-none flex-col gap-0.5 px-3 py-4 [border-right:1px_solid_var(--line)] [background:linear-gradient(180deg,rgba(20,19,16,.6),rgba(20,19,16,.2))]"
    >
      <Link
        to={home}
        className="flex items-center gap-2.5 px-2.5 pt-1 pb-4 text-base font-medium tracking-[.01em] no-underline [color:var(--ink)] [font-family:var(--font-display)]"
      >
        <span
          className="flex flex-none items-center justify-center rounded-md text-xs font-bold [background:var(--bone)] [color:var(--bone-ink)] [font-family:var(--font-inst)]"
          style={{ width: 22, height: 22 }}
        >
          cr
        </span>
        crouter
      </Link>

      <button
        type="button"
        onClick={() => startNewConversation(navigate)}
        title="New chat (⌘⇧O)"
        className="mb-1.5 flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm font-medium transition-all [color:var(--bone-ink)] [background:var(--bone)] hover:[background:var(--ink)]"
      >
        <Plus size={16} className="flex-none" aria-hidden />
        <span>New chat</span>
      </button>

      {staticNav.map((item) => {
        const NavGlyph = navIcon(item.id);
        return (
          <NavLink
            key={item.id}
            to={item.path}
            end={item.path === '/'}
            className={({ isActive }) => linkClass(isActive)}
          >
            <NavGlyph size={18} className="flex-none opacity-75" aria-hidden />
            <span>{item.label}</span>
            {item.id === 'inbox' && <DockInboxCount />}
          </NavLink>
        );
      })}

      {hasViewsHost && (
        <>
          <div className="instlabel px-2.5 pt-3.5 pb-1.5">Views</div>
          {views.map((view) => (
            <NavLink
              key={view.id}
              to={`/views/${encodeURIComponent(view.id)}`}
              className={({ isActive }) => linkClass(isActive)}
            >
              <ViewIcon size={18} className="flex-none opacity-75" aria-hidden />
              <span className="truncate">{view.title}</span>
            </NavLink>
          ))}
          <button
            type="button"
            onClick={() => navigate('/views')}
            className="flex h-9 items-center gap-2.5 rounded-lg border border-transparent bg-transparent px-3 text-sm font-medium transition-all [color:var(--dim)] hover:[color:var(--ink)]"
          >
            <Plus size={16} className="flex-none opacity-75" aria-hidden />
            <span>New view</span>
          </button>
        </>
      )}

      <div className="flex-1" />

      <div className="mt-2.5 pt-2.5 [border-top:1px_solid_var(--line)]">
        <div className="flex items-center justify-between gap-2 px-1">
          <span className="flex items-center gap-2.5 text-sm font-medium [color:var(--ink2)]">
            <CircleUser size={18} className="flex-none opacity-75" aria-hidden /> silas
          </span>
          <span className="kbd">⌘K</span>
        </div>
        <div className="px-1 pt-2">
          <ProfileSwitcher />
        </div>
      </div>
    </aside>
  );
}

/** The inbox pending-ask count, rendered as the ember `.count` pill. Hidden at
 *  zero (the badge disappears at inbox-zero, never shows '0'). */
function DockInboxCount() {
  const count = useInboxCount();
  if (count <= 0) return null;
  return (
    <span className="ml-auto rounded-full border px-2 py-0.5 text-xs font-semibold [font-family:var(--font-inst)] [color:#ff8260] [background:var(--blk-dim)] [border-color:rgba(255,94,54,.35)]">
      {count}
    </span>
  );
}
