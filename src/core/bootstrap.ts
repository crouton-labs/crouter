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
const BOOT_SKILL_MARKER = '<!-- crtr-boot-skill v1 -->';

function bootSkillBody(): string {
  return `---
name: crtr-skills
description: Capture, list, search, and load skills via the crtr CLI. Use when the user wants to remember something, save knowledge, build a context primer, or recall a previously saved skill. Triggers: "save", "remember", "build context for", "what skills do we have", "skill for X".
argument-hint: [topic or verb]
---

${BOOT_SKILL_MARKER}

# /crtr:skills — the skill router

\`crtr\` is the source of truth for skills on this machine. Every skill the
agent should know about is discoverable via \`crtr skill\`. This file is a
thin router; the CLI is the index.

## What the user is asking for

- **Capture new knowledge** ("save this", "remember", "build context for X",
  "make a skill that…"): run \`crtr skill create $ARGUMENTS\` and follow the
  walkthrough it prints. It picks a template (primer/preference/runbook/
  glossary/decision/freeform) and walks you through scoping, researching,
  and scaffolding.
- **Find a relevant skill** ("what do we have on X"): run
  \`crtr skill search "$ARGUMENTS"\` and load the best hit with
  \`crtr skill show <name>\`.
- **Load a known skill by name**: run \`crtr skill show <name>\`.
- **List everything**: run \`crtr skill list\`.
- **Anything else skill-related**: run \`crtr skill\` (no args) — it prints
  the full skill workflow guide. Follow it.

\`$ARGUMENTS\` is the user's request as a string. Use it to seed the topic for
\`create\` or the query for \`search\`. If it's empty, ask the user what they
want before running anything.

## Output rules

The CLI's stdout is the prompt. Read it, then act on it. Don't paraphrase the
guidance back at the user — just do the work it describes.

If \`crtr\` isn't on PATH, tell the user and stop. This skill assumes
\`@crouton-kit/crouter\` is installed globally.
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
      // Idempotent: only rewrite if it's still our marker version.
      const existing = readText(skillFile);
      if (!existing.includes(BOOT_SKILL_MARKER)) return;
      // Same marker — check if body needs update, otherwise skip.
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
