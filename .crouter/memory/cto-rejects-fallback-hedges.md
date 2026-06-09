---
kind: preference
when: When a task relates to cto rejects fallback hedges
why: CTO rejects fallback/compat-hedge code paths — fix the source data +
  isolate the bad case + enforce with a lint, never a runtime second-path hedge
short-form: CTO rejects fallback/compat-hedge code paths — fix the source data +
  isolate the bad case + enforce with a lint, never a runtime second-path hedge
system-prompt-visibility: preview
file-read-visibility: none
needs-refinement: true
---

When a strict path (parser, validator, schema) throws on some real inputs, do NOT add a fallback / lenient second path to tolerate them. The CTO's words: "I really hate fallbacks." He killed a pre-authorized hybrid `yaml`+lenient-fallback frontmatter parser in favor of: (1) ONE strict parser, (2) FIX the small set of invalid source docs so the real corpus is valid, (3) ISOLATE the bad case at the collection/iterator layer (per-item catch → scoped "invalid X in <path>" notice → continue; not a second parser), (4) make the gate a permanent LINT that enforces validity at authoring time.

**Why:** a fallback is a runtime hedge that hides bad data and adds a second code path forever; fixing the data + a lint surfaces breakage at authoring time and stays net-simpler. This is the same taste as [[cto-wants-net-simpler-refactors]] and [[prefers-hard-cuts]] — measured by what you DELETE, not what you add to be safe.

**How to apply:** when tempted to add a fallback/compat shim to absorb invalid inputs, instead propose: strict path stays strict, fix the offending data, isolate so one bad item can't crash the batch, and add a lint/gate that keeps the corpus valid. If you've pre-authorized a fallback, expect the CTO to overrule it — don't pre-authorize hedges in the first place.
