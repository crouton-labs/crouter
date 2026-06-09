// broker-sdk.ts — the single import-and-version-assert shim between the headless
// broker and the pi SDK (`@earendil-works/pi-coding-agent`).
//
// crouter has never imported the SDK before — it only ever forked the `pi` binary
// (see `launch.ts buildPiArgv`). The broker (T4) is the first consumer. This shim
// is the one place the dependency is named, so:
//   - the version tripwire (`assertEngineVersion`) lives here, and
//   - the `CRTR_BROKER_ENGINE` test seam (T11) has a single dynamic-import
//     indirection point (`loadBrokerEngine`) to swap in the fake engine.
//
// Nothing else in the tree imports this yet; it compiles but stays inert so the
// lifecycle suite stays green until the broker is wired up.

import { execFileSync } from 'node:child_process';
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  SessionManager,
  VERSION,
} from '@earendil-works/pi-coding-agent';

// Static re-exports — the real SDK surface the broker drives in production.
export { createAgentSessionServices, createAgentSessionFromServices, SessionManager, VERSION };

/**
 * The minimal slice of the pi SDK the broker needs. Both the real package and the
 * T11 `fake-engine` fixture satisfy this shape, so the broker can be driven by
 * either via the `CRTR_BROKER_ENGINE` seam below.
 *
 * C3 (viewer-reuse scout `mq5thyli`): the broker drives the SERVICES path
 * (`createAgentSessionServices` → `createAgentSessionFromServices`), NOT plain
 * `createAgentSession`. Only the services path runs `registerProvider` (extension
 * model-providers) + `applyExtensionFlagValues`, so a node whose model comes from
 * a custom-provider extension actually gets a model. Mirrors pi `main.js`.
 */
export interface BrokerEngine {
  createAgentSessionServices: typeof createAgentSessionServices;
  createAgentSessionFromServices: typeof createAgentSessionFromServices;
  SessionManager: typeof SessionManager;
  VERSION: string;
}

/**
 * Resolve the broker's engine module. Defaults to the real SDK; honors the
 * `CRTR_BROKER_ENGINE` env var (T11 test seam) so a lifecycle test can point the
 * broker at `fixtures/fake-engine.ts` without touching production code. This is the
 * sole dynamic-import indirection point — keep all engine resolution flowing
 * through here so the seam stays a single, auditable swap.
 */
export async function loadBrokerEngine(): Promise<BrokerEngine> {
  const spec = process.env.CRTR_BROKER_ENGINE ?? '@earendil-works/pi-coding-agent';
  const mod = (await import(spec)) as Partial<BrokerEngine>;
  if (
    typeof mod.createAgentSessionServices !== 'function' ||
    typeof mod.createAgentSessionFromServices !== 'function' ||
    typeof mod.SessionManager !== 'function'
  ) {
    throw new Error(
      `[broker] engine '${spec}' does not export createAgentSessionServices/` +
        `createAgentSessionFromServices/SessionManager — not a valid pi-SDK-compatible engine`,
    );
  }
  return {
    createAgentSessionServices: mod.createAgentSessionServices,
    createAgentSessionFromServices: mod.createAgentSessionFromServices,
    SessionManager: mod.SessionManager,
    VERSION: typeof mod.VERSION === 'string' ? mod.VERSION : 'unknown',
  };
}

/**
 * Boot-time tripwire: compare the imported SDK `VERSION` against the `pi` binary
 * crouter forks elsewhere (`pi --version`). On mismatch (or if the binary can't be
 * probed) it logs a LOUD warning to stderr and proceeds — it NEVER throws. The v3
 * session format auto-migrates on load, so minor skew round-trips; a hard fail here
 * would risk a grace-revive crash loop. Phase 5 may harden this to fail-fast once
 * the broker is the only host.
 *
 * @param engineVersion the version actually loaded (defaults to the statically
 *   imported `VERSION`; pass `engine.VERSION` from `loadBrokerEngine` to assert the
 *   version the broker is really driving).
 */
export function assertEngineVersion(engineVersion: string = VERSION): void {
  let binaryVersion: string;
  try {
    binaryVersion = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
  } catch (err) {
    process.stderr.write(
      `[broker] WARNING: could not run 'pi --version' to verify engine parity ` +
        `(SDK ${engineVersion}): ${(err as Error).message}\n`,
    );
    return;
  }
  if (binaryVersion !== engineVersion) {
    process.stderr.write(
      `[broker] WARNING: pi SDK version mismatch — imported SDK is ${engineVersion} but ` +
        `the 'pi' binary is ${binaryVersion}. The v3 session format auto-migrates on load so ` +
        `minor skew round-trips, but pin '@earendil-works/pi-coding-agent' to the binary version ` +
        `to keep the in-process engine and the forked binary in lockstep.\n`,
    );
  }
}
