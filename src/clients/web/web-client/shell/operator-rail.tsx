/**
 * The Operator dock collapsed to a 58px icon rail (Quiet Instrument "Rail Mode")
 * — shown on the node-console route where the graph rail + stream need the
 * width. Same nav manifest + view list as `OperatorDock`, rendered icon-only
 * with `title` tooltips. A live inbox tick rides the Inbox icon so a blocked
 * ask is still legible when the labels are gone.
 */

import { Link, NavLink, useNavigate } from 'react-router-dom';
import { CircleUser, Plus } from 'lucide-react';
import type { NavItem } from '../profile/types.js';
import { cn } from '@/lib/utils.js';
import { useInboxCount } from '../lib/use-decks.js';
import { useCapability } from '../profile/provider.js';
import { useViews } from '../lib/use-views.js';
import { startNewConversation } from '../lib/new-conversation.js';
import { navIcon, ViewIcon } from './operator-dock.js';

/** An icon-only rail link. Active state mirrors the mockup's `.dock a.on`. */
function railClass(isActive: boolean): string {
  return cn(
    'relative flex size-9 items-center justify-center rounded-lg no-underline opacity-75 transition-all',
    isActive
      ? '[color:var(--ink)] opacity-100 [background:rgba(232,228,216,.06)] [border:1px_solid_var(--line)] [box-shadow:inset_0_1px_0_var(--raise)]'
      : 'border border-transparent [color:var(--ink2)] hover:opacity-100 hover:[color:var(--ink)] hover:[background:rgba(232,228,216,.04)]',
  );
}

export function OperatorRail({ nav, home }: { nav: NavItem[]; home: string }) {
  const hasViewsHost = useCapability('views.host');
  const { views } = useViews();
  const inbox = useInboxCount();
  const navigate = useNavigate();

  const staticNav = hasViewsHost ? nav.filter((item) => item.id !== 'views') : nav;

  return (
    <aside
      aria-label="Primary"
      style={{ width: 58 }}
      className="flex flex-none flex-col items-center gap-0.5 py-4 [border-right:1px_solid_var(--line)] [background:linear-gradient(180deg,rgba(20,19,16,.6),rgba(20,19,16,.2))]"
    >
      <Link
        to={home}
        title="crouter"
        className="flex items-center justify-center pt-1 pb-4 no-underline"
      >
        <span
          className="flex flex-none items-center justify-center rounded-md text-xs font-bold [background:var(--bone)] [color:var(--bone-ink)] [font-family:var(--font-inst)]"
          style={{ width: 22, height: 22 }}
        >
          cr
        </span>
      </Link>

      <button
        type="button"
        onClick={() => startNewConversation(navigate)}
        title="New chat (⌘⇧O)"
        aria-label="New chat"
        className="mb-1 flex size-9 items-center justify-center rounded-lg transition-all [color:var(--bone-ink)] [background:var(--bone)] hover:[background:var(--ink)]"
      >
        <Plus size={18} aria-hidden />
      </button>

      {staticNav.map((item) => {
        const NavGlyph = navIcon(item.id);
        return (
          <NavLink
            key={item.id}
            to={item.path}
            end={item.path === '/'}
            title={item.label}
            className={({ isActive }) => railClass(isActive)}
          >
            <NavGlyph size={18} aria-hidden />
            {item.id === 'inbox' && inbox > 0 && (
              <span className="absolute right-[5px] top-[5px] size-2.5 rounded-full [background:var(--blk)] [box-shadow:0_0_10px_rgba(255,94,54,.55)] [animation:pulse-hot_1.6s_ease-out_infinite]" />
            )}
          </NavLink>
        );
      })}

      {hasViewsHost &&
        views.map((view) => (
          <NavLink
            key={view.id}
            to={`/views/${encodeURIComponent(view.id)}`}
            title={view.title}
            className={({ isActive }) => railClass(isActive)}
          >
            <ViewIcon size={18} aria-hidden />
          </NavLink>
        ))}

      <div className="flex-1" />

      <Link
        to="/settings"
        title="silas"
        className="flex size-9 items-center justify-center rounded-lg border border-transparent no-underline opacity-75 transition-all [color:var(--ink2)] hover:opacity-100 hover:[color:var(--ink)] hover:[background:rgba(232,228,216,.04)]"
      >
        <CircleUser size={18} aria-hidden />
      </Link>
    </aside>
  );
}
