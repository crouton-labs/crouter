// broker-cli.ts — the headless broker's dedicated detached entry (plan T4 /
// decision §1.13). Spawned directly via `spawn(execPath, [thisFile, nodeId], …)`
// by HeadlessBrokerHost.launch (T6) — NEVER routed through src/cli.ts, which
// would run the whole bootstrap chain (auto-update / scope-init / slash-template
// rewrite) on every broker boot. Mirrors src/daemon/crtrd-cli.ts: parse the one
// positional arg and hand off; keep this file a thin shim.

import { runBroker, disposeActiveSession } from './broker.js';

const nodeId = process.argv[2];
if (nodeId === undefined || nodeId.trim() === '') {
  process.stderr.write('[broker] usage: broker-cli <nodeId>\n');
  process.exit(1);
}

// M3 (scout mq5thyli): dispose the live engine before a FATAL exit. The bash tool
// spawns children `detached` (own pgid); only session.dispose() (→ abortBash /
// agent.abort → killProcessTree) reaps them. The graceful path (shutdownHandler /
// SIGTERM → disposeAndExit) already disposes; this routes the crash path —
// uncaughtException / unhandledRejection / a runBroker reject — through dispose
// too, so a fatal error never ORPHANS in-flight bash subprocesses. dispose is
// idempotent + a no-op once the graceful path has run.
function disposeAndExit(code: number): never {
  try {
    disposeActiveSession();
  } catch {
    /* dispose must not block the fatal exit */
  }
  process.exit(code);
}

// Last-resort safety net (review N-4): a stray throw/rejection from the SDK event
// stream or an extension's async hook would otherwise crash the broker on Node's
// default handler. Now that the host redirects the broker's stderr to the node's
// job/broker.log (M-2), log it there and exit non-zero — pre-session_start this
// folds into the daemon's boot-failure detection (M-1: pid stays null past the
// boot grace → surfaceBootFailure); post-session_start it is a clean grace-revive.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[broker] uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  disposeAndExit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `[broker] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
  );
  disposeAndExit(1);
});

runBroker(nodeId).catch((err) => {
  process.stderr.write(`[broker] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  disposeAndExit(1);
});
