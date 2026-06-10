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
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  SessionManager,
  VERSION,
} from '@earendil-works/pi-coding-agent';
import { crtrHome } from '../canvas/paths.js';

// Static re-exports — the real SDK surface the broker drives in production.
export {
  createAgentSessionServices,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  SessionManager,
  VERSION,
};

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
  /**
   * The session-replacement runtime factory (T3 new_session/switch_session/fork).
   * OPTIONAL: the real SDK (0.78.1) exposes it, so production gets full session
   * replacement; the `fake-engine` test fixture does NOT provide it, so the
   * broker degrades those three ops to an `error{engine_error}` reply rather than
   * failing engine validation. Everything else works on both.
   */
  createAgentSessionRuntime?: typeof createAgentSessionRuntime;
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
    // Optional — passed through only when the engine exposes it (real SDK yes,
    // fake-engine no). The broker checks for its presence before the three
    // session-replacing ops.
    createAgentSessionRuntime:
      typeof mod.createAgentSessionRuntime === 'function' ? mod.createAgentSessionRuntime : undefined,
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
/** Resolve the `pi` executable on PATH without spawning anything — a plain walk
 *  of `$PATH` entries (`statSync` follows symlinks, so an npm/brew bin shim
 *  resolves to the real target). Returns the first match, or undefined. */
function resolvePiBinary(): string | undefined {
  const path = process.env['PATH'];
  if (path === undefined || path === '') return undefined;
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'pi');
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* unreadable PATH entry — skip */
    }
  }
  return undefined;
}

interface PiVersionCache {
  /** Resolved binary path the cached version was probed from. */
  path: string;
  /** mtime + size of that path — a `pi` upgrade changes both, re-probing. */
  mtimeMs: number;
  size: number;
  /** The `pi --version` output captured for that binary. */
  version: string;
}

const PI_VERSION_CACHE = (): string => join(crtrHome(), 'pi-version.json');

/** Cached `pi --version`, keyed on the binary's path+mtime+size so a pi upgrade
 *  re-probes but the steady state never spawns. Returns undefined when the
 *  binary can't be resolved/stat'd or the cache misses — the caller then spawns
 *  once and back-fills via {@link writePiVersionCache}. */
function readPiVersionCache(binPath: string, mtimeMs: number, size: number): string | undefined {
  try {
    const c = JSON.parse(readFileSync(PI_VERSION_CACHE(), 'utf8')) as Partial<PiVersionCache>;
    if (c.path === binPath && c.mtimeMs === mtimeMs && c.size === size && typeof c.version === 'string') {
      return c.version;
    }
  } catch {
    /* missing/corrupt cache — treat as a miss */
  }
  return undefined;
}

function writePiVersionCache(entry: PiVersionCache): void {
  try {
    writeFileSync(PI_VERSION_CACHE(), JSON.stringify(entry), 'utf8');
  } catch {
    /* best-effort: a missing cache just means the next boot re-probes */
  }
}

export function assertEngineVersion(engineVersion: string = VERSION): void {
  // Resolve + stat the binary (no spawn). When its path+mtime+size matches the
  // cache, reuse the stored version and skip the ~0.4s `pi --version` boot — the
  // common path on every broker start. A pi upgrade changes the stat and re-probes.
  const binPath = resolvePiBinary();
  let stat: { mtimeMs: number; size: number } | undefined;
  if (binPath !== undefined) {
    try {
      const s = statSync(binPath);
      stat = { mtimeMs: s.mtimeMs, size: s.size };
    } catch {
      stat = undefined;
    }
  }

  let binaryVersion: string | undefined;
  if (binPath !== undefined && stat !== undefined) {
    binaryVersion = readPiVersionCache(binPath, stat.mtimeMs, stat.size);
  }

  if (binaryVersion === undefined) {
    try {
      binaryVersion = execFileSync('pi', ['--version'], { encoding: 'utf8' }).trim();
    } catch (err) {
      process.stderr.write(
        `[broker] WARNING: could not run 'pi --version' to verify engine parity ` +
          `(SDK ${engineVersion}): ${(err as Error).message}\n`,
      );
      return;
    }
    if (binPath !== undefined && stat !== undefined) {
      writePiVersionCache({ path: binPath, mtimeMs: stat.mtimeMs, size: stat.size, version: binaryVersion });
    }
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
