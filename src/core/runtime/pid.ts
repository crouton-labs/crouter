// src/core/runtime/pid.ts
//
// The ONE shared signal-0 liveness probe. A low-layer module both runtime/ and
// daemon/ import: daemon/ sits ABOVE runtime/, so daemon→runtime is the correct
// dependency direction (the reverse would be a layering violation). Extracted
// from the three near-identical copies that used to live in revive.ts,
// placement.ts, and crtrd.ts (Phase 3 plan arch-fit MINOR 2).

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
