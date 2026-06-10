// `crtr memory lint` — the permanent valid-YAML gate over the bounded corpus
// (the CTO green-checkpoint: zero frontmatter parse errors at authoring time,
// so an invalid doc fails HERE instead of being silently isolated at runtime).
// Bounded corpus = the substrate memory dirs (project/user/builtin). Never a
// filesystem-wide scan.

import { basename, relative, sep } from 'node:path';
import { defineLeaf } from '../../core/command.js';
import { general } from '../../core/errors.js';
import { warn } from '../../core/output.js';
import { pathExists, readText, walkFiles } from '../../core/fs-utils.js';
import { parseFrontmatterGeneric } from '../../core/frontmatter.js';
import { listInstalledPlugins } from '../../core/resolver.js';
import { pluginMemoryDir, scopeMemoryDir } from '../../core/scope.js';
import { isDocKind, RUNGS } from '../../core/substrate/index.js';
import type { Scope } from '../../types.js';

interface LintFinding {
  path: string;
  error: string;
}

/** The parser normalizes the `always` alias to `content`, so it lints valid. */
const VALID_RUNGS: readonly string[] = [...RUNGS, 'always'];
const RUNG_FIELDS = ['system-prompt-visibility', 'file-read-visibility'] as const;

/** Schema checks for a doc living in a substrate memory dir: a memory store
 *  holds ONLY substrate docs, so a missing/invalid `kind` is an authoring
 *  error here (elsewhere it just means "not a substrate doc"). Rung and gate
 *  values are checked RAW — the runtime parser silently falls back to kind
 *  defaults / inert gates, which is exactly the silent tolerance this lint
 *  exists to catch at authoring time. */
export function lintSubstrateSchema(fm: Record<string, unknown> | null): string | null {
  if (fm === null) return 'missing frontmatter: a memory store doc requires `kind: skill|reference|preference`';
  if (!isDocKind(fm.kind)) {
    return `invalid kind: ${JSON.stringify(fm.kind)} (expected skill|reference|preference)`;
  }
  // The retired `when`/`why` pair was merged into one read-routing field. The
  // hard cut is enforced HERE: an old-shape doc must fail, never be silently
  // read at runtime.
  if ('when' in fm || 'why' in fm) {
    return 'retired `when`/`why` keys: merge them into one `when-and-why-to-read` line — "When <circumstance>, this <kind> should be read <because <payoff>>."';
  }
  if (typeof fm['when-and-why-to-read'] !== 'string' || fm['when-and-why-to-read'].trim() === '') {
    return 'missing `when-and-why-to-read`: one read-routing line — "When <circumstance>, this <kind> should be read <because <payoff>>."';
  }
  for (const field of RUNG_FIELDS) {
    const v = fm[field];
    if (v !== undefined && (typeof v !== 'string' || !VALID_RUNGS.includes(v))) {
      return `invalid ${field}: ${JSON.stringify(v)} (expected ${RUNGS.join('|')})`;
    }
  }
  const gate = fm.gate;
  if (gate !== undefined && (gate === null || typeof gate !== 'object' || Array.isArray(gate))) {
    return `invalid gate: ${JSON.stringify(gate)} (expected a field→matcher object)`;
  }
  const appliesTo = fm['applies-to'];
  if (
    appliesTo !== undefined &&
    typeof appliesTo !== 'string' &&
    !(Array.isArray(appliesTo) && appliesTo.every((g) => typeof g === 'string'))
  ) {
    return `invalid applies-to: ${JSON.stringify(appliesTo)} (expected a glob or glob list)`;
  }
  return null;
}

/** Strict-parse one file; push a finding on a YAML error, then run the
 *  schema check when the file lives in a substrate store. */
function lintFile(file: string, substrateStore: boolean, findings: LintFinding[]): void {
  let fm: Record<string, unknown> | null;
  try {
    fm = parseFrontmatterGeneric(readText(file)).data;
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).split('\n')[0];
    findings.push({ path: file, error: `invalid YAML frontmatter: ${msg}` });
    return;
  }
  if (!substrateStore) return;
  const schemaError = lintSubstrateSchema(fm);
  if (schemaError !== null) findings.push({ path: file, error: schemaError });
}

export const lintLeaf = defineLeaf({
  name: 'lint',
  description: 'validate frontmatter across the whole bounded document corpus',
  whenToUse:
    'you authored or migrated documents and want the authoring-time gate: strict-parse every doc in the bounded corpus (the substrate memory stores) and fail loudly on any invalid YAML or substrate schema violation. Run it before shipping doc changes; CI-friendly (non-zero exit on any finding).',
  help: {
    name: 'memory lint',
    summary: 'strict-parse frontmatter across the bounded corpus; non-zero exit on any finding',
    params: [],
    output: [
      { name: 'checked', type: 'number', required: true, constraint: 'Files linted across all corpora.' },
      { name: 'corpora', type: 'object', required: true, constraint: 'Per-corpus file counts: {memory_stores}.' },
      { name: 'findings', type: 'object[]', required: true, constraint: 'One row per failure: {path, error}. Empty when green.' },
    ],
    outputKind: 'object',
    effects: ['None. Read-only. Exits non-zero when any finding exists.'],
  },
  run: async () => {
    const findings: LintFinding[] = [];
    let memoryCount = 0;

    // Substrate memory stores (project/user/builtin), schema-aware. A scope's
    // corpus is its NATIVE memory dir plus each enabled plugin's memory dir —
    // plugin docs are substrate docs and lint through the same schema gate.
    //    MEMORY.md index files are not substrate docs — YAML-parse only.
    const lintDir = (dir: string | null): void => {
      if (!dir || !pathExists(dir)) return;
      for (const file of walkFiles(dir, (n) => n.endsWith('.md'))) {
        if (!relative(dir, file).split(sep).join('/')) continue;
        memoryCount += 1;
        lintFile(file, basename(file) !== 'MEMORY.md', findings);
      }
    };
    for (const scope of ['project', 'user', 'builtin'] as Scope[]) {
      lintDir(scopeMemoryDir(scope));
      for (const plugin of listInstalledPlugins(scope)) {
        if (plugin.enabled) lintDir(pluginMemoryDir(plugin));
      }
    }

    const checked = memoryCount;
    if (findings.length > 0) {
      // Human/agent path renders only the message — surface every offender as
      // a scoped stderr notice (the --json path carries them in details too).
      for (const f of findings) warn(`memory lint: ${f.path}: ${f.error}`);
      throw general(`memory lint: ${findings.length} finding(s) across ${checked} files`, {
        checked,
        findings: findings.map((f) => ({ path: f.path, error: f.error })),
        next: 'Fix each doc (quote YAML values containing `: `; use a valid kind/rung/gate), then re-run `crtr memory lint`.',
      });
    }
    return {
      checked,
      corpora: { memory_stores: memoryCount },
      findings: [],
      follow_up: 'Corpus green — zero invalid frontmatter docs.',
    };
  },
});
