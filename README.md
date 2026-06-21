# crouter

## Install

```bash
npm install -g @crouton-kit/crouter
```

## Usage

```bash
crtr --help
```

## Official marketplace

`crtr` ships with the [crouter official marketplace](https://github.com/crouton-labs/crouter-official-marketplace) pre-installed. On first run it is cloned into your user scope and registered automatically — no plugins are enabled by default.

Browse and install plugins from it:

```bash
crtr pkg market inspect browse --marketplace crouter-official-marketplace
crtr pkg market manage install --marketplace crouter-official-marketplace --plugin <plugin>
```

To opt out of the bootstrap (e.g. in CI), set `CRTR_NO_BOOTSTRAP=1`.

## Running crouter on pi

The node runtime hosts the [pi coding agent](https://pi.dev) in each broker. To set your pi install up the way crouter's author runs it, add these to the `packages` array in `~/.pi/agent/settings.json` (neither ships with pi — you add them yourself):

- **[pi-claude-oauth-adapter](https://github.com/minzique/dotfiles-agents/tree/main/packages/pi-claude-oauth-adapter)** — third-party npm package; Anthropic OAuth / Claude Code compatibility adapter for pi. Install with `"npm:pi-claude-oauth-adapter"`.
- **[pi-personal-extensions](https://github.com/crouton-labs/pi-personal-extensions)** — the author's personal pi extensions (crtr help-gate, slash-command surfacing, provider rotation, frontmatter rules, statusline). Its README documents the full machine setup.

