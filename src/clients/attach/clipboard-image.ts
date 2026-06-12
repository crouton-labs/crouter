// clipboard-image.ts — read the clipboard image for `crtr attach` (T6, review M1).
//
// pi's `readClipboardImage` is NOT re-exported (it lives behind a native
// clipboard binding + Photon worker the package gates off `.`-only exports), so
// we reimplement the READ by shelling out to the platform clipboard tool. macOS:
// `pngpaste` is a faster path IF present, but it is NOT a built-in (`brew install
// pngpaste`), so the authoritative read is the dependency-free `osascript` path
// (`the clipboard as «class PNGf»` → temp PNG), which works on a stock Mac.
// Linux: `wl-paste` on Wayland, `xclip` on X11. The reader DISTINGUISHES three
// outcomes — got bytes, clipboard genuinely empty, or no clipboard tool / read
// failure — so the caller's notice is accurate ("No image in the clipboard" vs a
// precise "install xclip" / "osascript failed") instead of collapsing every
// miss to "no image".
//
// The bytes are then resized AGGRESSIVELY through pi's exported `resizeImage`
// (which is reusable, unlike the reader) so the base64 stays well within the
// broker's client-read line cap (`BROKER_READ_CAPS.maxLineBytes` = 24 MiB).
// `resizeImage`'s `maxBytes` is the BASE64-PAYLOAD ceiling (it compares the
// encoded size, not raw bytes — see image-resize-core), so MAX_BYTES (3 MiB)
// bounds the base64 itself, far under 24 MiB. `resizeImage` already tries PNG and
// JPEG and picks the smaller, so it doubles as format normalization;
// `convertToPng` is the fallback when the Photon resizer is unavailable. The
// fallbacks (convertToPng / raw bytes) are NOT size-bounded by `resizeImage`, so
// each is gated on the SAME MAX_BYTES base64 ceiling (review M1): over it → the
// image is DROPPED with a user-visible note rather than shipped as an over-cap
// frame that would overflow BROKER_READ_CAPS.maxLineBytes (24 MiB) and destroy
// the viewer socket. The result is an `ImageContent` (pi-ai) ready to drop
// straight into a `prompt`/`steer`/`follow_up` frame's `images?` array (or, when
// dropped, a `note`-only result and no image).

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  convertToPng,
  formatDimensionNote,
  resizeImage,
} from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';

/** Longest edge (px) the pasted image is resized to — aggressive, matches the
 *  ~1568px long-edge guidance vision models use. */
const MAX_EDGE = 1568;
/** Largest BASE64 payload per image — the ceiling for BOTH paths: passed as
 *  `resizeImage`'s `maxBytes` (which bounds the encoded base64, not raw bytes)
 *  on the primary path, and compared against the fallbacks' base64 length. 3 MiB
 *  base64, far under BROKER_READ_CAPS.maxLineBytes (24 MiB). */
const MAX_BYTES = 3 * 1024 * 1024;
/** Bound the shell read so a giant/garbage clipboard can't blow up memory. */
const SPAWN_MAX_BUFFER = 64 * 1024 * 1024;
const SPAWN_TIMEOUT_MS = 3000;

/** A clipboard image ready to attach, plus an optional note for the controller
 *  to surface — either a resize note (from pi's `formatDimensionNote`) or, when
 *  no image was attached, the reason (dropped over the cap, or no clipboard
 *  tool / read failure). */
export interface ClipboardImageResult {
  /** Ready to push into a `prompt`/`steer`/`follow_up` frame's `images?`. ABSENT
   *  when the image was read but DROPPED (a fallback exceeded MAX_BYTES base64),
   *  or when there was no image to read but a precise reason is worth surfacing;
   *  `note` then carries that reason and the caller attaches nothing. */
  image?: ImageContent;
  /** Either a resize note ("Resized from 4032×3024 to 1568×1176", present only
   *  when resized) or, when `image` is absent, the reason no image was attached. */
  note?: string;
}

/** Persist a (already-resized) clipboard image to a stable temp file and return
 *  its absolute path, so the attach editor can drop the PATH inline into the
 *  prompt instead of inlining base64 the agent can't see. The broker runs on the
 *  same host, so a tmpdir path is readable by the engine. */
export function writeClipboardImageToFile(image: ImageContent): string {
  const dir = join(tmpdir(), 'crtr-clip-images');
  mkdirSync(dir, { recursive: true });
  const ext = image.mimeType === 'image/jpeg' ? 'jpg' : 'png';
  const path = join(dir, `paste-${Date.now()}-${process.pid}.${ext}`);
  writeFileSync(path, Buffer.from(image.data, 'base64'));
  return path;
}

