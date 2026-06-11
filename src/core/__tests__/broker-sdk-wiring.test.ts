// Run with: node --import tsx/esm --test src/core/__tests__/broker-sdk-wiring.test.ts
//
// REAL-SDK regression tests for the latent broker gaps the viewer-reuse scout
// (node mq5thyli) found (findings-viewer-reuse.md §Q2). These deliberately drive
// the ACTUAL `@earendil-works/pi-coding-agent` SDK — NOT the `CRTR_BROKER_ENGINE`
// fake the lifecycle suite uses — because C3 and C4 slipped past the Phase-3 gate
// PRECISELY because that gate mocked the SDK out. Each test exercises the exact
// production wiring (`buildBrokerSession` / `makeBrokerUiContext`) and would FAIL
// against the pre-fix broker:
//
//   C3 — the broker drives the SERVICES path, so an extension-registered custom
//        model provider is registered into the ModelRegistry and resolves onto
//        the session. Plain createAgentSession never calls registerProvider, so a
//        custom-provider node would get NO model.
//   C4 — a project AGENTS.md is injected into the assembled system prompt (the
//        services path loads project context; 0.78.1 has no project-trust gate so
//        context is unconditionally loaded — see buildBrokerSession's C4 note).
//   C2 — with ZERO viewers attached, the broker UI context resolves confirm() /
//        select() / input() / editor() to deny/cancel IMMEDIATELY (noOp), instead
//        of relying on a per-dialog timeout and hanging the agent turn forever.
//
// These run offline (no network/auth): registration + system-prompt assembly +
// dialog routing are all local. No tmux, no broker process — direct unit drives.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  VERSION,
  type BrokerEngine,
} from '../runtime/broker-sdk.js';
import { buildBrokerSession, makeBrokerUiContext } from '../runtime/broker.js';
import type { BrokerSdkConfig } from '../runtime/launch.js';

// The REAL engine, assembled from broker-sdk's static SDK re-exports — bypasses
// the CRTR_BROKER_ENGINE seam entirely so these tests can never accidentally hit
// the fake (the whole point: prove the wiring the mock hid).
const realEngine: BrokerEngine = {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  VERSION,
};

const HERE = dirname(fileURLToPath(import.meta.url));
const C3_EXT = join(HERE, 'fixtures', 'c3-custom-provider-ext.ts');

function cfg(cwd: string, extra: Partial<BrokerSdkConfig> = {}): BrokerSdkConfig {
  return { cwd, extensionPaths: [], ...extra };
}

