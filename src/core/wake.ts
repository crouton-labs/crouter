// Time grammar + recurrence evaluation for scheduled wakeups.
//
// This is the ONE place that owns wakeup time logic. Both the CLI surface
// (`node wake at|until|spawn`) and the daemon's firing pass import
// from here, so there is no duplicated cron usage and no surface<->daemon
// inverted dependency:
//   - parseWhen / parseCadence  — arm-time grammar (surface, T7)
//   - nextSlotAfter             — per-tick advance / coalescing (daemon, T4)
//
// Design refs: surface-design §4 (grammar), §5 (timezone/DST ruling),
// design §5.3 + D7 (engine evaluates UTC; the surface bakes the IANA zone
// into a calendar `recur`). Tick-scale only — no sub-second precision.

import { CronExpressionParser } from 'cron-parser';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Error codes this module owns (a subset of surface-design §4.3). */
export type WakeErrorCode =
  | 'wake_in_past'
  | 'bad_when'
  | 'bad_cadence'
  | 'unknown_zone'
  | 'cadence_too_fast';

export interface WakeError {
  code: WakeErrorCode;
  message: string;
  /** The offending input, echoed back for the rendered error block. */
  received: string;
}

export type WhenResult = { fireAt: string } | { error: WakeError };
export type CadenceResult = { recur: string; firstFireAt: string } | { error: WakeError };

export interface ParseOpts {
  /** IANA zone for bare wall-clock / calendar cadence; defaults to host-local. */
  tz?: string;
  /** Resolution anchor (frozen "now"). */
  now: Date;
}

/**
 * The two `recur` JSON shapes (pinned in the plan's Shared contracts). Stored
 * as a JSON string in the `wakeups.recur` column; consumed by `nextSlotAfter`.
 */
export type Recur =
  | { every: string } // fixed interval, e.g. {"every":"6h"}
  | { cron: string; tz: string }; // calendar cron w/ baked IANA zone

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cadence floor: reject any interval / cron min-spacing below this (AC-N4). */
export const CADENCE_FLOOR_MS = 60_000;

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

// `<int><unit>` repeated; units s/m/h/d (surface-design §4.1).
const DURATION_RE = /^\+?(?:\d+[smhd])+$/;
const DURATION_PART_RE = /(\d+)([smhd])/g;

// ISO-8601 date-time core (no zone). Captures Y M D h m [s] [ms].
const ISO_CORE_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?/;
// Trailing zone designator: Z | ±HH[:MM] | ±HHMM.
const ZONE_SUFFIX_RE = /^(Z|[+-]\d{2}(?::?\d{2})?)$/;

// Cron `@alias` -> 5-field expansion (the engine never stores a bare alias).
const CRON_ALIASES: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function whenError(code: WakeErrorCode, message: string, received: string): WhenResult {
  return { error: { code, message, received } };
}

function cadenceError(code: WakeErrorCode, message: string, received: string): CadenceResult {
  return { error: { code, message, received } };
}

/** Total ms for a relative-duration string, or null if it is not one. */
function parseDurationMs(s: string): number | null {
  if (!DURATION_RE.test(s)) return null;
  let total = 0;
  DURATION_PART_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DURATION_PART_RE.exec(s)) !== null) {
    total += Number(m[1]) * DURATION_UNIT_MS[m[2]!]!;
  }
  return total;
}

/** Host-configured IANA zone (crtr is a single-machine runtime). */
function hostZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

