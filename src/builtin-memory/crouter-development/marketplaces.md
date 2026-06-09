---
kind: skill
when: When a task relates to marketplaces
why: How to author a crtr marketplace — marketplace.json index, plugin entries,
  symlink-based install, auto-bump CI, dual-publishing. Use when creating a
  marketplace or contributing plugins to one.
short-form: How to author a crtr marketplace — marketplace.json index, plugin
  entries, symlink-based install, auto-bump CI, dual-publishing. Use when
  creating a marketplace or contributing plugins to one.
system-prompt-visibility: name
file-read-visibility: none
needs-refinement: true
---

# Authoring crtr marketplaces

A **marketplace** is a git repo that indexes multiple plugins. Users register it once, then `crtr pkg market manage install --marketplace <mkt> --plugin <plugin>` symlinks any plugin from it. `crtr pkg market manage update --marketplace <mkt>` pulls updates for every installed plugin at once.

Audience: LLM agents creating a marketplace or adding plugins to an existing one.

## When you need a marketplace (vs a single-plugin repo)

A solo plugin ships from any git URL via `crtr pkg plugin manage install <url> --scope user` — no marketplace needed.

Reach for a marketplace when:
- You want to publish ≥3 plugins under one brand or theme.
- Users should install selectively without cloning each plugin's repo.
- You want centralized version-bump automation across many plugins.

If you have one plugin, ship it standalone. Promote to a marketplace later.

## Directory layout

```
<marketplace-repo>/
├── .crouter-marketplace/
│   └── marketplace.json              # marketplace manifest — required
└── plugins/
    ├── plugin-a/
    │   ├── .crouter-plugin/plugin.json
    │   └── skills/...
    └── plugin-b/
        └── ...
```

Each entry under `plugins/` is a complete plugin (see [[crouter-development/plugins]]). The marketplace adds an index on top.

## The manifest

`.crouter-marketplace/marketplace.json`:

```json
{
  "name": "my-marketplace",
  "version": "0.3.0",
  "owner": { "name": "Your Name", "email": "you@example.com" },
  "plugins": [
    {
      "name": "plugin-a",
      "version": "0.2.1",
      "source": "https://github.com/<owner>/<repo>",
      "description": "One sentence."
    },
    { "name": "plugin-b", "version": "0.1.0", "source": "…", "description": "…" }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | yes | Lowercase kebab. |
| `version` | yes | Semver. Bumps when any plugin bumps or when the marketplace manifest itself changes. |
| `owner` | optional | |
| `plugins` | yes | Array. Each entry: `name`, `version`, `source`, `description`. |

The `plugins[]` array IS the index — what's installable. A plugin on disk but not in the index won't resolve. A plugin in the index but missing from disk errors on install.

## Install mechanics — symlinks, not clones

When a user runs `crtr pkg market manage install --marketplace my-marketplace --plugin plugin-a`:
1. Crouter looks up `plugin-a` in the marketplace's manifest.
2. **Symlinks** `<marketplace-clone>/plugins/plugin-a/` → `<user-scope>/plugins/plugin-a/`.
3. Records the install in the scope config with `source_marketplace: my-marketplace`.

Therefore `crtr pkg market manage update --marketplace my-marketplace` (which does `git pull` in the marketplace clone) updates every installed plugin from it — no per-plugin re-install, no second clone.

## Version-bump automation (recommended)

Bumping N plugin manifests + the index by hand is error-prone. The canonical pattern is a GitHub Actions workflow that bumps versions from commit subjects (conventional commits):

| Commit subject | Bump |
|---|---|
| `feat!: …` or `BREAKING CHANGE` in body | major |
| `feat: …` | minor |
| anything else (`fix:`, `chore:`, `docs:`, …) | patch |

Per commit:
- For each plugin folder touched, both `plugins/<name>/.crouter-plugin/plugin.json` and the matching entry in `marketplace.json` get bumped.
- Top-level `marketplace.json` version bumps when any plugin bumps OR the manifest itself was edited directly.
- Newly-added plugins are skipped — they keep the version you committed.
- Commits whose subject starts with `chore: release` are skipped to avoid loops.

If you adopt this: **never edit `version` fields by hand**. CI will overwrite. Document this in the marketplace's CLAUDE.md.

The crouter-official-marketplace repo's `.github/workflows/auto-bump.yml` is the reference implementation. Copy it.

## Adding a plugin to a marketplace

```bash
cd <marketplace-repo>

# Create the plugin (see [[crouter-development/plugins]] for plugin layout)
mkdir -p plugins/my-new-plugin/.crouter-plugin plugins/my-new-plugin/skills
$EDITOR plugins/my-new-plugin/.crouter-plugin/plugin.json

# Add at least one skill
crtr skill author scaffold my-new-plugin/first-skill --type playbook --description "Use when …"

# Add the plugin to the marketplace index
$EDITOR .crouter-marketplace/marketplace.json
# (append to plugins[] with name, initial version, source, description)

# Validate
crtr sys doctor

# Commit — CI bumps versions if you've wired up auto-bump
git add -A
git commit -m "feat: add my-new-plugin"
git push
```

Existing users pick it up on their next `crtr pkg market manage update --marketplace <marketplace-name>` (or on the next auto-update tick if they've set `auto_update.content: "apply"`).

## Updating an existing plugin

Edit content under `plugins/<name>/`. Commit with a conventional-commit subject. CI bumps the plugin manifest and the marketplace index entry together. No manual sync.

## Removing a plugin

Delete the plugin's directory AND its entry in `marketplace.json` → `plugins[]`. Commit with `feat!: remove <plugin>` to signal a major bump (the marketplace's contract changed for anyone depending on that plugin).

## Marketplace registration scopes

A marketplace itself registers per-scope:

| Scope | Path | Use case |
|---|---|---|
| user | `~/.crouter/marketplaces/<name>/` | Private to your machine — your personal subscriptions |
| project | `<project>/.crouter/marketplaces/<name>/` | Checked into the repo — anyone cloning gets the same marketplace pinned |

`crtr pkg market manage add --url <git-url> --scope user` is the default. Use `--scope project` when the marketplace is integral to how the repo expects to be developed.

## Validation

`crtr sys doctor` checks marketplaces:
- `marketplace.json` is valid JSON.
- Every entry in `plugins[]` corresponds to a real directory under `plugins/`.
- Each plugin under `plugins/` passes plugin-level validation.

A plugin on disk but missing from the manifest is a **warning** (probably forgotten); a plugin in the manifest but missing on disk is an **error** (install would break).

## Cross-publishing with Claude Code

Some marketplaces ship a parallel `.claude-plugin/` tree so plugins can load directly into Claude Code without crtr. Optional. Sync the two manifests if you adopt it.
