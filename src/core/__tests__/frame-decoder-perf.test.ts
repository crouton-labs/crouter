// Run with: node --import tsx/esm --test src/core/__tests__/frame-decoder-perf.test.ts
//
// Bug-regression suite for the FrameDecoder O(n²) typing-lag bug (2026-06-09).
//
// OBSERVED BUG: typing in `crtr attach` lagged after the headless-broker change.
// Root cause #1: FrameDecoder.push() did `this.buf += str` and re-scanned the
// WHOLE accumulated buffer (`this.buf.indexOf('\n')` + Buffer.byteLength over
// the consumed prefix) on every ~64 KiB socket chunk, so one large frame (the
// multi-MiB `welcome` snapshot, a big tool result) cost O(frame × chunks) —
// measured ~254 ms of event-loop stall decoding a 16 MiB frame, with the stall
// growing ~5× per size doubling. The decoder runs on BOTH the viewer and broker
// read paths, so the stall blocked keystroke handling directly.
//
// The fix holds the carried partial line as an array of chunk strings and scans
// each incoming chunk exactly once — amortized O(total bytes). Same 16 MiB frame:
// ~12 ms.
//
// These tests lock in (a) behavioral equivalence with the old decoder across
// randomized chunkings — frames, blank-line skip, malformed-JSON drop, multibyte
// splits, and both FrameOverflowError caps with identical byte accounting — and
// (b) the linear growth curve, so the quadratic shape cannot silently return.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StringDecoder } from 'node:string_decoder';
import {
  FrameDecoder,
  FrameOverflowError,
  CLIENT_READ_CAPS,
  type FrameDecoderCaps,
} from '../runtime/broker-protocol.js';

// ---------------------------------------------------------------------------
// The PRE-FIX decoder, verbatim (git ed49e60), as the equivalence oracle.
// ---------------------------------------------------------------------------
class ReferenceFrameDecoder {
  private buf = '';
  private bufBytes = 0;
  private readonly utf8 = new StringDecoder('utf8');
  constructor(private readonly caps: FrameDecoderCaps) {}
  push(chunk: Buffer | string): unknown[] {
    const str = typeof chunk === 'string' ? chunk : this.utf8.write(chunk);
    this.buf += str;
    this.bufBytes += Buffer.byteLength(str);
    if (this.bufBytes > this.caps.maxTotalBytes) {
      throw new FrameOverflowError('total', this.bufBytes, this.caps.maxTotalBytes);
    }
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const consumed = this.buf.slice(0, nl + 1);
      this.bufBytes -= Buffer.byteLength(consumed);
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line === '') continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* drop malformed */
      }
    }
    if (this.bufBytes > this.caps.maxLineBytes) {
      throw new FrameOverflowError('line', this.bufBytes, this.caps.maxLineBytes);
    }
    return out;
  }
}

// Deterministic PRNG so a failure reproduces.
let seed = 0xc0ffee;
const rnd = (): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const randInt = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));
const MULTIBYTE = ['é', '漢', '🎉', '𝕏', 'ü', '한'];
const randText = (len: number): string => {
  let s = '';
  while (s.length < len) {
    s += rnd() < 0.2 ? MULTIBYTE[randInt(0, MULTIBYTE.length - 1)] : String.fromCharCode(randInt(97, 122));
  }
  return s;
};

type PushResult = { frames: unknown[]; err: string | null };
function run(dec: { push(c: Buffer | string): unknown[] }, stream: Buffer, cuts: number[]): PushResult {
  const frames: unknown[] = [];
  let prev = 0;
  try {
    for (const cut of [...cuts, stream.length]) {
      if (cut <= prev) continue;
      frames.push(...dec.push(stream.subarray(prev, cut)));
      prev = cut;
    }
    return { frames, err: null };
  } catch (e) {
    if (e instanceof FrameOverflowError) return { frames, err: `${e.kind}:${e.bytes}:${e.cap}` };
    throw e;
  }
}

test('FrameDecoder — behavior-equivalent to the pre-fix decoder across randomized chunkings (frames, blank lines, malformed JSON, multibyte splits, both overflow caps)', () => {
  for (let t = 0; t < 1500; t++) {
    // Small caps in ~30% of trials exercise both FrameOverflowError kinds with
    // identical byte accounting; generous caps exercise the happy path.
    const caps: FrameDecoderCaps =
      rnd() < 0.3
        ? { maxLineBytes: randInt(50, 1500), maxTotalBytes: randInt(100, 4000) }
        : { maxLineBytes: 1 << 20, maxTotalBytes: 1 << 21 };
    const pieces: string[] = [];
    for (let i = 0, n = randInt(1, 12); i < n; i++) {
      const kind = rnd();
      if (kind < 0.55) pieces.push(JSON.stringify({ type: 'x', t: randText(randInt(0, 2000)) }) + '\n');
      else if (kind < 0.7) pieces.push('\n'); // blank-line skip
      else if (kind < 0.8) pieces.push('   \n'); // whitespace-only skip
      else if (kind < 0.9) pieces.push('{not json' + randText(randInt(0, 50)) + '\n'); // malformed drop
      else pieces.push(randText(randInt(0, 300))); // trailing partial, no newline
    }
    const stream = Buffer.from(pieces.join(''));
    // Byte-level cut points — these can and do split multibyte chars.
    const cuts = Array.from({ length: randInt(0, 20) }, () => randInt(0, stream.length)).sort((a, b) => a - b);

    const expected = run(new ReferenceFrameDecoder(caps), stream, cuts);
    const actual = run(new FrameDecoder(caps), stream, cuts);
    assert.deepEqual(
      actual,
      expected,
      `trial ${t}: caps=${JSON.stringify(caps)} cuts=${JSON.stringify(cuts)} stream=${JSON.stringify(stream.toString('utf8').slice(0, 300))}`,
    );
  }
});

