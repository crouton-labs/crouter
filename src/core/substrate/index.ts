// substrate/ — the unified document-substrate keystone: the frontmatter schema,
// the 4-rung visibility ladder, the kind→default-rungs table, the node-config
// subject assembly, and gate evaluation. Pure + well-typed; the shared base the
// CLI verbs, boot render, on-read render, and migrator all build on. See
// design-substrate.md §4/§9 + plan-substrate.md §2.

export {
  // kinds
  KINDS,
  isDocKind,
  // ladder
  RUNGS,
  rungRank,
  rungAtLeast,
  // defaults
  KIND_DEFAULT_RUNGS,
  // parse + render-shared helpers
  parseSubstrateFrontmatter,
  parseSubstrateDoc,
  previewLine,
} from './schema.js';
export type { DocKind, Rung, GatePredicate, SubstrateSchema, SubstrateDoc } from './schema.js';

export { scopeForCwd, spineDepth, assembleNodeSubject } from './subject.js';
export type { NodeConfigSubject } from './subject.js';

export { gatePasses } from './gate.js';

export {
  INDEX_NAME,
  isIndexName,
  indexDirOf,
  displayName,
  buildCeilingIndex,
  effectiveRung,
} from './ceiling.js';
export type { Surface } from './ceiling.js';

export {
  renderSkillsSection,
  renderPreferencesSection,
  renderReferencesBlock,
  renderMemoryGuidance,
} from './render.js';
export { renderOnReadDocs } from './on-read.js';
