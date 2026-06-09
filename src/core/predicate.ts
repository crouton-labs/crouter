/**
 * Predicate matcher engine — vendored verbatim from pi's frontmatter-rules
 * extension.
 *
 * Source: pi-personal-extensions/extensions/frontmatter-rules/index.ts
 *         (the "Condition language" block, functions `asArray` … `evalCondition`).
 *
 * The unified document substrate uses this to evaluate a document's `gate`
 * predicate against a node-config subject (e.g. `orchestration.depth: { gte: 2 }`).
 *
 * This is intentionally a COPY, not an import: the source lives in a separate,
 * private, unpublished repo that crtr cannot depend on. The functions are pure
 * TS over `unknown` / `Record<string, unknown>` with zero external imports, so
 * vendoring them keeps this module standalone and dependency-free. Keep it in
 * sync with the source by hand if the matcher language ever changes.
 *
 * Condition language (evaluated against the subject object):
 *   A condition is a map of <field> -> <matcher>, AND-ed across fields.
 *   `field` may be dotted to reach nested values (e.g. `orchestration.depth`).
 *
 *   Matcher forms:
 *     scalar (string/number/bool/null)
 *         field === value, OR (if the field is an array) the array includes value
 *     array  [a, b, c]
 *         membership/intersection: field is one of these, OR the field array
 *         shares any element with these
 *     object { <op>: <arg>, ... }   (multiple ops AND together)
 *         eq          equals (scalar or array-includes)
 *         ne          not eq
 *         in          [..] — field (or any of its array elements) is in the list
 *         nin         not in
 *         exists      true|false — field is present / absent
 *         contains    field array includes this value
 *         containsAll [..] — field array includes all of these
 *         containsAny [..] — field array includes any of these
 *         matches     regex string, case-sensitive (tests String(field); arrays: any)
 *         imatches    regex string, case-insensitive
 *         gt gte lt lte   numeric comparison
 *
 *   Combinators (reserved keys at any condition level):
 *     all: [ {..}, {..} ]   every sub-condition true (AND)
 *     any: [ {..}, {..} ]   at least one true (OR)
 *     not: { .. }           sub-condition false
 *   Sibling field matchers next to combinators are AND-ed in.
 *
 *   Two load-bearing edge cases preserved from the source:
 *     - An empty condition (`{}`) is INERT: it returns false, NOT match-all.
 *     - An unknown op never matches.
 */

export function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined) return [];
  return [v];
}

// Scalar equality with light, predictable coercion: exact match, or
// string/number cross-compare so `version: 2` matches a subject "2".
export function scalarEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (
    (typeof a === 'number' || typeof a === 'string') &&
    (typeof b === 'number' || typeof b === 'string')
  ) {
    return String(a) === String(b);
  }
  return false;
}

// Resolve a (possibly dotted) field path against the subject object.
export function getField(subject: unknown, key: string): unknown {
  if (subject && typeof subject === 'object' && key in (subject as Record<string, unknown>)) {
    return (subject as Record<string, unknown>)[key];
  }
  if (!key.includes('.')) return undefined;
  let cur: unknown = subject;
  for (const part of key.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function toRegExp(arg: unknown, flags: string): RegExp | null {
  if (typeof arg !== 'string') return null;
  try {
    return new RegExp(arg, flags);
  } catch {
    return null;
  }
}

export function applyOp(op: string, value: unknown, arg: unknown): boolean {
  const vals = asArray(value);
  switch (op) {
    case 'eq':
      return Array.isArray(value) ? value.some((v) => scalarEq(v, arg)) : scalarEq(value, arg);
    case 'ne':
      return !applyOp('eq', value, arg);
    case 'in':
      return asArray(arg).some((a) => vals.some((v) => scalarEq(v, a)));
    case 'nin':
      return !applyOp('in', value, arg);
    case 'exists':
      return (value !== undefined) === (arg !== false);
    case 'contains':
      return vals.some((v) => scalarEq(v, arg));
    case 'containsAll':
      return asArray(arg).every((a) => vals.some((v) => scalarEq(v, a)));
    case 'containsAny':
      return asArray(arg).some((a) => vals.some((v) => scalarEq(v, a)));
    case 'matches':
    case 'imatches': {
      const re = toRegExp(arg, op === 'imatches' ? 'i' : '');
      if (!re) return false;
      return vals.some((v) => (typeof v === 'string' || typeof v === 'number' ? re.test(String(v)) : false));
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const n = Number(value);
      const t = Number(arg);
      if (Number.isNaN(n) || Number.isNaN(t)) return false;
      if (op === 'gt') return n > t;
      if (op === 'gte') return n >= t;
      if (op === 'lt') return n < t;
      return n <= t;
    }
    default:
      return false; // unknown op never matches
  }
}

export function matchField(value: unknown, matcher: unknown): boolean {
  if (matcher === null || ['string', 'number', 'boolean'].includes(typeof matcher)) {
    if (Array.isArray(value)) return value.some((v) => scalarEq(v, matcher));
    return scalarEq(value, matcher);
  }
  if (Array.isArray(matcher)) {
    const vals = asArray(value);
    return matcher.some((m) => vals.some((v) => scalarEq(v, m)));
  }
  if (matcher && typeof matcher === 'object') {
    return Object.entries(matcher as Record<string, unknown>).every(([op, arg]) =>
      applyOp(op, value, arg),
    );
  }
  return false;
}

/**
 * Evaluate a `gate` predicate against a subject object.
 *
 * This is the one function consumers call. Returns true iff `condition`
 * matches `subject`. A null/non-object condition and an empty object both
 * return false (inert), never match-all.
 */
export function evalCondition(condition: unknown, subject: Record<string, unknown>): boolean {
  if (condition == null) return false;
  if (Array.isArray(condition)) return condition.every((sub) => evalCondition(sub, subject));
  if (typeof condition !== 'object') return false;
  const c = condition as Record<string, unknown>;
  const hasCombinator = 'all' in c || 'any' in c || 'not' in c;
  if (hasCombinator) {
    let ok = true;
    if ('all' in c) ok = ok && asArray(c.all).every((s) => evalCondition(s, subject));
    if ('any' in c) ok = ok && asArray(c.any).some((s) => evalCondition(s, subject));
    if ('not' in c) ok = ok && !evalCondition(c.not, subject);
    for (const k of Object.keys(c)) {
      if (k === 'all' || k === 'any' || k === 'not') continue;
      ok = ok && matchField(getField(subject, k), c[k]);
    }
    return ok;
  }
  const keys = Object.keys(c);
  if (keys.length === 0) return false; // empty condition is inert, not match-all
  return keys.every((k) => matchField(getField(subject, k), c[k]));
}
