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

runBroker(nodeId).catch((err) => {
  process.stderr.write(`[broker] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});
