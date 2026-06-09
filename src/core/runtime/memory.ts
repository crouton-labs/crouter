// memory.ts — the node-local substrate document store.
//
// One scope lives here: node-local memory, a `memory/` directory of substrate
// documents (.md files with typed frontmatter — kind, when, why,
// system-prompt-visibility, gate) inside a node's context dir; it dies with the
// node. User-global and project memory are scope-resolved stores — see
// `scopeMemoryDir` in core/scope.ts.

import { join } from 'node:path';
import { contextDir } from '../canvas/index.js';

/** The node-local memory directory in a node's context dir — holds substrate
 *  docs (.md files with kind/when/why frontmatter). */
export function memoryDir(nodeId: string): string {
  return join(contextDir(nodeId), 'memory');
}
