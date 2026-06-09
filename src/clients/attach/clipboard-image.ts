// clipboard-image.ts — read the clipboard image for `crtr attach` (T6, review M1).
//
// pi's `readClipboardImage` is NOT re-exported (it lives behind a native
// clipboard binding + Photon worker the package gates off `.`-only exports), so
// we reimplement the READ by shelling out to the platform clipboard tool
// (pngpaste on macOS, wl-paste on Wayland, xclip on X11) — small + best-effort:
// no tool / empty clipboard → `null` and the caller shows a brief notice.
//
// The bytes are then resized AGGRESSIVELY through pi's exported `resizeImage`
// (which is reusable, unlike the reader) so the base64 stays well within the
// broker's client-read line cap (`BROKER_READ_CAPS.maxLineBytes` = 24 MiB). We
// bound the encoded image to MAX_BYTES (3 MiB) → base64 ≈ 4.1 MiB, comfortable.
// `resizeImage` already tries PNG and JPEG and picks the smaller, so it doubles
// as format normalization; `convertToPng` is the fallback when the Photon
// resizer is unavailable. The result is an `ImageContent` (pi-ai) ready to drop
// straight into a `prompt`/`steer`/`follow_up` frame's `images?` array.

import { spawnSync } from 'node:child_process';
import {
  convertToPng,
  formatDimensionNote,
  resizeImage,
} from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';

/** Longest edge (px) the pasted image is resized to — aggressive, matches the
 *  ~1568px long-edge guidance vision models use. */
const MAX_EDGE = 1568;
/** Largest encoded image (bytes) `resizeImage` will produce. 3 MiB → base64
 *  ≈ 4.1 MiB, far under BROKER_READ_CAPS.maxLineBytes (24 MiB). */
const MAX_BYTES = 3 * 1024 * 1024;
/** Bound the shell read so a giant/garbage clipboard can't blow up memory. */
const SPAWN_MAX_BUFFER = 64 * 1024 * 1024;
const SPAWN_TIMEOUT_MS = 3000;

/** A clipboard image ready to attach, plus an optional human-readable note about
 *  the resize (from pi's `formatDimensionNote`) for the controller to surface. */
export interface ClipboardImageResult {
  /** Ready to push into a `prompt`/`steer`/`follow_up` frame's `images?`. */
  image: ImageContent;
  /** e.g. "Resized from 4032×3024 to 1568×1176" — present only when resized. */
  note?: string;
}

/** Read + resize the current clipboard image. Returns `null` when there is no
 *  image, no clipboard tool, or the read fails (all best-effort — the caller
 *  shows a brief notice and carries on). */
export async function readClipboardImage(): Promise<ClipboardImageResult | null> {
  const raw = readRawClipboardImage();
  if (!raw) return null;

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
  // the engine gets a format it accepts.
  const png = await convertToPng(raw.bytes.toString('base64'), raw.mimeType);
  if (png) return { image: { type: 'image', data: png.data, mimeType: png.mimeType } };

  // Last resort: ship the raw bytes (still bounded by SPAWN_MAX_BUFFER above).
  return { image: { type: 'image', data: raw.bytes.toString('base64'), mimeType: raw.mimeType } };
}

// ---------------------------------------------------------------------------

interface RawImage {
  bytes: Buffer;
  mimeType: string;
}

/** Shell out to the platform clipboard tool for raw image bytes. */
function readRawClipboardImage(): RawImage | null {
  if (process.platform === 'darwin') {
    const out = run('pngpaste', ['-']);
    return out ? { bytes: out, mimeType: 'image/png' } : null;
  }

  // Linux: Wayland first (wl-paste), then X11 (xclip). Try PNG then JPEG.
  if (isWayland()) {
    const out = run('wl-paste', ['--type', 'image/png', '--no-newline']);
    if (out) return { bytes: out, mimeType: 'image/png' };
  }
  for (const mimeType of ['image/png', 'image/jpeg']) {
    const out = run('xclip', ['-selection', 'clipboard', '-t', mimeType, '-o']);
    if (out) return { bytes: out, mimeType };
  }
  return null;
}

function isWayland(): boolean {
  return Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
}

/** Run a clipboard tool; return its stdout Buffer, or `null` on any failure
 *  (missing binary, non-zero exit, timeout, empty output). */
function run(command: string, args: string[]): Buffer | null {
  const result = spawnSync(command, args, {
    timeout: SPAWN_TIMEOUT_MS,
    maxBuffer: SPAWN_MAX_BUFFER,
  });
  if (result.error || result.status !== 0) return null;
  const stdout = result.stdout;
  if (!stdout || stdout.length === 0) return null;
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}
