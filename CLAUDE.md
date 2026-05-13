# crouter

The `crtr` CLI itself — core logic, infrastructure, and the LLM-facing
prompts that agents consume when invoking `crtr` subcommands.

## Scope

Foundational pieces of crtr live here:

- Command implementations (`src/commands/`)
- Agent-facing prompts (`src/prompts/`) — see `.claude/rules/agent-prompt-design.md`
- Core resolvers, scope handling, frontmatter parsing (`src/core/`)

If a behavior could ship as a plugin, ask: *does it need to live with the
CLI binary?* If yes, it belongs here.

## Boundary

- **Slash-command entrypoints** that wrap `crtr <subcommand>` →
  `~/Code/crouton-kit/plugins/crtr` (thin shims, no duplicated logic).
- **Convenient extensions** loosely coupled to crtr →
  `~/Code/cli/crouter-official-marketplace` (uninstallable without breaking core).
- **Core CLI behavior + agent prompts** → here.

## Build + install

`npm run build` rebuilds `dist/`. The `crtr` binary is symlinked via
`npm link`, so changes to `dist/` are picked up immediately by the next
invocation — no version bump or marketplace re-install needed.
