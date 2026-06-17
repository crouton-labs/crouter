/**
 * The two audience profiles (design §2). Operator is the global default — the
 * admin console with every capability granted, raw vocabulary, dark/compact.
 * Studio is the consumer audience — admin capabilities withheld, friendly
 * vocabulary, light/comfortable. These records are the ONLY place "what shows
 * where" lives; adding/moving a feature between audiences is a one-line grant
 * change here, never a component edit (design §3.4).
 *
 * NOTE: In Phase 1 Studio is *defined* so the selection mechanism has a target,
 * but the UI stays Operator — Studio's screens are Phase 2. What's real here is
 * the grant/term/nav data, so Phase 2 only adds the Studio panels + the
 * header switcher, never touches the abstraction.
 */

import type { Capability, Profile } from './types.js';

export type ProfileId = 'operator' | 'studio';

// NOTE: `subnodes.activity` is intentionally absent. It is the Studio-only
// inverse of `subnodes.visible` — Operator sees the child graph on the canvas,
// so it never renders the summarized ActivityRail. A feature gates on the
// capability once; the capability lands on whichever profiles want it.
const ALL_CAPABILITIES: Capability[] = [
  'canvas.view',
  'canvas.search',
  'node.internals',
  'node.arbitration',
  'node.spawn.raw',
  'node.lifecycle.raw',
  'subnodes.visible',
  'commands.palette',
  'session.trace',
  'diagnostics',
  'views.author',
  'node.graphRail',
  'files.peek',
  'views.host',
];

/** Operator — admin audience, global default. Everything granted; raw terms. */
const operator: Profile = {
  id: 'operator',
  label: 'Operator',
  grants: new Set(ALL_CAPABILITIES),
  terms: {
    node: 'node',
    nodes: 'nodes',
    spawn: 'spawn',
    revive: 'Revive',
    controller: 'controller',
    observer: 'observer',
    broker: 'broker',
    canvas: 'canvas',
    headless: 'headless',
    steer: 'Steer',
    compact: 'Compact',
    close: 'Close',
  },
  // The conversation/node LIST is the front door (design R3): it is nav[0], so
  // `/` and the brand/back link resolve to it. The diagnostic Canvas stays one
  // click away at `/canvas`, just no longer the landing surface.
  nav: [
    { id: 'conversations', label: 'Conversations', path: '/' },
    { id: 'canvas', label: 'Canvas', path: '/canvas' },
    { id: 'inbox', label: 'Inbox', path: '/inbox' },
    { id: 'views', label: 'Views', path: '/views' },
  ],
  density: 'compact',
  defaultTheme: 'dark',
  // The conversation/node list is the front door (design R3); views stay one
  // click away at /views but are not the landing surface for the admin audience.
  home: 'list',
};

/** Studio — consumer audience. Admin capabilities withheld; friendly terms.
 *  (Terms that consumers must never see resolve to '' — they render nothing.) */
const studio: Profile = {
  id: 'studio',
  label: 'Studio',
  // Studio withholds every admin capability EXCEPT the one consumer-facing
  // affordance it needs: a plain-language summary of the conversation's
  // sub-DAG (the ActivityRail) in place of the raw child graph.
  grants: new Set<Capability>(['subnodes.activity', 'views.host']),
  terms: {
    node: 'conversation',
    nodes: 'conversations',
    spawn: 'new chat',
    revive: 'Continue',
    controller: '',
    observer: '',
    broker: '',
    canvas: '',
    headless: '',
    steer: 'Send',
    compact: '',
    close: '',
  },
  nav: [
    { id: 'conversations', label: 'Conversations', path: '/' },
    { id: 'inbox', label: 'Inbox', path: '/inbox' },
    { id: 'settings', label: 'Settings', path: '/settings' },
  ],
  density: 'comfortable',
  defaultTheme: 'light',
  // Studio is the view-centric consumer showcase — land on the curated view
  // first, falling back to the conversation list when no view exists.
  home: 'views',
};

export const PROFILES: Record<ProfileId, Profile> = { operator, studio };

/** Operator is the global default (design §2.3, decision record D3). */
export const DEFAULT_PROFILE_ID: ProfileId = 'operator';
