---
name: crouter-development/plugins
type: playbook
description: How to author a crtr plugin — plugin.json manifest, directory layout, scopes, install mechanics, versioning. Use when creating a new plugin, packaging skills for distribution, or debugging install/resolution.
keywords: [plugin, plugin.json, manifest, install, scope]
---

# Authoring crtr plugins

A **plugin** is a directory shipping skills (and, in future, other artifact types like commands and hooks). Plugins are how you package skills for sharing across machines, projects, and people.

Audience: LLM agents creating or maintaining a crtr plugin.

## When you need a plugin (vs scope-owned skills)

Scope-owned skills live at `~/.crouter/skills/` (user) or `<project>/.crouter/skills/` (project). They're personal and per-machine/per-repo.

Reach for a **plugin** when:
- You want to share skills across multiple projects or with other people.
- You want versioning + update mechanics (`echo '{"name":"<name>"}' | crtr pkg plugin manage update`).
- You want a marketplace to index the work — see [[crouter-development/marketplaces]].

If it's a one-off note for yourself, scope-owned skills are simpler. Promote to a plugin later.

## Directory layout

```
<plugin-name>/
├── .crouter-plugin/
│   └── plugin.json                  # manifest — required
└── skills/
    └── <skill-name>/
        └── SKILL.md
```

The `<plugin-name>` directory IS the plugin. The manifest's `name` field must match the directory name (install renames if needed). Future artifact types (`commands/`, `hooks/`, etc.) will be sibling dirs to `skills/`.

## The manifest

`.crouter-plugin/plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "One sentence — shown in `echo '{}' | crtr pkg plugin inspect list`.",
  "source": "https://github.com/<owner>/<repo>",
  "owner": {
    "name": "Your Name",
    "email": "you@example.com"
  }
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Must match the directory name. Lowercase kebab. |
| `version` | yes | Semver. Marketplace CI may bump automatically — see marketplaces skill. |
| `description` | yes | One sentence. |
| `source` | recommended | Git URL where the plugin lives. Used by `echo '{"name":"<name>"}' | crtr pkg plugin manage update`. |
| `owner` | optional | Author info. |

## Scopes

A plugin can live in either scope:

| Scope | Path | Use case |
|---|---|---|
| user | `~/.crouter/plugins/<name>/` | Personal, available in all your projects |
| project | `<project>/.crouter/plugins/<name>/` | Pinned to a specific repo — checked in or vendored |

Project-scope plugins outrank user-scope on resolution. Both outrank marketplace-installed plugins. The builtin `crtr` plugin (ships with the CLI) sits at the bottom.

## Install mechanics

Three ways a plugin lands in a scope:

1. **From a git URL** (`echo '{"source":"<url>","scope":"user"}' | crtr pkg plugin manage install`):
   - Clones into `<scope>/plugins/<name>/` using the manifest's name.
   - `echo '{"name":"<name>"}' | crtr pkg plugin manage update` does `git pull`.
   - Independent of any marketplace.

2. **From a marketplace** (`echo '{"marketplace":"<mkt>","plugin":"<name>"}' | crtr pkg market manage install`):
   - **Symlinks** the marketplace's `plugins/<name>/` into `<scope>/plugins/<name>/`.
   - `echo '{"marketplace":"<mkt>"}' | crtr pkg market manage update` pulls updates for every installed plugin from that marketplace.
   - See [[crouter-development/marketplaces]].

3. **Authored in place** (you're writing the plugin in a working repo):
   - Symlink for tight dev loop: `ln -s $(pwd) ~/.crouter/plugins/<name>`.
   - Or `echo '{"source":"file://$(pwd)","scope":"project"}' | crtr pkg plugin manage install` to clone-install.

## Local development loop

```bash
# Scaffold dir + manifest + first skill
mkdir -p my-plugin/.crouter-plugin my-plugin/skills
$EDITOR my-plugin/.crouter-plugin/plugin.json      # write the manifest
cd my-plugin
echo '{"qualifier":"my-plugin:my-first-skill","type":"playbook","description":"Use when …"}' | crtr skill author scaffold

# Symlink for fast iteration — no clone, edits land immediately
ln -s $(pwd) ~/.crouter/plugins/my-plugin

# Verify
echo '{}' | crtr pkg plugin inspect list           # my-plugin appears
echo '{"name":"my-plugin"}' | crtr pkg plugin inspect show   # lists its skills
echo '{"plugin":"my-plugin"}' | crtr skill find list  # just my-plugin's skills
echo '{}' | crtr sys doctor                        # validates manifest + every skill
```

When ready to share: push to a git remote; anyone can `echo '{"source":"<url>","scope":"user"}' | crtr pkg plugin manage install`.

## Versioning

Standard semver:

| Change | Bump |
|---|---|
| Typo, wording polish | patch (0.1.0 → 0.1.1) |
| New skill, new section, new example | minor (0.1.0 → 0.2.0) |
| Removed skill, renamed skill, changed manifest schema | major (0.1.0 → 1.0.0) |

`echo '{"name":"<name>"}' | crtr pkg plugin manage update` reads the new version after pulling and updates the local config. Plugins published through a marketplace may have their `version` field bumped automatically by CI — see [[crouter-development/marketplaces]].

## Enable/disable

`echo '{"name":"<name>"}' | crtr pkg plugin manage disable` flips the per-scope config without removing files. Disabled plugins are hidden from `echo '{}' | crtr skill find list` and don't resolve via `echo '{"name":"<name>"}' | crtr skill read show`. Re-enable with `echo '{"name":"<name>"}' | crtr pkg plugin manage enable`.

Individual skills inside an enabled plugin can also be disabled: `echo '{"name":"<plugin>:<skill>"}' | crtr skill state disable`.

## What goes in a plugin

Good plugin scope:
- A coherent set of related skills (3–15 typical) sharing a theme.
- All skills serve the same user persona or workflow.
- Versioned together — a bump means a bump for the whole set.

Bad plugin scope:
- One mega-plugin with every skill you've ever written. Hard to install selectively, hard to version.
- A plugin per single skill. No value-add over scope-owned skills.

## Cross-plugin etiquette

If your skill conceptually depends on another plugin's skill, link via `## Related` with `` `<plugin>/<skill>` ``. Don't fork content; link it.

## Validation

`echo '{}' | crtr sys doctor` checks every plugin:
- Manifest exists and is valid JSON.
- Manifest `name` matches the directory name.
- Every skill under `skills/` passes the skill-validation contract (frontmatter parses, `name` matches dir path, `type` in enum). Run `echo '{}' | crtr skill author guide` for the authoring workflow + SKILL.md format reference.
- Sibling artifact dirs (`commands/`, `hooks/`, etc.) — validated by their respective specs as those land.

## Cross-publishing with Claude Code

Some plugins also publish a `.claude-plugin/` manifest alongside `.crouter-plugin/` so they can be loaded directly into Claude Code without going through crtr. Optional. Only worth doing when your skills/commands meaningfully stand alone in the Claude Code surface. Keep manifests in sync if you do.
