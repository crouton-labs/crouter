// Bug-regression: `crtr attach` Ctrl+V reported "no image in the clipboard" even
// when the clipboard genuinely held an image. Root cause — the macOS reader only
// tried `pngpaste -`, which is NOT a built-in (`brew install pngpaste`); on a
// stock Mac its absence returned null, indistinguishable from an empty clipboard.
//
// These lock in the platform dispatch (clipboard-image.ts): a MISSING pngpaste
// must FALL THROUGH to the native osascript read (not collapse to "no image"),
// and the reader must DISTINGUISH "no clipboard tool" from "clipboard has no
// image" so the user-facing notice is accurate. The decision logic is pure +
// injectable precisely so it can be unit-tested without a real clipboard.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectMacOutcome,
  selectLinuxOutcome,
  type RawReadOutcome,
  type RunResult,
} from '../clipboard-image.js';

const bytes = (s: string): Buffer => Buffer.from(s);

test('macOS: missing pngpaste falls through to the native osascript read (the bug)', () => {
  let nativeCalled = false;
  const runTool = (cmd: string): RunResult => {
    assert.equal(cmd, 'pngpaste');
    return { missing: true }; // pngpaste not installed (stock Mac)
  };
  const readNative = (): RawReadOutcome => {
    nativeCalled = true;
    return { image: { bytes: bytes('PNGDATA'), mimeType: 'image/png' } };
  };
  const out = selectMacOutcome(runTool, readNative);
  assert.equal(nativeCalled, true, 'native osascript path must run when pngpaste is absent');
  assert.equal(out.image?.mimeType, 'image/png');
  assert.equal(out.image?.bytes.toString(), 'PNGDATA');
});

test('macOS: pngpaste present takes the fast path and skips osascript', () => {
  let nativeCalled = false;
  const runTool = (): RunResult => ({ bytes: bytes('FASTPNG') });
  const readNative = (): RawReadOutcome => {
    nativeCalled = true;
    return {};
  };
  const out = selectMacOutcome(runTool, readNative);
  assert.equal(nativeCalled, false, 'fast path must not invoke osascript');
  assert.equal(out.image?.bytes.toString(), 'FASTPNG');
});

test('macOS: pngpaste present but clipboard empty still defers to osascript', () => {
  // pngpaste exits non-zero on an empty clipboard → {} (ran, no image). The
  // native path is authoritative for the empty-vs-failure distinction.
  let nativeCalled = false;
  const runTool = (): RunResult => ({}); // ran, no bytes
  const readNative = (): RawReadOutcome => {
    nativeCalled = true;
    return {}; // osascript: NO_IMAGE
  };
  const out = selectMacOutcome(runTool, readNative);
  assert.equal(nativeCalled, true);
  assert.equal(out.image, undefined);
  assert.equal(out.note, undefined, 'empty clipboard → no note (caller shows the generic notice)');
});

test('Linux: no clipboard tool installed surfaces a precise note, not "no image"', () => {
  const runTool = (): RunResult => ({ missing: true }); // neither xclip nor wl-paste
  const out = selectLinuxOutcome(runTool, /* wayland */ false);
  assert.equal(out.image, undefined);
  assert.match(out.note ?? '', /install xclip/);
});

test('Linux/Wayland: no tool installed names wl-clipboard', () => {
  const out = selectLinuxOutcome(() => ({ missing: true }), /* wayland */ true);
  assert.match(out.note ?? '', /wl-clipboard/);
});

test('Linux: tool present but clipboard has no image → empty (no note)', () => {
  const runTool = (): RunResult => ({}); // xclip ran, no image of that type
  const out = selectLinuxOutcome(runTool, /* wayland */ false);
  assert.equal(out.image, undefined);
  assert.equal(out.note, undefined, 'a tool that ran but found no image is genuinely empty');
});

test('Linux: xclip returns PNG bytes', () => {
  const runTool = (_cmd: string, args: string[]): RunResult =>
    args.includes('image/png') ? { bytes: bytes('XPNG') } : {};
  const out = selectLinuxOutcome(runTool, /* wayland */ false);
  assert.equal(out.image?.mimeType, 'image/png');
  assert.equal(out.image?.bytes.toString(), 'XPNG');
});
