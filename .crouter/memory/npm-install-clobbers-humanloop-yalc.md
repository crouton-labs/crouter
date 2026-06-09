---
kind: reference
when: When you are about to run an install in crouter, or crtr suddenly breaks
  everywhere with a missing-approveDeck / module-not-found error
why: Installs clobber the humanloop yalc link, and it gives the exact
  restore procedure
short-form: "`npm install` clobbers the humanloop yalc link mid-wave"
system-prompt-visibility: none
file-read-visibility: preview
---

# `npm install` clobbers the humanloop yalc link mid-wave

`@crouton-kit/humanloop` is a **yalc** local link: `node_modules/@crouton-kit/humanloop` is a symlink → `.yalc/@crouton-kit/humanloop`, while `package.json` stays clean at `"latest"`. ANY `npm install` (even adding an unrelated dep like `cron-parser`) re-resolves `"latest"` from the npm registry and **clobbers the symlink with a published build that lacks `approveDeck`** — which breaks the `crtr human` bridge and, observed in practice, breaks `crtr` commands for EVERY live node on the canvas at once, not just the installing one.

**Restore:** `cd /Users/silasrhyneer/Code/cli/crouter && npx yalc link @crouton-kit/humanloop --no-pure` (re-points node_modules → .yalc; leaves package.json untouched). Verify: `ls -la node_modules/@crouton-kit/humanloop` should be a symlink into `.yalc`, and `grep -rl approveDeck node_modules/@crouton-kit/humanloop/dist` should hit.

**Use npm, NOT pnpm (worktrees especially).** Both `package-lock.json` and `pnpm-lock.yaml` are committed, but the package manager is **npm**: the yalc-linked humanloop only resolves its OWN transitive deps (`string-width`, `zod`, `@r-cli/sdk`) when `node_modules` is flat-hoisted, which npm does and pnpm's isolated layout does not. A `pnpm install` + yalc link leaves the suite RED (`ERR_MODULE_NOT_FOUND: string-width` from `.yalc/@crouton-kit/humanloop/dist/tui/render.js`). A **git worktree** needs its OWN `node_modules` (per-worktree, not shared with `main`): `npm install` → `npx yalc link @crouton-kit/humanloop --no-pure` → `git checkout -- pnpm-lock.yaml package-lock.json` (discard any churn) → build/test. Verified-green crouter baseline: `npm test` = tests 448 / pass 447 / fail 0 / skipped 1 (the 1 skip is the tmux-gated `reviveNode delegates to home_session` test).

**Orchestration consequence:** when fanning out a concurrent wave, NEVER let an `npm install` task run alongside other children — it will break crtr for the whole wave mid-flight. Either isolate the dep-adding task as its own serial step, or have it re-run the yalc link immediately after install. Before the serial T11 full build (and after any install), re-verify/restore the link or the build fails to resolve `approveDeck`.
