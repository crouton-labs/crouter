import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { findProjectScopeRoot, resetScopeCache, userScopeRoot } from './scope.js';
import { ensureDir, pathExists, readText, removePath, nowIso } from './fs-utils.js';
import { readConfig, readState, updateConfig, updateState, ensureScopeInitialized } from './config.js';
import { clone } from './git.js';
import { readMarketplaceManifest } from './manifest.js';
import { collectSlashSpecs } from './command.js';
import type { RootDef, SlashSpec } from './command.js';
import { CRTR_DIR_NAME } from '../types.js';

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
description: 'Author, list, search, and load crtr memory documents (skills, references, preferences) via the crtr CLI. These are durable agent memory — markdown future LLM sessions load on demand. Use when the user wants to remember/save knowledge, build a context primer, or recall a previously saved doc. Triggers: "save", "remember", "build context for", "what skills do we have", "skill for X".'
argument-hint: [topic or verb]
---

${BOOT_SKILL_MARKER}

# /crtr-skills — crtr memory router

crtr memory documents = durable agent memory (kind: skill, reference, or
preference). Written for **future LLM sessions**, not the user. \`crtr memory\`
is the surface — author, discover, and load them.

## Route by intent

- **Capture** ("save", "remember", "build context for", "make a skill"):
  \`crtr memory write <name> --kind <skill|reference|preference>\` with the
  body piped on stdin — e.g.
  \`crtr memory write $ARGUMENTS --kind skill <<'EOF' … EOF\`. Run
  \`crtr memory write -h\` for the full frontmatter schema (--when, --why,
  --short-form, --scope, visibility rungs), then \`crtr memory lint\` to
  validate what you wrote.
- **Find** ("what do we have on X"): \`crtr memory find "$ARGUMENTS"\` →
  \`crtr memory read <name>\` on the best hit (add --body/--grep to search
  bodies).
- **Load by name**: \`crtr memory read <name>\`.
- **List all**: \`crtr memory list\`.

If \`$ARGUMENTS\` is empty, ask the user what they want before running.

## Rules

- CLI stdout is the prompt — act on it, don't paraphrase to the user.
- Append \`-h\` at any leaf (\`crtr memory write -h\`) for its full schema
  before authoring.
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

// ---------------------------------------------------------------------------
// Slash commands (editor prompt templates) auto-installed for opted-in nodes.
//
// Any command that declares a `slash` SlashSpec is rendered to a markdown
// template and dropped into the host's command dirs on each crtr run — pi reads
// `~/.pi/agent/prompts/<name>.md`, Claude Code reads `~/.claude/commands/<name>.md`,
// so `/name` becomes available. Marker-guarded (never clobbers a user-edited
// file) and version-rolled like the boot skill. Kill switch: CRTR_NO_MODE_CMDS=1.
// ---------------------------------------------------------------------------

const SLASH_CMD_MARKER = '<!-- crtr-mode-cmd v1 -->';
const SLASH_CMD_MARKER_PREFIX = '<!-- crtr-mode-cmd v';

/** Render a SlashSpec to a full template file (frontmatter + marker + body). */
function renderSlashTemplate(spec: SlashSpec): string {
  const hint = spec.argumentHint !== undefined
    ? `argument-hint: ${JSON.stringify(spec.argumentHint)}\n`
    : '';
  return `---\ndescription: ${spec.description}\n${hint}---\n\n${SLASH_CMD_MARKER}\n\n${spec.body}\n`;
}

/** Write `content` to `file` unless a user-customized file is already there.
 *  Rolls forward our own (marker-bearing) versions; skips if identical. */
function writeSlashFileIfOurs(dir: string, name: string, content: string): void {
  const file = join(dir, `${name}.md`);
  if (pathExists(file)) {
    const existing = readText(file);
    if (!existing.includes(SLASH_CMD_MARKER_PREFIX)) return; // user's own file
    if (existing === content) return; // already current
  }
  ensureDir(dir);
  writeFileSync(file, content, 'utf8');
}

export function ensureSlashCommands(root: RootDef, argv: string[]): void {
  try {
    if (process.env.CRTR_NO_MODE_CMDS === '1') return;
    if (shouldSkipForArgv(argv)) return;

    const specs = collectSlashSpecs(root);
    if (specs.length === 0) return;

    // Target each host's command dir, but only when that host is actually in use
    // (its root dir exists). We never create ~/.pi or ~/.claude ourselves.
    const targets: string[] = [];
    if (pathExists(join(homedir(), '.pi', 'agent'))) {
      targets.push(join(homedir(), '.pi', 'agent', 'prompts'));
    }
    if (pathExists(join(homedir(), '.claude'))) {
      targets.push(join(homedir(), '.claude', 'commands'));
    }
    if (targets.length === 0) return;

    for (const spec of specs) {
      const content = renderSlashTemplate(spec);
      for (const dir of targets) writeSlashFileIfOurs(dir, spec.name, content);
    }
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: slash-command error: ${msg}\n`);
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

export function ensureProjectScope(argv: string[]): void {
  try {
    if (process.env.CRTR_NO_AUTO_INIT === '1') return;
    if (shouldSkipForArgv(argv)) return;

    // Already inside a project scope (here or in an ancestor) — nothing to do.
    if (findProjectScopeRoot() !== null) return;

    const cwd = process.cwd();

    // Never auto-init at $HOME — that path is reserved for the user scope.
    if (cwd === homedir()) return;

    const projectRoot = join(cwd, CRTR_DIR_NAME);
    if (projectRoot === userScopeRoot()) return;

    ensureScopeInitialized('project', projectRoot);
    resetScopeCache();
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: project-init error: ${msg}\n`);
    }
  }
}
