# crouter

## Constraints
- `@crouton-kit/humanloop` is a **yalc** local link (`file:.yalc/...`), not an npm package. After a fresh clone, restore with `yalc add @crouton-kit/humanloop` from this dir (requires `yalc push` from the humanloop package first). Publishing to npm while this reference is active will silently ship a broken package — run `yalc remove @crouton-kit/humanloop` and pin a real semver before publishing.
