---
kind: knowledge
when-and-why-to-read: When creating a crtr plugin, packaging skills for
  distribution, or debugging install/resolution, this skill should be read.
short-form: How to author a crtr plugin — plugin.json manifest, directory
  layout, scopes, install mechanics, versioning. Use when creating a new plugin,
  packaging skills for distribution, or debugging install/resolution.
system-prompt-visibility: name
file-read-visibility: none
---

# Authoring crtr plugins

A **plugin** is a directory shipping substrate docs (knowledge and preferences) and other artifact types like `rules/` and `agents/`. Plugins are how you package that content for sharing across machines, projects, and people.

Audience: LLM agents creating or maintaining a crtr plugin.

## When you need a plugin (vs scope-owned skills)

Scope-owned docs live at `~/.crouter/memory/` (user) or `<project>/.crouter/memory/` (project). They're personal and per-machine/per-repo.

Reach for a **plugin** when:
- You want to share skills across multiple projects or with other people.
- You want versioning + update mechanics (`crtr pkg plugin manage update --name <name>`).
- You want a marketplace to index the work — see [[crouter-development/marketplaces]].

If it's a one-off note for yourself, scope-owned skills are simpler. Promote to a plugin later.

## Directory layout

```
<plugin-name>/
├── .crouter-plugin/
│   └── plugin.json                  # manifest — required
└── memory/
    ├── <name>.md                    # a kind:knowledge or kind:preference doc
    └── <area>/
        ├── INDEX.md                 # optional — a dir surfaces as one entry at its INDEX rung
        └── <name>.md
```

The `<plugin-name>` directory IS the plugin. The manifest's `name` field must match the directory name (install renames if needed). Sibling dirs (`rules/`, `agents/`, and future `commands/`, `hooks/`) hold the other artifact types.

## The manifest

`.crouter-plugin/plugin.json`:

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "One sentence — shown in `crtr pkg plugin inspect list`.",
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
| `source` | recommended | Git URL where the plugin lives. Used by `crtr pkg plugin manage update --name <name>`. |
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

1. **From a git URL** (`crtr pkg plugin manage install <url> --scope user`):
   - Clones into `<scope>/plugins/<name>/` using the manifest's name.
   - `crtr pkg plugin manage update --name <name>` does `git pull`.
   - Independent of any marketplace.

2. **From a marketplace** (`crtr pkg market manage install --marketplace <mkt> --plugin <name>`):
   - **Symlinks** the marketplace's `plugins/<name>/` into `<scope>/plugins/<name>/`.
   - `crtr pkg market manage update --marketplace <mkt>` pulls updates for every installed plugin from that marketplace.
   - See [[crouter-development/marketplaces]].

3. **Authored in place** (you're writing the plugin in a working repo):
   - Symlink for tight dev loop: `ln -s $(pwd) ~/.crouter/plugins/<name>`.
   - Or `crtr pkg plugin manage install file://$(pwd) --scope project` to clone-install.

## Local development loop

```bash
# Scaffold dir + manifest + first doc
mkdir -p my-plugin/.crouter-plugin my-plugin/memory
$EDITOR my-plugin/.crouter-plugin/plugin.json      # write the manifest
cd my-plugin
$EDITOR my-plugin/memory/my-first-skill.md         # author the doc — `crtr memory write -h` is the frontmatter + routing guide

# Symlink for fast iteration — no clone, edits land immediately
ln -s $(pwd) ~/.crouter/plugins/my-plugin

# Verify
crtr pkg plugin inspect list                       # my-plugin appears
crtr pkg plugin inspect show my-plugin             # lists its docs
crtr memory read my-plugin/my-first-skill          # resolve it under the plugin namespace
crtr sys doctor                                    # validates the manifest
crtr memory lint                                    # validates doc frontmatter
```

When ready to share: push to a git remote; anyone can `crtr pkg plugin manage install <url> --scope user`.

## Versioning

Standard semver:

| Change | Bump |
|---|---|
| Typo, wording polish | patch (0.1.0 → 0.1.1) |
| New skill, new section, new example | minor (0.1.0 → 0.2.0) |
| Removed skill, renamed skill, changed manifest schema | major (0.1.0 → 1.0.0) |

`crtr pkg plugin manage update --name <name>` reads the new version after pulling and updates the local config. Plugins published through a marketplace may have their `version` field bumped automatically by CI — see [[crouter-development/marketplaces]].

## Enable/disable

`crtr pkg plugin manage disable <name>` flips the per-scope config without removing files. Disabled plugins are hidden from `crtr memory list` and don't resolve via `crtr memory read <name>`. Re-enable with `crtr pkg plugin manage enable <name>`.

Individual skills inside an enabled plugin are hidden by setting their frontmatter visibility rungs to `none` (or a gate that fails), not by a command — see `crtr memory write -h`.

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

`crtr sys doctor` checks each plugin's manifest:
- Manifest exists and is valid JSON.
- Manifest `name` matches the directory name.

`crtr memory lint` checks the docs under `memory/`: frontmatter parses, valid `kind`, both visibility rungs set. Run `crtr memory write -h` for the authoring + routing guide. Sibling artifact dirs (`rules/`, `agents/`, `commands/`, `hooks/`) are validated by their respective specs as those land.

## Cross-publishing with Claude Code

Some plugins also publish a `.claude-plugin/` manifest alongside `.crouter-plugin/` so they can be loaded directly into Claude Code without going through crtr. Optional. Only worth doing when your skills/commands meaningfully stand alone in the Claude Code surface. Keep manifests in sync if you do.
