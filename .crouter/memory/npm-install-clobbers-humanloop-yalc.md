---
kind: knowledge
when-and-why-to-read: When you are about to run an install in crouter, or crtr
  suddenly breaks everywhere with a module-not-found error on humanloop exports,
  this reference should be read because installs clobber the humanloop yalc link
  and it gives the exact restore procedure.
short-form: "`npm install` clobbers the humanloop yalc link mid-wave"
system-prompt-visibility: none
file-read-visibility: preview
---

# `npm install` clobbers the humanloop yalc link mid-wave

`@crouton-kit/humanloop` is a **yalc** local link: `node_modules/@crouton-kit/humanloop` is a symlink → `.yalc/@crouton-kit/humanloop`, while `package.json` stays clean at `"latest"`. ANY `npm install` (even adding an unrelated dep like `cron-parser`) re-resolves `"latest"` from the npm registry and **clobbers the symlink with a stale published build** — which breaks the `crtr human` bridge and, observed in practice, breaks `crtr` commands for EVERY live node on the canvas at once, not just the installing one.

**Restore (full, preferred):** Build and push fresh from humanloop, then re-link:
```bash
cd /Users/silasrhyneer/Code/cli/humanloop && npm run build && npx yalc push
```
This updates `.yalc/@crouton-kit/humanloop` to the current build AND re-links `node_modules/@crouton-kit/humanloop` automatically.

**Restore (link-only, if `.yalc` is already current):** `cd /Users/silasrhyneer/Code/cli/crouter && npx yalc link @crouton-kit/humanloop --no-pure` (re-points node_modules → .yalc; leaves package.json untouched).

**Verify:** `readlink node_modules/@crouton-kit/humanloop` must show the `.yalc/` path. Then test a key export: `node --input-type=module -e "import { scanInbox, notifyDeck } from '@crouton-kit/humanloop'; console.log(typeof scanInbox, typeof notifyDeck)"` — both should print `function`. Note: `approveDeck` was removed from humanloop in `6a9fa9a` (v0.3.18); do NOT use it as a validation signal.

**Use npm, NOT pnpm (worktrees especially).** Both `package-lock.json` and `pnpm-lock.yaml` are committed, but the package manager is **npm**: the yalc-linked humanloop only resolves its OWN transitive deps (`string-width`, `zod`, `@r-cli/sdk`) when `node_modules` is flat-hoisted, which npm does and pnpm's isolated layout does not. A `pnpm install` + yalc link leaves the suite RED (`ERR_MODULE_NOT_FOUND: string-width` from `.yalc/@crouton-kit/humanloop/dist/tui/render.js`). A **git worktree** needs its OWN `node_modules` (per-worktree, not shared with `main`): `npm install` → `npx yalc link @crouton-kit/humanloop --no-pure` → `git checkout -- pnpm-lock.yaml package-lock.json` (discard any churn) → build/test. Verified-green crouter baseline: `npm test` = tests 448 / pass 447 / fail 0 / skipped 1 (the 1 skip is the tmux-gated `reviveNode delegates to home_session` test).

**Orchestration consequence:** when fanning out a concurrent wave, NEVER let an `npm install` task run alongside other children — it will break crtr for the whole wave mid-flight. Either isolate the dep-adding task as its own serial step, or have it re-run the yalc link immediately after install. Before the serial T11 full build (and after any install), re-verify/restore the link or the build fails to resolve humanloop exports.
