# Spec: `crtr search` — web search for agents (Exa)

## Summary

Add a top-level `search` subtree to crtr that gives any node web-search capability backed by the Exa API. Three leaves cover the three things an agent needs: find pages relevant to a query (`web`), get a grounded answer with citations to a question (`answer`), and extract clean content from URLs it already has (`contents`). Output is agent-ready markdown — results, highlights, answers, and citations rendered as a continuation of the agent's prompt, never raw JSON. Highlights (query-relevant excerpts) are the default content mode because they keep token usage predictable; full page text is opt-in.

## Behavior

### `crtr search web QUERY`

The primary command. Finds web pages relevant to `QUERY` and returns ranked results with query-relevant highlight excerpts.

- **Input:** `QUERY` (positional, required). Flags:
  - `--type` — search depth, one of `auto | fast | instant | deep-lite | deep | deep-reasoning`. Default `auto` (balanced relevance/speed). `fast`/`instant` trade depth for latency; the `deep*` variants run multi-query expansion and rank the combined set.
  - `--num` — number of results, integer. Default `10`.
  - `--text` — boolean. When set, return cleaned full page text (capped) instead of highlights. Default off (highlights).
  - `--include-domains` — comma-separated domain allowlist. Optional.
  - `--exclude-domains` — comma-separated domain blocklist. Optional.
- **Output:** an ordered list of results, each carrying: title, URL, published date (when present), author (when present), and either highlight excerpts (default) or capped full text (`--text`). A lead line states the result count and the query. When zero results, the output says so and suggests broadening (drop domain filters, simplify query, try `--type auto`).
- A `--text` request always caps extracted length so a single call cannot blow up the caller's context.

### `crtr search answer QUESTION`

Question-first: returns one grounded natural-language answer to `QUESTION` plus the sources it cites.

- **Input:** `QUESTION` (positional, required). No depth flag — the endpoint owns synthesis.
- **Output:** the answer prose, followed by a numbered citation list (title + URL per source). When the endpoint returns no answer, the output says so and suggests `crtr search web` for raw results instead.

### `crtr search contents URLS`

Extraction for URLs the agent already has (from a prior search, a database, user input). Does not search.

- **Input:** `URLS` (positional, required) — one or more URLs separated by commas or whitespace. Flags:
  - `--text` — boolean, full text (capped) instead of highlights. Default off.
  - `--max-age-hours` — integer. Maximum acceptable age of cached content in hours; older than this triggers a fresh crawl. `0` forces a fresh crawl every time. Omitted = use cache when available, crawl as fallback.
- **Output:** per URL, the title and the extracted highlights (default) or capped text. URLs that could not be fetched are listed separately as failures with their reason.

### API key resolution

Every leaf needs an Exa API key, resolved in order:

1. `EXA_API_KEY` environment variable, if set and non-empty.
2. A key file at `<user-scope-root>/exa.key` (i.e. `~/.crouter/exa.key`), trimmed.

When neither is present, the command fails with a usage error naming both options (set `EXA_API_KEY` or write `~/.crouter/exa.key`) — it never prompts and never proceeds keyless.

### Failure behavior

- Missing key → usage error (exit code USAGE) with the two-option fix.
- Non-2xx response from Exa, or a network/transport failure → network error (exit code NETWORK) carrying Exa's status and message; the recovery hint points at retry / simpler query / fewer results, mirroring the Exa troubleshooting guidance.
- A malformed/empty result set is not an error — it renders as "no results" with a broadening suggestion.

## Architecture

- New top-level subtree registered in the lazy `SUBTREE_LOADERS` map (`src/build-root.ts`), so `crtr search …` loads only the search module on the hot path — consistent with every existing subtree.
- One subtree branch (`search`) with three leaf children (`web`, `answer`, `contents`), each a `defineLeaf` with its own `-h` schema and a bespoke `render()` that emits agent-ready markdown.
- A single internal Exa client module is the only thing that talks to `api.exa.ai`: it owns key resolution, the three endpoint calls (`/search`, `/answer`, `/contents`), request shaping, and translation of HTTP/transport failures into the crtr error taxonomy. The leaves never construct HTTP requests directly. The client uses the Node global `fetch` — no new dependency.
- Request shape follows the current Exa contract: content options nested under `contents` on `/search` (`contents.highlights` / `contents.text.maxCharacters`), top-level on `/contents`; `type` selects depth; deprecated parameters (`useAutoprompt`, `livecrawl`, top-level content flags on `/search`) are not used.

## Constraints

- Highlights are the default content mode on `web` and `contents`; full text is opt-in and always length-capped.
- No structured-output (`outputSchema`) synthesis in this version — grounded synthesis is served by `answer`. This keeps the surface to plain positional+flag args (a JSON schema is not an ergonomic CLI argument). It can be added later without changing existing leaves.
- The key file is user-scope only and is not committed to any repo; it is a plain secret file, not part of the strict `ScopeConfig` schema.
- stdout carries only rendered results; errors follow the standard crtr error contract; stderr is diagnostics only.
- Node global `fetch` (Node 22+) — no HTTP-client dependency added.

## Related files

- `src/build-root.ts` — lazy subtree loader registry.
- `src/core/command.ts`, `src/core/help.ts` — `defineBranch`/`defineLeaf` factories and the `-h` schema types.
- `src/core/errors.ts` — `usage()` / `network()` error constructors and exit codes.
- `src/core/scope.ts` — `userScopeRoot()` for the key-file path.
- `src/commands/memory.ts`, `src/commands/memory/find.ts` — reference shapes for a subtree branch and a leaf with a renderer.