/** Read + resize the current clipboard image. Returns `null` ONLY when the
 *  clipboard genuinely holds no image; a `note`-only result means there is a
 *  precise reason to surface (no clipboard tool, read failure, or an over-cap
 *  drop). All best-effort — the caller shows a brief notice and carries on. */
export async function readClipboardImage(): Promise<ClipboardImageResult | null> {
  const outcome = readRawClipboardImage();
  const raw = outcome.image;
  if (!raw) {
    // No bytes. A `note` means a precise reason worth surfacing (no clipboard
    // tool, or a read failure) — return it so the caller shows it instead of the
    // generic "No image in the clipboard". No note → the clipboard is genuinely
    // empty → null (caller shows the generic notice).
    return outcome.note ? { note: outcome.note } : null;
  }

  // Primary path: resize aggressively. Handles format (PNG/JPEG) + size bound.
  const resized = await resizeImage(new Uint8Array(raw.bytes), raw.mimeType, {
    maxWidth: MAX_EDGE,
    maxHeight: MAX_EDGE,
    maxBytes: MAX_BYTES,
  });
  if (resized) {
    return {
      image: { type: 'image', data: resized.data, mimeType: resized.mimeType },
      note: resized.wasResized ? formatDimensionNote(resized) : undefined,
    };
  }

  // Fallback: the Photon resizer is unavailable — at least normalize to PNG so
  // the engine gets a format it accepts. Capped at MAX_BYTES (base64).
  const png = await convertToPng(raw.bytes.toString('base64'), raw.mimeType);
  if (png) return capped({ type: 'image', data: png.data, mimeType: png.mimeType });

  // Last resort: ship the raw bytes — also capped, never an over-cap frame.
  return capped({ type: 'image', data: raw.bytes.toString('base64'), mimeType: raw.mimeType });
}

/** Gate a FALLBACK image on the per-image base64 ceiling (MAX_BYTES): under it →
 *  attach; over → DROP with a user-visible note rather than ship a frame that
 *  would overflow the broker's 24 MiB read cap and destroy the viewer socket.
 *  base64 is ASCII, so its byte length equals the bytes the frame puts on the
 *  wire. */
function capped(image: ImageContent): ClipboardImageResult {
  const encodedBytes = Buffer.byteLength(image.data);
  if (encodedBytes <= MAX_BYTES) return { image };
  const mib = (n: number): number => Math.round(n / (1024 * 1024));
  return {
    note: `Image not attached: ${mib(encodedBytes)} MiB exceeds the ${mib(MAX_BYTES)} MiB attach limit (clipboard resizer unavailable)`,
  };
}

// ---------------------------------------------------------------------------
// Raw clipboard read (platform shell-out).
// ---------------------------------------------------------------------------

interface RawImage {
  bytes: Buffer;
  mimeType: string;
}

/** Outcome of the raw clipboard read, distinguishing the three cases the caller
 *  must tell apart: `image` present → got bytes; `note` present → no image AND a
 *  precise reason to surface (no clipboard tool / read failure); both absent →
 *  the clipboard genuinely holds no image. */
export interface RawReadOutcome {
  image?: RawImage;
  note?: string;
}

/** Result of probing one clipboard tool, distinguishing a MISSING binary (so the
 *  caller can say "no clipboard tool") from a tool that ran but produced no image
 *  (`bytes` absent, `missing` false → genuinely empty). */
export interface RunResult {
  /** Tool stdout when it produced non-empty output. */
  bytes?: Buffer;
  /** The binary was not found on PATH (ENOENT). */
  missing?: boolean;
}

/** Shell out to the platform clipboard tool for raw image bytes. */
function readRawClipboardImage(): RawReadOutcome {
  if (process.platform === 'darwin') {
    return selectMacOutcome(run, readMacClipboardViaOsascript);
  }
  return selectLinuxOutcome(run, isWayland());
}

/** Pure macOS dispatch (the regression-test seam): try `pngpaste` if present,
 *  else fall through to the native osascript read — a missing `pngpaste` must
 *  NOT collapse to "no image", which was the stock-Mac bug. */
export function selectMacOutcome(
  runTool: (command: string, args: string[]) => RunResult,
  readNative: () => RawReadOutcome,
): RawReadOutcome {
  const fast = runTool('pngpaste', ['-']);
  if (fast.bytes) return { image: { bytes: fast.bytes, mimeType: 'image/png' } };
  // pngpaste missing OR clipboard empty → osascript is authoritative.
  return readNative();
}