/** True iff `tz` is a resolvable IANA zone name. */
function isValidZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` at the given UTC instant: wall-clock-as-UTC minus instant. */
function zoneOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = p.value;
  }
  const asUTC = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
    Number(parts['second']),
  );
  return asUTC - utcMs;
}

/** Interpret a wall-clock instant in `tz` and return the UTC ms instant. */
function wallClockToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  ms: number,
  tz: string,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const off1 = zoneOffsetMs(tz, guess);
  let utc = guess - off1;
  // Second pass settles DST-boundary cases where the offset at the candidate
  // instant differs from the offset at the naive guess.
  const off2 = zoneOffsetMs(tz, utc);
  if (off2 !== off1) utc = guess - off2;
  return utc;
}

type IsoBare = {
  zoned: false;
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
  s: number;
  ms: number;
};
type IsoClassified = { zoned: true } | IsoBare;

/** Classify a string as a zoned/bare ISO date-time, or null if it is neither. */
function classifyIso(s: string): IsoClassified | null {
  const m = ISO_CORE_RE.exec(s);
  if (!m || m.index !== 0) return null;
  const rest = s.slice(m[0].length);
  if (rest === '') {
    return {
      zoned: false,
      y: Number(m[1]),
      mo: Number(m[2]),
      d: Number(m[3]),
      h: Number(m[4]),
      mi: Number(m[5]),
      s: m[6] ? Number(m[6]) : 0,
      ms: m[7] ? Number(m[7].padEnd(3, '0')) : 0,
    };
  }
  if (ZONE_SUFFIX_RE.test(rest)) return { zoned: true };
  return null; // trailing garbage -> not a valid ISO instant
}

// ---------------------------------------------------------------------------
// parseWhen — resolve a one-shot <when> to an absolute UTC instant
// ---------------------------------------------------------------------------

/**
 * Resolve a `<when>` to a single UTC `fireAt`:
 *   - relative duration (`90s`, `1h30m`)        -> now + Σ
 *   - absolute zoned ISO (`…Z` / `±HH:MM`)       -> that exact instant
 *   - absolute bare ISO (`2026-06-07T09:00`)     -> wall clock in `tz`
 *                                                   (default host-local) -> UTC
 *
 * A bare wall-clock time is interpreted in `opts.tz` when given, else the host
 * zone, and frozen to a UTC instant (DST never re-enters a one-shot). A
 * resolved instant not strictly in the future is rejected (`wake_in_past`).
 */
export function parseWhen(when: string, opts: ParseOpts): WhenResult {
  const received = when;
  const raw = when.trim();
  const nowMs = opts.now.getTime();

  // 1. relative duration
  const durMs = parseDurationMs(raw);
  if (durMs !== null) {
    const fireMs = nowMs + durMs;
    if (fireMs <= nowMs) {
      return whenError(
        'wake_in_past',
        `That resolves to now or the past. Use a positive future duration (e.g. "5m", "2h").`,
        received,
      );
    }
    return { fireAt: new Date(fireMs).toISOString() };
  }

  // 2/3. absolute ISO (zoned or bare)
  const iso = classifyIso(raw);
  if (iso) {
    let fireMs: number;
    if (iso.zoned) {
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        return whenError('bad_when', `Not a valid ISO-8601 instant: "${received}".`, received);
      }
      fireMs = d.getTime();
    } else {
      const tz = opts.tz ?? hostZone();
      if (!isValidZone(tz)) {
        return whenError(
          'unknown_zone',
          `Unknown time zone: "${tz}". Use an IANA name (e.g. "America/New_York").`,
          opts.tz ?? tz,
        );
      }
      fireMs = wallClockToUtc(iso.y, iso.mo, iso.d, iso.h, iso.mi, iso.s, iso.ms, tz);
      if (Number.isNaN(fireMs)) {
        return whenError('bad_when', `Not a valid date-time: "${received}".`, received);
      }
    }
    if (fireMs <= nowMs) {
      return whenError(
        'wake_in_past',
        `That time is now or in the past. Pick a future instant.`,
        received,
      );
    }
    return { fireAt: new Date(fireMs).toISOString() };
  }

  return whenError(
    'bad_when',
    `Could not parse "${received}". Use a duration ("5m", "1h30m"), a zoned ISO ("2026-06-07T09:00:00Z"), or a bare ISO ("2026-06-07T09:00").`,
    received,
  );
}

// ---------------------------------------------------------------------------
// parseCadence — resolve --every to a stored recur + first fire
// ---------------------------------------------------------------------------

/**
 * Resolve a `<cadence>` (the `--every` value) to a stored `recur` JSON string
 * plus the first `fireAt`:
 *   - fixed interval (a duration)  -> {"every":"<dur>"},   first = now + interval
 *   - calendar cron / @alias       -> {"cron":"<5-field>","tz":"<iana>"},
 *                                     first = next match strictly after now
 *
 * Aliases (`@daily`) are expanded to a 5-field cron before baking, and the
 * IANA zone (from `opts.tz`, else host-local) is baked in so the engine stays a
 * pure UTC evaluator (design D7). Rejects sub-floor spacing (`cadence_too_fast`,
 * < 60s — for both intervals and seconds-granular crons), ungrammatical input
 * (`bad_cadence`), and unknown zones (`unknown_zone`).
 */
export function parseCadence(every: string, opts: ParseOpts): CadenceResult {
  const received = every;
  const raw = every.trim();
  const nowMs = opts.now.getTime();

  // 1. fixed interval
  const durMs = parseDurationMs(raw);
  if (durMs !== null) {
    if (durMs < CADENCE_FLOOR_MS) {
      return cadenceError(
        'cadence_too_fast',
        `Interval too fast: minimum cadence is 60s. Use a longer --every (e.g. "1m", "5m", "1h").`,
        received,
      );
    }
    return {
      recur: JSON.stringify({ every: raw } satisfies Recur),
      firstFireAt: new Date(nowMs + durMs).toISOString(),
    };
  }

  // 2. calendar cron / alias
  const expanded = CRON_ALIASES[raw] ?? raw;
  const tz = opts.tz ?? hostZone();
  if (opts.tz !== undefined && !isValidZone(opts.tz)) {
    return cadenceError(
      'unknown_zone',
      `Unknown time zone: "${opts.tz}". Use an IANA name (e.g. "America/New_York").`,
      opts.tz,
    );
  }

  let interval: ReturnType<typeof CronExpressionParser.parse>;
  let firstFireAt: string;
  try {
    interval = CronExpressionParser.parse(expanded, { currentDate: opts.now, tz });
    firstFireAt = interval.next().toDate().toISOString();
  } catch {
    return cadenceError(
      'bad_cadence',
      `Could not parse cadence "${received}". Use a duration ("6h"), a 5-field cron ("0 9 * * *"), or an @alias ("@daily").`,
      received,
    );
  }

  // Cadence floor: a 5-field cron is always >=60s; only a seconds-granular cron
  // (multiple values in the seconds field) can resolve below the floor.
  const secField = interval.fields?.second as { values?: number[] } | undefined;
  const secValues = secField && Array.isArray(secField.values) ? secField.values : [0];
  if (secValues.length > 1) {
    return cadenceError(
      'cadence_too_fast',
      `Cron resolves below the 60s floor (sub-minute spacing). Use a cadence of at least one minute.`,
      received,
    );
  }

  return {
    recur: JSON.stringify({ cron: expanded, tz } satisfies Recur),
    firstFireAt,
  };
}

// ---------------------------------------------------------------------------
// cadenceDisplay — a recur JSON rendered for humans + agents
// ---------------------------------------------------------------------------

/**
 * Render a stored `recur` JSON as a compact, human-readable cadence:
 *   - {"every":"6h"}                         -> `every 6h`
 *   - {"cron":"0 9 * * *","tz":"America/…"}  -> ``cron `0 9 * * *` (America/…)``
 *   - null / undefined / unparseable         -> `none`
 *
 * The ONE cadence-display helper, shared by the `node wake` CLI surface
 * (list/guidance) and the <crtr-wake> wake-provenance block (bearings.ts), so
 * the cadence an agent reads in its wake block matches `crtr node wake list`
 * exactly. Cadence only — never an instance count.
 */
export function cadenceDisplay(recur: string | null | undefined): string {
  if (recur === null || recur === undefined) return 'none';
  try {
    const r = JSON.parse(recur) as { every?: string; cron?: string; tz?: string };
    if (typeof r.every === 'string') return `every ${r.every}`;
    if (typeof r.cron === 'string') {
      return `cron \`${r.cron}\`${typeof r.tz === 'string' ? ` (${r.tz})` : ''}`;
    }
  } catch {
    /* fall through */
  }
  return 'none';
}

