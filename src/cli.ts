#!/usr/bin/env node

import { enableCompileCache } from 'node:module';
import { runCli } from './core/command.js';
import { resolveRoot } from './build-root.js';
import { maybeBootRoot } from './core/runtime/front-door.js';
import { maybeAutoUpdate } from './core/auto-update.js';
import { ensureOfficialMarketplace, ensureProjectScope } from './core/bootstrap.js';
import { provisionExports } from './core/skill-sync/export.js';

// V8 compile-cache (Node 22+): persist compiled bytecode across runs so a cold
// `crtr` re-spawn skips recompiling its module graph. Biggest payoff is the
// heavy attach-viewer bundle that main() dynamic-imports via resolveRoot — this
// runs first, so the cache is active before that import() compiles. Measured
// neutral on the tiny leaf path (feed/node), a clear win on attach. Best-effort:
// older Node lacks the API.
try { enableCompileCache(); } catch { /* pre-22 Node: no compile cache */ }

async function main(): Promise<void> {
  // Lazy command tree: load only the subtree this invocation dispatches into.
  // resolveRoot returns the full tree only for help/version/bare/unknown, where
  // every subtree is genuinely needed (root -h, the unknown-path error). The
  // hot leaf-dispatch path loads one subtree, keeping the other 11 (and their
  // heavy deps — the attach TUI, web/vite) off cold-start.
  const root = await resolveRoot(process.argv[2]);

  // The front door: bare `crtr` (or `crtr [dir] ["prompt"]`) boots a resident
  // root node and execs pi in this terminal. Recognized subcommands fall through
  // to the normal dispatcher. Must run before anything that assumes a subcommand.
  if (maybeBootRoot(root, process.argv)) {
    // bootRoot exec'd pi inline and exited; unreachable.
  }

  ensureOfficialMarketplace(process.argv);
  provisionExports(root);
  ensureProjectScope(process.argv);
  maybeAutoUpdate(process.argv);

  await runCli(root, process.argv);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`crtr: ${msg}\n`);
  process.exit(1);
});