/** Pure Linux dispatch (the regression-test seam): Wayland (`wl-paste`) first,
 *  then X11 (`xclip`), PNG then JPEG. If NO tool binary was found, surface a
 *  precise "install …" note; if a tool ran but found no image, report empty. */
export function selectLinuxOutcome(
  runTool: (command: string, args: string[]) => RunResult,
  wayland: boolean,
): RawReadOutcome {
  let anyToolPresent = false;
  if (wayland) {
    const out = runTool('wl-paste', ['--type', 'image/png', '--no-newline']);
    if (out.bytes) return { image: { bytes: out.bytes, mimeType: 'image/png' } };
    if (!out.missing) anyToolPresent = true;
  }
  for (const mimeType of ['image/png', 'image/jpeg']) {
    const out = runTool('xclip', ['-selection', 'clipboard', '-t', mimeType, '-o']);
    if (out.bytes) return { image: { bytes: out.bytes, mimeType } };
    if (!out.missing) anyToolPresent = true;
  }
  if (!anyToolPresent) {
    return {
      note: wayland
        ? 'No clipboard tool found — install wl-clipboard (wl-paste) to paste images'
        : 'No clipboard tool found — install xclip to paste images',
    };
  }
  return {}; // a tool ran but the clipboard holds no image
}

/** AppleScript that writes the clipboard's PNG representation to the temp path
 *  in `argv`. `the clipboard as «class PNGf»` THROWS when the clipboard has no
 *  PNG-convertible image — caught → "NO_IMAGE" (a clean empty signal, distinct
 *  from a failure). A write failure (after `set eof` already truncated the file)
 *  closes the handle and returns "WRITE_FAILED" rather than swallowing the error
 *  and reporting a false "OK" over a 0-byte/partial file — so "OK" reliably means
 *  the full bytes are in the temp file, preserving the empty-vs-failure split. */
const MAC_PNG_SCRIPT = `on run argv
  set outPath to item 1 of argv
  try
    set pngData to (the clipboard as «class PNGf»)
  on error
    return "NO_IMAGE"
  end try
  set fh to open for access (POSIX file outPath) with write permission
  try
    set eof fh to 0
    write pngData to fh
    close access fh
  on error
    try
      close access fh
    end try
    return "WRITE_FAILED"
  end try
  return "OK"
end run`;

/** Native, dependency-free macOS read: osascript (always present) writes the
 *  clipboard PNG to a temp file we then read. Distinguishes empty ("NO_IMAGE")
 *  from a genuine read failure so the caller's notice is accurate. */
function readMacClipboardViaOsascript(): RawReadOutcome {
  const tmpFile = join(tmpdir(), `crtr-clip-${process.pid}-${Date.now()}.png`);
  try {
    const result = spawnSync('osascript', ['-e', MAC_PNG_SCRIPT, tmpFile], {
      timeout: SPAWN_TIMEOUT_MS,
      maxBuffer: SPAWN_MAX_BUFFER,
      encoding: 'utf-8',
    });
    if (result.error || result.status !== 0) {
      return { note: 'Could not read the clipboard (osascript failed)' };
    }
    const signal = (result.stdout ?? '').trim();
    if (signal === 'NO_IMAGE') return {}; // clipboard genuinely holds no image
    if (signal !== 'OK') return { note: 'Could not read the clipboard image' };
    let bytes: Buffer;
    try {
      bytes = readFileSync(tmpFile);
    } catch {
      return { note: 'Could not read the clipboard image' };
    }
    return bytes.length > 0 ? { image: { bytes, mimeType: 'image/png' } } : {};
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      /* ignore temp-file cleanup errors (NO_IMAGE never created it) */
    }
  }
}

function isWayland(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
}

/** Run a clipboard tool; return its stdout bytes, or a `missing` flag when the
 *  binary isn't on PATH (so the caller can distinguish "no tool" from "no
 *  image"). Any other failure (non-zero exit, timeout, empty output) → an empty
 *  result ({}), i.e. the tool ran but yielded no image. */
function run(command: string, args: string[]): RunResult {
  const result = spawnSync(command, args, {
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (result.error) {
    const missing = (result.error as NodeJS.ErrnoException).code === 'ENOENT';
    return { missing };
  }
  if (result.status !== 0) return {};
  const stdout = result.stdout;
  if (!stdout || stdout.length === 0) return {};
  return { bytes: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout) };
}
