// `crtr sys sync` — the SOLE entry point for bidirectional crtr ↔ Claude skill
// sync (R-U1). Loads the layered manifest (P2), reconciles each enrolled pair
// once via the direction-agnostic engine (P6), summarizes the outcome, and
// sets the exit code: non-zero IFF any pair conflicted (R-E7). A malformed
// manifest (R-U7) or an unknown `--pair` id (OD-3) aborts hard before any
// reconcile runs — no lenient fallback, no partial write.

import { defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import { emit, isJsonOutput } from '../../core/io.js';
import { ExitCode } from '../../types.js';
import { readLayeredManifest } from '../../core/skill-sync/manifest.js';
import { resolveProfile } from '../../core/skill-sync/profile.js';
import { reconcilePair, type PairResult } from '../../core/skill-sync/engine.js';

/** The R-E8 summary partition: every visited pair lands in exactly one of
 *  synced/conflicts/noop, and `wrote` totals endpoint files written. */
interface SyncSummary {
  synced: string[];
  conflicts: string[];
  noop: string[];
  wrote: number;
}

/** Render the per-pair status table + summary line as agent-ready markdown.
 *  Shown for both the clean and the conflict exit so the caller always sees the
 *  full partition. */
function renderSync(results: PairResult[], summary: SyncSummary, dryRun: boolean): string {
  const parts: string[] = [];
  parts.push(
    dryRun
      ? 'crtr ↔ Claude skill sync — DRY RUN (nothing written):'
      : 'crtr ↔ Claude skill sync:',
  );

  if (results.length === 0) {
    parts.push('No enrolled pairs.');
  } else {
    const rows = results
      .map((r) => `| ${r.id} | ${r.status} | ${r.wrote} |`)
      .join('\n');
    parts.push(`| pair | status | wrote |\n| --- | --- | --- |\n${rows}`);
  }

  parts.push(
    `synced: ${summary.synced.length} · conflicts: ${summary.conflicts.length} · ` +
      `noop: ${summary.noop.length} · files written: ${summary.wrote}`,
  );

  if (summary.conflicts.length > 0) {
    parts.push(
      `Conflicts (NOT written): ${summary.conflicts.join(', ')}. ` +
        'Each conflicting pair has a git-style report under ' +
        '`~/.crouter/skill-sync/conflicts/<id>.md` — resolve the endpoints by hand, then re-run.',
    );
  }

  return parts.join('\n\n');
}

export const sysSyncLeaf = defineLeaf({
  name: 'sync',
  description: 'reconcile crtr ↔ Claude skill pairs (bidirectional)',
  whenToUse:
    'you want enrolled crtr skills and their Claude SKILL.md counterparts brought back into agreement. Performs the single, direction-agnostic 3-way reconcile over every pair in the skill-sync manifest (or just one via --pair), writing both sides + the merge base when clean and a conflict report when not.',
  help: {
    name: 'sys sync',
    summary: 'reconcile enrolled crtr ↔ Claude skill pairs (bidirectional 3-way merge)',
    params: [
      {
        kind: 'flag',
        name: 'pair',
        type: 'string',
        required: false,
        constraint: 'Reconcile only the pair with this id. Unknown id → hard error naming it + the valid ids, nothing written. Default: every enrolled pair.',
      },
      {
        kind: 'flag',
        name: 'dry-run',
        type: 'bool',
        required: false,
        constraint: 'Compute every merge and report the would-be status, but write nothing — no endpoint, snapshot, or conflict report touched.',
      },
    ],
    output: [
      { name: 'synced', type: 'string[]', required: true, constraint: 'Pair ids written through cleanly to both endpoints + the merge base.' },
      { name: 'conflicts', type: 'string[]', required: true, constraint: 'Pair ids that diverged and were NOT written; each has a report under ~/.crouter/skill-sync/conflicts/<id>.md. Non-empty → exit non-zero.' },
      { name: 'noop', type: 'string[]', required: true, constraint: 'Pair ids already in agreement — nothing to do.' },
      { name: 'wrote', type: 'number', required: true, constraint: 'Total endpoint files created/updated across all pairs (0 under --dry-run).' },
    ],
    outputKind: 'object',
    effects: [
      'For each clean pair: writes the merged SKILL.md + assets to BOTH the crtr and Claude endpoints and updates the per-pair merge snapshot under ~/.crouter/skill-sync/snapshots/<id>/.',
      'For each conflicting pair: writes NOTHING to the endpoints; writes a git-style conflict report to ~/.crouter/skill-sync/conflicts/<id>.md.',
      'Exits non-zero iff any pair conflicted. A malformed manifest or an unknown --pair id aborts hard (non-zero) before any reconcile and writes nothing.',
      'With --dry-run: read-only — computes every merge and the would-be summary, touches no endpoint, snapshot, or report.',
    ],
  },
  run: async (input) => {
    const pairFilter = input['pair'] as string | undefined;
    const dryRun = (input['dryRun'] as boolean) ?? false;

    // Malformed manifest throws here (R-U7) → dispatcher's handle() → non-zero.
    const { pairs } = readLayeredManifest();

    let selected = pairs;
    if (pairFilter !== undefined) {
      selected = pairs.filter((p) => p.id === pairFilter);
      if (selected.length === 0) {
        // OD-3 / R-O2 — unknown id aborts hard, naming the bad id + valid ids,
        // nothing written.
        const valid = pairs.map((p) => p.id);
        throw usage(`unknown pair id: ${pairFilter}`, {
          received: pairFilter,
          next: `Valid pair ids: ${valid.length > 0 ? valid.join(', ') : '(none)'}. Run \`crtr sys sync -h\`.`,
        });
      }
    }

    // One conflict must NOT abort the loop (R-X3): collect every pair's result,
    // partition, then decide the exit code once. A structural error (an
    // unresolvable endpoint, both sides missing) is a hard config fault and is
    // allowed to propagate — only content conflicts are a collected outcome.
    const results: PairResult[] = [];
    for (const pair of selected) {
      const profile = resolveProfile(pair.frontmatter);
      results.push(reconcilePair(pair, profile, { dryRun }));
    }

    const summary: SyncSummary = {
      synced: results.filter((r) => r.status === 'synced').map((r) => r.id),
      conflicts: results.filter((r) => r.status === 'conflict').map((r) => r.id),
      noop: results.filter((r) => r.status === 'noop').map((r) => r.id),
      wrote: results.reduce((n, r) => n + r.wrote, 0),
    };

    if (isJsonOutput()) {
      emit(summary as unknown as Record<string, unknown>);
    } else {
      process.stdout.write(renderSync(results, summary, dryRun) + '\n');
    }

    // R-E7 — exit non-zero IFF a conflict was surfaced.
    process.exit(summary.conflicts.length > 0 ? ExitCode.GENERAL : ExitCode.SUCCESS);
  },
});
