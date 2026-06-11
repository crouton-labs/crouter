// clipboard-text.ts — write text to the system clipboard for `crtr attach` (/copy).
//
// pi's clipboard binding is not re-exported (see clipboard-image.ts), so we shell
// out to the platform clipboard tool, mirroring the read path: macOS `pbcopy`
// (always present), Linux `wl-copy` (Wayland) or `xclip` (X11). Best-effort —
// returns false (with no throw) when no tool is available or the write fails, so
// the caller can surface an accurate notice.

import { spawnSync } from 'node:child_process';

const SPAWN_TIMEOUT_MS = 3000;

/** Ordered list of [command, args] clipboard-write tools to try for this
 *  platform. The first one present on PATH that succeeds wins. */
function writers(): Array<[string, string[]]> {
  if (process.platform === 'darwin') return [['pbcopy', []]];
  const wayland =
    Boolean(process.env.WAYLAND_DISPLAY) || process.env.XDG_SESSION_TYPE === 'wayland';
  const xclip: [string, string[]] = ['xclip', ['-selection', 'clipboard']];
  const wlcopy: [string, string[]] = ['wl-copy', []];
  return wayland ? [wlcopy, xclip] : [xclip, wlcopy];
}

/** Write `text` to the system clipboard. Returns true on success, false when no
 *  clipboard tool is available or every attempt failed. Never throws. */
export function writeClipboardText(text: string): boolean {
  for (const [command, args] of writers()) {
    const result = spawnSync(command, args, {
      input: text,
      timeout: SPAWN_TIMEOUT_MS,
      encoding: 'utf-8',
    });
    // ENOENT → tool not installed; try the next one.
    if (result.error) {
      if ((result.error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      continue;
    }
    if (result.status === 0) return true;
  }
  return false;
}
