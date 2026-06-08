// broker-cli.ts — the headless broker's dedicated detached entry (plan T4 /
// decision §1.13). Spawned directly via `spawn(execPath, [thisFile, nodeId], …)`
// by HeadlessBrokerHost.launch (T6) — NEVER routed through src/cli.ts, which
// would run the whole bootstrap chain (auto-update / scope-init / slash-template
// rewrite) on every broker boot. Mirrors src/daemon/crtrd-cli.ts: parse the one
// positional arg and hand off; keep this file a thin shim.

import { runBroker } from './broker.js';

const nodeId = process.argv[2];
if (nodeId === undefined || nodeId.trim() === '') {
  process.stderr.write('[broker] usage: broker-cli <nodeId>\n');
  process.exit(1);
}

// Last-resort safety net (review N-4): a stray throw/rejection from the SDK event
// stream or an extension's async hook would otherwise crash the broker on Node's
// default handler. Now that the host redirects the broker's stderr to the node's
// job/broker.log (M-2), log it there and exit non-zero — pre-session_start this
// folds into the daemon's boot-failure detection (M-1: pid stays null past the
// boot grace → surfaceBootFailure); post-session_start it is a clean grace-revive.
process.on('uncaughtException', (err) => {
  process.stderr.write(`[broker] uncaughtException: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  process.stderr.write(
    `[broker] unhandledRejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`,
  );
  process.exit(1);
});

runBroker(nodeId).catch((err) => {
  process.stderr.write(`[broker] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
