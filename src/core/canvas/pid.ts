// src/core/canvas/pid.ts
//
// The ONE shared signal-0 liveness probe. It lives at the canvas/ layer — the
// LOWEST shared layer — so canvas/, runtime/, AND daemon/ can all import it
// "down" without a reverse-layer violation (runtime/ sits above canvas/, daemon/
// above runtime/). It is a pure process-existence utility, NOT data-model access,
// so it is exempt from the "only canvas.ts touches the db" rule. Collapses the
// four near-identical copies that used to live in canvas.ts, revive.ts,
// placement.ts, and crtrd.ts into one (Phase 3 review reuse MINOR-1).

/** True if a process with `pid` is currently alive (signal-0 probe). `kill(pid,
 *  0)` throws ESRCH when the process is gone; EPERM means it exists but isn't
 *  ours — still alive. A null/undefined pid (legacy / never-booted) reads dead. */
export function isPidAlive(pid: number | null | undefined): boolean {
  if (pid == null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