test('FrameDecoder — mixed string/Buffer pushes stay equivalent', () => {
  for (let t = 0; t < 300; t++) {
    const caps: FrameDecoderCaps = { maxLineBytes: 1 << 20, maxTotalBytes: 1 << 21 };
    const ref = new ReferenceFrameDecoder(caps);
    const dec = new FrameDecoder(caps);
    const refF: unknown[] = [];
    const decF: unknown[] = [];
    for (let i = 0, n = randInt(1, 10); i < n; i++) {
      const s = rnd() < 0.5 ? JSON.stringify({ i, t: randText(randInt(0, 200)) }) + '\n' : randText(randInt(0, 100));
      const input: Buffer | string = rnd() < 0.5 ? s : Buffer.from(s);
      refF.push(...ref.push(input));
      decF.push(...dec.push(input));
    }
    assert.deepEqual(decF, refF, `mixed trial ${t}`);
  }
});

test('FrameDecoder — a frame exactly AT each cap passes; one byte over throws (cap accounting exact)', () => {
  // line cap: an unterminated partial exactly at maxLineBytes is fine…
  {
    const caps: FrameDecoderCaps = { maxLineBytes: 100, maxTotalBytes: 1000 };
    const dec = new FrameDecoder(caps);
    assert.deepEqual(dec.push('x'.repeat(100)), []);
    // …and the 101st byte trips it, reporting the full buffered size.
    assert.throws(
      () => dec.push('x'),
      (e: unknown) => e instanceof FrameOverflowError && e.kind === 'line' && e.bytes === 101 && e.cap === 100,
    );
  }
  // total cap: carry + chunk exactly at maxTotalBytes is fine; one over throws.
  {
    const caps: FrameDecoderCaps = { maxLineBytes: 1000, maxTotalBytes: 100 };
    const dec = new FrameDecoder(caps);
    assert.deepEqual(dec.push('x'.repeat(60)), []);
    assert.deepEqual(dec.push('x'.repeat(40 - 60 > 0 ? 0 : 40)), []); // 60 + 40 = 100, at cap
    assert.throws(
      () => dec.push('x'),
      (e: unknown) => e instanceof FrameOverflowError && e.kind === 'total' && e.bytes === 101 && e.cap === 100,
    );
  }
  // multibyte accounting: bytes, not chars (é = 2 bytes).
  {
    const caps: FrameDecoderCaps = { maxLineBytes: 10, maxTotalBytes: 1000 };
    const dec = new FrameDecoder(caps);
    assert.throws(
      () => dec.push('é'.repeat(6)), // 12 bytes > 10, only 6 chars
      (e: unknown) => e instanceof FrameOverflowError && e.kind === 'line' && e.bytes === 12,
    );
  }
});

test('FrameDecoder — large-frame decode is linear, not quadratic (the observed attach-lag regression)', () => {
  // Decode a single N-MiB frame in 64 KiB chunks; compare per-MiB cost at 2 MiB
  // vs 8 MiB. Quadratic shape ⇒ per-MiB cost grows ~4× per 4× size (measured
  // 5.5×+ pre-fix); linear stays ~flat. Threshold 3× is far above linear noise
  // and far below the quadratic signature, so this fails ONLY on a complexity
  // regression, not on a slow CI box.
  const CHUNK = 64 * 1024;
  const decodeMs = (mib: number): number => {
    const overhead = Buffer.byteLength('{"type":"welcome","blob":""}\n');
    const frame = Buffer.from(`{"type":"welcome","blob":"${'x'.repeat(mib * 1024 * 1024 - overhead)}"}\n`);
    let best = Infinity;
    for (let rep = 0; rep < 3; rep++) {
      const dec = new FrameDecoder(CLIENT_READ_CAPS);
      const t0 = performance.now();
      let n = 0;
      for (let off = 0; off < frame.length; off += CHUNK) {
        n += dec.push(frame.subarray(off, Math.min(off + CHUNK, frame.length))).length;
      }
      const ms = performance.now() - t0;
      assert.equal(n, 1, 'decoded exactly one frame');
      if (ms < best) best = ms;
    }
    return best;
  };
  decodeMs(1); // warmup
  const perMibSmall = decodeMs(2) / 2;
  const perMibLarge = decodeMs(8) / 8;
  assert.ok(
    perMibLarge < perMibSmall * 3,
    `per-MiB decode cost grew superlinearly: ${perMibSmall.toFixed(2)}ms/MiB @2MiB → ${perMibLarge.toFixed(2)}ms/MiB @8MiB (quadratic regression)`,
  );
});