// ---------------------------------------------------------------------------
// nextSlotAfter — the coalescing primitive (daemon advance)
// ---------------------------------------------------------------------------

/**
 * Earliest occurrence of `recur` strictly greater than `now`, as a UTC ISO
 * string. Anchors on `now` (not the stored `fire_at`), so it structurally
 * coalesces every slot missed while the daemon was down (design §5.3, AC-E2).
 * DST-correct because the IANA zone is baked into a calendar `recur`.
 *
 * parseCadence validates the cadence at arm time, so a throw here is a rare
 * backstop (a corrupted/foreign row) — T4 must quarantine such a row, never
 * re-query it each tick.
 */
export function nextSlotAfter(recur: string, now: Date): string {
  let parsed: Partial<Recur & { every: string; cron: string; tz: string }>;
  try {
    parsed = JSON.parse(recur);
  } catch {
    throw new Error(`nextSlotAfter: malformed recur JSON: ${recur}`);
  }

  if (typeof parsed.every === 'string') {
    const ms = parseDurationMs(parsed.every);
    if (ms === null || ms <= 0) {
      throw new Error(`nextSlotAfter: invalid interval recur: ${recur}`);
    }
    return new Date(now.getTime() + ms).toISOString();
  }

  if (typeof parsed.cron === 'string') {
    const tz = typeof parsed.tz === 'string' ? parsed.tz : 'UTC';
    const interval = CronExpressionParser.parse(parsed.cron, { currentDate: now, tz });
    return interval.next().toDate().toISOString(); // strictly after `now`
  }

  throw new Error(`nextSlotAfter: recur has neither 'every' nor 'cron': ${recur}`);
}
