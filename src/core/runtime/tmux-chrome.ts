// tmux-chrome.ts — chrome seam (§2.1): stateless keybind/input verbs.
// The ONLY non-placement module allowed to import the tmux driver, per the
// §5.1 lint. Re-exports the menu/nav/send-keys verbs callers (spawn, chord) need.
export { installMenuBinding, installNavBindings, installViewNavBindings, sendKeysEnter } from './tmux.js';
