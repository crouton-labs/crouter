// SPA routes (react-router-dom v7). Routes are profile-aware via profile data,
// not profile name (design §4.4): `/` resolves to the profile's `home` axis —
// the most-recent view for a `views`-home audience (Studio), else the
// Conversations list (Operator). New chat (`/?new=1`) always opens the list +
// composer. The diagnostic Canvas is demoted to `/canvas` (design R3).
// `/nodes/:id` (Operator)
// and `/c/:id` (Studio alias) both address the SAME node id and render the SAME
// composed SessionScreen; the URL term is itself vocabulary. The global
// ReconnectingBanner reads server-bridge connectivity from the shared zustand
// store (spec §7 server-restart).

import { useEffect } from 'react';
import { Routes, Route, useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { CanvasPage } from './pages/canvas-page.js';
import { ConversationsPage } from './pages/conversations-page.js';
import { NodePage } from './pages/node-page.js';
import { InboxPage } from './pages/inbox-page.js';
import { DeckPage } from './pages/deck-page.js';
import { SettingsPage } from './pages/settings-page.js';
import { ViewPageRoute } from './pages/view-page.js';
import { useProfile } from './profile/provider.js';
import { useServerStatus } from './lib/server-status.js';
import { useViews } from './lib/use-views.js';

function NodePageRoute() {
  const { id } = useParams<{ id: string }>();
  // Key by id so switching chats remounts the page (fresh scroll position etc).
  return <NodePage key={id} id={id ?? ''} />;
}

function DeckPageRoute() {
  const { deckId } = useParams<{ deckId: string }>();
  return <DeckPage deckId={deckId ?? ''} />;
}

/** Redirect to the most-recent view when views exist; else show conversations. */
function ViewsIndexRedirect() {
  const { views, loading } = useViews();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    const first = views[0];
    if (first) {
      navigate(`/views/${encodeURIComponent(first.id)}`, { replace: true });
    }
  }, [views, loading, navigate]);

  if (loading) return null;
  if (views.length === 0) return <ConversationsPage />;
  return null;
}

/** `/` resolves to the profile's home. Switching between conversations is the
 *  common act, so the node/conversation LIST is the front door for everyone
 *  (design R3) — the diagnostic Canvas stays reachable at `/canvas` and via the
 *  nav, but is no longer the landing surface. A `views.host` audience (Studio)
 *  still opens views-first, falling back to the list when it has none. */
function HomeRoute() {
  const { home } = useProfile();
  const [params] = useSearchParams();

  // New chat (`/?new=1`) always lands on the conversation list + composer, even
  // for a views-first audience — otherwise the views redirect would swallow it.
  if (params.has('new')) return <ConversationsPage />;
  if (home === 'views') return <ViewsIndexRedirect />;
  return <ConversationsPage />;
}

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<HomeRoute />} />
      <Route path="/canvas" element={<CanvasPage />} />
      <Route path="/nodes/:id" element={<NodePageRoute />} />
      <Route path="/c/:id" element={<NodePageRoute />} />
      <Route path="/inbox" element={<InboxPage />} />
      <Route path="/inbox/:deckId" element={<DeckPageRoute />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="/views/:viewId" element={<ViewPageRoute />} />
      <Route path="/views/:viewId/:tab" element={<ViewPageRoute />} />
      {/* Unknown URLs fall back to the profile home. */}
      <Route path="*" element={<HomeRoute />} />
    </Routes>
  );
}

/** Banner shown while the server WebSocket is unreachable (§7 server-restart). */
export function ReconnectingBanner() {
  const reachable = useServerStatus((s) => s.reachable);
  if (reachable) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 top-0 z-50 bg-warning/90 px-4 py-1.5 text-center text-sm font-medium text-background"
    >
      Reconnecting to the crouter-web server…
    </div>
  );
}
