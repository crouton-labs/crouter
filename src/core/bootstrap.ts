import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { userScopeRoot } from './scope.js';
import { ensureDir, pathExists, readText, removePath, nowIso } from './fs-utils.js';
import { readConfig, readState, updateConfig, updateState, ensureScopeInitialized } from './config.js';
import { clone } from './git.js';
import { readMarketplaceManifest } from './manifest.js';

export const OFFICIAL_MARKETPLACE_NAME = 'crouter-official-marketplace';
export const OFFICIAL_MARKETPLACE_URL =
  'https://github.com/crouton-labs/crouter-official-marketplace.git';
export const OFFICIAL_MARKETPLACE_REF = 'main';

const SKIP_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
]);

function shouldSkipForArgv(argv: string[]): boolean {
  const sub = argv[2];
  if (sub === undefined) return true;
  return SKIP_SUBCOMMANDS.has(sub);
}

const BOOT_SKILL_NAME = 'crtr-skills';
const BOOT_SKILL_MARKER = '<!-- crtr-boot-skill v2 -->';
const BOOT_SKILL_MARKER_PREFIX = '<!-- crtr-boot-skill v';

function bootSkillBody(): string {
  return `---
name: crtr-skills
description: Capture, list, search, and load skills via the crtr CLI. Skills are durable agent memory — markdown future LLM sessions load on demand. Use when the user wants to remember/save knowledge, build a context primer, or recall a previously saved skill. Triggers: "save", "remember", "build context for", "what skills do we have", "skill for X".
argument-hint: [topic or verb]
---

${BOOT_SKILL_MARKER}

# /crtr-skills — skill router

Skills = durable agent memory. Written for **future LLM sessions**, not the
user. \`crtr skill\` is the index — discoverable via list/search/grep.

## Route by intent

- **Capture** ("save", "remember", "build context for", "make a skill"):
  \`crtr skill create $ARGUMENTS\` → pick template (primer/playbook/freeform)
  → \`crtr skill template <type> $ARGUMENTS\` for the full workflow. Follow it
  directly.
- **Find** ("what do we have on X"): \`crtr skill search "$ARGUMENTS"\` →
  \`crtr skill show <name>\` on the best hit.
- **Load by name**: \`crtr skill show <name>\`.
- **List all**: \`crtr skill list\`.
- **Anything else**: \`crtr skill\` (no args) prints the full workflow guide.

If \`$ARGUMENTS\` is empty, ask the user what they want before running.

## Rules

- CLI stdout is the prompt — act on it, don't paraphrase to the user.
- Don't load \`create\` and \`template\` outputs in the same turn (progressive
  disclosure). \`create\` decides type; \`template\` returns the workflow.
- If \`crtr\` is not on PATH, tell the user and stop.
`;
}

export function ensureBootSkill(argv: string[]): void {
  try {
    if (process.env.CRTR_NO_BOOT_SKILL === '1') return;
    if (shouldSkipForArgv(argv)) return;

    const claudeSkillsRoot = join(homedir(), '.claude', 'skills');
    // Only install if the user actually uses Claude Code (the dir exists or is
    // creatable). We won't create ~/.claude itself; that's not our directory.
    if (!pathExists(join(homedir(), '.claude'))) return;

    const skillDir = join(claudeSkillsRoot, BOOT_SKILL_NAME);
    const skillFile = join(skillDir, 'SKILL.md');

    if (pathExists(skillFile)) {
      const existing = readText(skillFile);
      // If the user customized (no boot-skill marker at all), don't clobber.
      if (!existing.includes(BOOT_SKILL_MARKER_PREFIX)) return;
      // Any marker version present → roll forward to current. Skip if identical.
      if (existing === bootSkillBody()) return;
    }

    ensureDir(skillDir);
    writeFileSync(skillFile, bootSkillBody(), 'utf8');
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: boot-skill error: ${msg}\n`);
    }
  }
}

export function ensureOfficialMarketplace(argv: string[]): void {
  try {
    if (process.env.CRTR_NO_BOOTSTRAP === '1') return;
    if (shouldSkipForArgv(argv)) return;

    const state = readState('user');
    if (state.bootstrap_done === true) return;

    const cfg = readConfig('user');
    if (cfg.marketplaces[OFFICIAL_MARKETPLACE_NAME] !== undefined) {
      updateState('user', (s) => {
        s.bootstrap_done = true;
      });
      return;
    }

    const root = userScopeRoot();
    ensureScopeInitialized('user', root);

    const mktsDir = join(root, 'marketplaces');
    ensureDir(mktsDir);
    const dest = join(mktsDir, OFFICIAL_MARKETPLACE_NAME);

    if (pathExists(dest)) {
      removePath(dest);
    }

    clone(OFFICIAL_MARKETPLACE_URL, dest, { depth: 1, ref: OFFICIAL_MARKETPLACE_REF });

    const manifest = readMarketplaceManifest(dest);
    if (manifest === null) {
      removePath(dest);
      return;
    }

    updateConfig('user', (c) => {
      c.marketplaces[OFFICIAL_MARKETPLACE_NAME] = {
        url: OFFICIAL_MARKETPLACE_URL,
        ref: OFFICIAL_MARKETPLACE_REF,
        installed_at: nowIso(),
      };
    });

    updateState('user', (s) => {
      s.bootstrap_done = true;
    });
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: bootstrap error: ${msg}\n`);
    }
  }
}
