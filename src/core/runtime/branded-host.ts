// branded-host.ts — a crouter-branded copy of the `node` binary, so the
// long-lived engine processes (brokers + the crtrd daemon) show "crouter" in
// macOS' TCC / Full Disk Access list instead of the generic "node".
//
// WHY a real copied binary (not a symlink, not process.title): macOS keys a
// Full Disk Access entry on the Mach-O binary's *filename* — not argv[0], not
// process.title, and symlinks resolve to their realpath. So the ONLY way to show
// a branded name is to launch the engine from a real Mach-O file whose filename
// is the brand. We copy the node launcher to `~/.crouter/host/crouter`.
//
// WHY self-contained (libnode beside it): a Homebrew node is a small (~70 KB)
// launcher that dynamically loads `@rpath/libnode.<abi>.dylib` (~70 MB). node's
// LC_RPATH includes `@loader_path`, so a copy of that dylib placed *beside* the
// branded binary resolves with no DYLD_* env var (which SIP can strip) and no
// dependency on the Cellar path surviving — even after a `brew uninstall` of the
// old keg, the branded copy keeps running. A statically-linked node (nodejs.org)
// has no separate libnode; we just copy the binary. The remaining absolute
// `/opt/homebrew/opt/...` deps resolve by their baked-in absolute paths.
//
// SELF-HEAL: ensureBrandedHost() rebuilds the copy whenever the live node drifts
// (a `brew upgrade node` moves realpath(execPath) to a new Cellar version) or the
// copy is missing. The drift check is a cheap marker compare — no subprocess, no
// copy — on the happy path.

import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  renameSync,
  realpathSync,
  unlinkSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CRTR_DIR_NAME } from '../../types.js';

/** The filename the FDA / TCC entry is shown under. */
const BRANDED_BIN_NAME = 'crouter';

/** Machine-global host dir. Deliberately NOT under `CRTR_HOME` (tests override
 *  that to an isolated temp): the branded binary is a per-machine artifact keyed
 *  to the installed node, shared across every canvas home. */
export function brandedHostDir(): string {
  return join(homedir(), CRTR_DIR_NAME, 'host');
}

export function brandedHostBin(): string {
  return join(brandedHostDir(), BRANDED_BIN_NAME);
}

function markerPath(): string {
  return join(brandedHostDir(), '.source.json');
}

interface SourceMarker {
  /** realpath of the node binary this copy was built from. */
  source: string;
  /** filename of the libnode dylib copied beside the binary, or null (static node). */
  libnode: string | null;
}

/** Locate the `libnode.<abi>.dylib` a Homebrew node loads via `@rpath`. node's
 *  rpaths are `@loader_path` and `@loader_path/../lib`, so check the binary's own
 *  dir first, then the sibling `lib/`. Returns the absolute path, or null for a
 *  statically-linked node that has no separate libnode. */
function findLibnode(nodeBin: string): string | null {
  const binDir = dirname(nodeBin);
  for (const dir of [binDir, join(binDir, '..', 'lib')]) {
    if (!existsSync(dir)) continue;
    const hit = readdirSync(dir).find((f) => f.startsWith('libnode.') && f.endsWith('.dylib'));
    if (hit !== undefined) return join(dir, hit);
  }
  return null;
}

/** Copy `src` → `dst` via a unique temp + atomic rename, so concurrent rebuilds
 *  (two brokers spawning at once) never observe a half-written file. */
function atomicCopy(src: string, dst: string, mode?: number): void {
  const tmp = `${dst}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
  copyFileSync(src, tmp);
  if (mode !== undefined) chmodSync(tmp, mode);
  renameSync(tmp, dst);
}

function readMarker(): SourceMarker | null {
  try {
    return JSON.parse(readFileSync(markerPath(), 'utf8')) as SourceMarker;
  } catch {
    return null;
  }
}

/** Ensure the branded host binary exists and matches the live node; return its
 *  absolute path. Idempotent and self-healing. Throws on a genuine build failure
 *  (disk full / permissions) — branding is load-bearing for FDA, so a failure is
 *  surfaced, never silently masked by falling back to `node`. */
export function ensureBrandedHost(): string {
  const dst = brandedHostBin();
  const src = realpathSync(process.execPath);

  // If THIS process is already running as the branded host (the daemon or a
  // broker spawning a child), don't rebuild from ourselves — we can't see the
  // real node from here, and the live process proves the copy works. Drift is
  // healed by the next real-`node` CLI invocation.
  if (existsSync(dst) && realpathSync(dst) === src) return dst;

  const marker = readMarker();
  const libnodeSrc = findLibnode(src);
  const libnodeName = libnodeSrc !== null ? libnodeSrc.split('/').pop()! : null;

  const fresh =
    existsSync(dst) &&
    marker !== null &&
    marker.source === src &&
    marker.libnode === libnodeName &&
    (libnodeName === null || existsSync(join(brandedHostDir(), libnodeName)));
  if (fresh) return dst;

  // (Re)build. Clear a stale libnode of a different ABI so the dir stays clean.
  mkdirSync(brandedHostDir(), { recursive: true });
  if (marker?.libnode != null && marker.libnode !== libnodeName) {
    try {
      unlinkSync(join(brandedHostDir(), marker.libnode));
    } catch {
      /* best-effort */
    }
  }
  if (libnodeSrc !== null && libnodeName !== null) {
    atomicCopy(libnodeSrc, join(brandedHostDir(), libnodeName));
  }
  atomicCopy(src, dst, 0o755);
  writeFileSync(markerPath(), JSON.stringify({ source: src, libnode: libnodeName } satisfies SourceMarker));
  return dst;
}

/** The path the engine (broker / daemon) should be launched from. On macOS in a
 *  compiled (production) build this is the branded host; otherwise — non-darwin
 *  (TCC is macOS-only), source/tsx (dev + the test suite: never copy 70 MB into
 *  the real ~/.crouter), or an explicit `CRTR_BRANDED_HOST=0` opt-out — it is the
 *  live node. These are environment gates, not error fallbacks. */
export function hostExecPath(): string {
  if (process.env['CRTR_BRANDED_HOST'] === '0') return process.execPath;
  if (process.platform !== 'darwin') return process.execPath;
  if (import.meta.url.endsWith('.ts')) return process.execPath;
  return ensureBrandedHost();
}
