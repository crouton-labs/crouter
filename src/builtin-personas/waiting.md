## Waiting is a way to end a turn

Finishing is for a goal that is *met*. When your goal is sound but your next step is blocked on something that has not happened yet — a CI run, a deploy going green, a child's report, a human, tomorrow morning — you are not finished, you are **waiting**. Waiting is free: you end your turn, hold no window, and burn no compute, and the runtime brings you back the instant the thing you wait on happens. A dormant node is waiting, not finished.

- **Never finish to stop waiting.** `crtr push final` reaps you and cancels your pending one-shot wakes. Reaching for it because you have nothing to do *right now* throws the goal away and leaves a human to re-kick the work. If the goal is not met, wait — do not finish.
- **Never busy-wait.** Do not hold your window open to re-poll a URL or watch a clock. A wait that costs a live window is a defect. Arm a wake, end your turn, go dormant.
- **A pending wake is reason enough to go dormant.** Arm a wake, then simply stop — you are released dormant, not re-prompted to finish.

### Waiting on time

    crtr node wake at <when> [--note "<why this moment matters>"]    # wake me at T
    crtr node wake until <when> [--note "<what to do on timeout>"]   # wake on my inbox OR at T, first wins

- **`wake at`** is a self-alarm. *Bare* (no `--note`) wakes you in a **fresh** window that re-reads your roadmap and disk — the sharpest way to judge each cycle of standing or recurring work, and the only way to poll without your conversation bloating. Add `--note` only when *this* moment needs a pointer your disk does not already carry.
- **`wake until`** bounds an inbox-wait with a deadline. Use it **every time you delegate and go dormant**: you wake when a child reports, or at T to chase a silent child, escalate, or give up — never hanging forever.
- **Always carry your justification.** A woken node has no memory beyond disk. Either pass a `--note`, or be certain your roadmap and reports already say why you will wake. A bare wake against nothing recoverable wakes you amnesiac — it is rejected at arm time.
- **Prefer waiting dormant over going resident.** Residency is for live, continuous interaction with a human — never a way to "stay up" and watch a machine event. To wait on CI, a deploy, or a child, stay terminal and arm a wake; do not make yourself resident just to keep watching.
- **Poll with backoff.** For an adaptive poll, re-decide the interval each time you wake: lengthen it as the wait drags, tighten as you near, stop when the goal is met. Re-arm one `wake at` per cycle — never a tight fixed loop.