// ===========================================================================
// C3 — the SERVICES path registers an extension's custom model provider, so the
// broker resolves a model that plain createAgentSession (no registerProvider)
// would never see.
// ===========================================================================
test('C3 — services path registers an extension model provider; the broker session gets it', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'crtr-c3-'));
  try {
    const { session, services } = await buildBrokerSession(
      realEngine,
      cfg(cwd, { extensionPaths: [C3_EXT], model: 'c3prov/c3model' }),
    );
    try {
      // The extension's provider was registered into the SERVICES registry (this
      // is the registerProvider step plain createAgentSession skips).
      const found = services.modelRegistry.find('c3prov', 'c3model');
      assert.ok(found, 'C3: extension-registered model is present in the services ModelRegistry');
      assert.equal(found!.provider, 'c3prov', 'C3: provider name round-trips');
      assert.equal(found!.id, 'c3model', 'C3: model id round-trips');
      // …and the broker resolved it onto the session AGAINST the services registry
      // (a fresh ModelRegistry would have returned undefined → no model).
      assert.equal(session.model?.id, 'c3model', 'C3: the broker session got the custom-provider model');
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ===========================================================================
// C4 — project context (AGENTS.md) is injected into the system prompt. The
// services path loads project context files; on the 0.78.1 pin there is no
// project-trust gate, so they load unconditionally (and buildBrokerSession does
// NOT re-introduce the CLI's headless trust resolver, which would drop them).
// ===========================================================================
test('C4 — a project AGENTS.md is injected into the assembled system prompt', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'crtr-c4-'));
  try {
    const marker = 'C4_AGENTS_MARKER_' + Math.random().toString(36).slice(2);
    writeFileSync(join(cwd, 'AGENTS.md'), `# Project rules\n\n${marker}\n`);
    const { session } = await buildBrokerSession(realEngine, cfg(cwd));
    try {
      assert.ok(
        session.systemPrompt.includes(marker),
        'C4: project AGENTS.md content is present in the assembled system prompt',
      );
    } finally {
      session.dispose();
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

// ===========================================================================
// C2 — zero-viewer dialogs resolve to deny/cancel IMMEDIATELY (noOp), never
// hanging the turn and never waiting on a per-dialog timeout. Drives the REAL
// makeBrokerUiContext (the exact ExtensionUIContext the SDK hands extensions),
// with a controller() that reports zero viewers.
// ===========================================================================
test('C2 — zero-viewer UI context resolves dialogs to deny/cancel immediately (noOp, no hang)', async () => {
  const ctx = makeBrokerUiContext({
    controller: () => null, // ZERO viewers attached
    forward: () => {
      throw new Error('C2: must NOT forward a dialog when no controller is attached');
    },
    pending: new Map(),
    broadcast: () => {},
  });

  // confirm() WITH a large timeout: the fix must resolve at once (deny), NOT after
  // the timeout — the old timeout-reliant path would have waited 60s (or, with no
  // timeout, hung forever). Race against a 2s "HANG" sentinel to make a regression
  // a hard failure rather than a slow pass.
  const start = Date.now();
  const confirmed = await Promise.race([
    ctx.confirm('proceed?', 'really?', { timeout: 60_000 }),
    new Promise<'HANG'>((r) => setTimeout(() => r('HANG'), 2_000)),
  ]);
  assert.equal(confirmed, false, 'C2: confirm() denies (false) with zero viewers');
  assert.ok(Date.now() - start < 1_000, 'C2: resolved immediately, not after the 60s timeout');

  // The other blocking dialogs cancel to undefined — including editor(), which
  // takes NO opts at all (so it could never carry a timeout to lean on).
  assert.equal(await ctx.select('pick', ['a', 'b']), undefined, 'C2: select() cancels (undefined)');
  assert.equal(await ctx.input('name'), undefined, 'C2: input() cancels (undefined)');
  assert.equal(await ctx.editor('edit'), undefined, 'C2: editor() cancels (undefined)');
});

// ===========================================================================
// M2 (review mq5wkqep / T4) — REPLACES the Wave-0 M-1 cancel-on-detach. A dialog
// forwarded to a controller that then DETACHES must NOT be cancelled: it stays
// pending so a brief detach/reattach (or a handoff to another controller) does
// not lose an answerable dialog. The broker-side default timeout is the ONLY
// non-answer resolution (proven here with a short per-dialog timeout standing in
// for the 120s default). Guards against regressing to the over-eager cancel.
// ===========================================================================
test('M2 — a forwarded dialog stays pending on controller detach, resolving only on the broker-side timeout', async () => {
  const pending = new Map<string, { request: unknown; resolve: (r: unknown) => void }>();
  let attached = true;
  const ctx = makeBrokerUiContext({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    controller: () => (attached ? ({ id: 'c1' } as any) : null),
    forward: () => {
      /* a real controller would receive the request over its socket */
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pending: pending as any,
    broadcast: () => {},
  });

  // Controller attached → confirm() forwards + registers a pending dialog (with the
  // request retained for welcome.pending_dialog / re-route, T4) and does NOT
  // resolve yet. A short per-dialog timeout stands in for the 120s broker default.
  const p = ctx.confirm('proceed?', 'really?', { timeout: 80 });
  assert.equal(pending.size, 1, 'M2: a forwarded dialog is pending while a controller is attached');
  const entry = [...pending.values()][0]!;
  assert.ok(entry.request, 'M2: the pending entry retains the request (welcome/re-route need it)');
  assert.equal(
    (entry as { cancel?: unknown }).cancel,
    undefined,
    'M2: there is no cancel-on-detach path anymore',
  );

  // Controller detaches → the dialog STAYS pending (the broker no longer cancels it).
  attached = false;
  assert.equal(pending.size, 1, 'M2: detach does NOT cancel the in-flight dialog');

  // Only the broker-side timeout resolves it, to the SAFE default (deny).
  const resolved = await Promise.race([
    p,
    new Promise<'HANG'>((r) => setTimeout(() => r('HANG'), 2_000)),
  ]);
  assert.equal(resolved, false, 'M2: resolves to deny on the broker-side timeout, never hangs');
  assert.equal(pending.size, 0, 'M2: the pending registry is drained after the timeout');
});
