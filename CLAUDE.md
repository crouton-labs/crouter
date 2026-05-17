# crouter

## Constraints
- Never run `tsc` directly — it silently omits `dist/builtin-skills` (not compiled from TS, must be copied). The CLI will load with no skills. Always use `npm run build`.
