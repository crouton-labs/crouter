// canvas-doc-substrate.ts — the document substrate's two render hooks, owned by
// a single self-contained canvas pi extension.
//
// Loaded into a canvas node's pi process via the node's launch.extensions list
// (registered in CANVAS_EXTENSIONS at the flip — see the note at the bottom of
// this file; AUTHOR-ONLY for now, NOT yet registered). INERT when CRTR_NODE_ID
// is absent (a plain pi session or legacy job agent loads it as a no-op).
//
// It owns the substrate's two new pi hooks:
//
//   1. before_agent_start — the BOOT system-prompt half. Splices the rendered
//      `<skills>` + `<preferences>` + `<memory-guidance>` blocks into
//      `event.systemPrompt`, right after pi's native "Available tools" list
//      (before the `\n\nGuidelines:`
//      anchor), so the substrate's skills/preferences sit in the tool-selection
//      frame the agent reads while choosing a capability — mirroring the
//      personal crouter-help.ts anchor logic. Falls back to appending when the
//      anchor is absent.
//
//   2. tool_result (gated on `read`) — the ON-READ half. For each non-error
//      `read`, surfaces the substrate docs that should appear alongside the file
//      (positional `.crouter/memory/` ancestors + `applies-to` globs) at their
//      file-read-visibility rung, prepended as a `<auto-loaded-context>` block
//      before the file contents. A per-session realpath set dedups so the same
//      doc is not re-injected on repeat reads.
//
// Both handler bodies are wrapped in try/catch and degrade to INERT on error —
// a substrate bug must never brick node boot or break a `read`, only quietly
// stop surfacing docs. The pure render lives in core/substrate/ (render.ts +
// on-read.ts); this file is only the pi-hook plumbing.
//
// Plain TS-with-types — NO imports from @earendil-works/* (a local structural
// PiLike interface stands in), so it compiles inside crouter's own tsc build
// with no dep on the pi packages. Mirrors canvas-context-intro.ts.

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  renderMemoryGuidance,
  renderOnReadDocs,
  renderPreferencesSection,
  renderSkillsSection,
} from '../core/substrate/index.js';
import { clearSessionCache } from '../core/substrate/session-cache.js';
import { loadInjectedDocs, saveInjectedDocs } from '../core/substrate/injected-store.js';

// ---------------------------------------------------------------------------
// Minimal PiLike interface (avoids a hard dep on @earendil-works/*). Mirrors
// the three event shapes pi exposes that we attach to: before_agent_start
// (system-prompt rewrite), session_start (per-session reset), and tool_result
// (read-result augmentation). See canvas-context-intro.ts for the pattern.
// ---------------------------------------------------------------------------

/** before_agent_start: pi hands us the assembled system prompt; returning a new
 *  `systemPrompt` replaces it for this agent run (pi rebuilds it each run, so
 *  splicing fresh every time is idempotent — never cumulative). */
interface BeforeAgentStartEventLike {
  systemPrompt: string;
}
interface BeforeAgentStartResultLike {
  systemPrompt: string;
}

/** tool_result: fired after a tool returns. `content` is the tool's output
 *  blocks; returning a new `content` replaces what the model sees. */
interface ContentBlockLike {
  type: string;
  text?: string;
}
interface ToolResultEventLike {
  toolName: string;
  isError?: boolean;
  /** The tool's resolved input. For `read` it carries the file path under
   *  `path` (or the legacy `file_path`). Typed loosely; narrowed at use. */
  input?: unknown;
  content: ContentBlockLike[];
}
interface ToolResultCtxLike {
  /** The session cwd — used to resolve a relative read path. */
  cwd?: string;
}
type ToolResultResultLike = { content: ContentBlockLike[] } | void;

interface PiLike {
  on(
    event: 'before_agent_start',
    handler: (
      event: BeforeAgentStartEventLike,
    ) => BeforeAgentStartResultLike | void | Promise<BeforeAgentStartResultLike | void>,
  ): void;
  on(event: 'session_start', handler: (event: unknown, ctx: unknown) => void): void;
  on(
    event: 'tool_result',
    handler: (
      event: ToolResultEventLike,
      ctx: ToolResultCtxLike,
    ) => ToolResultResultLike | Promise<ToolResultResultLike>,
  ): void;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

/** The stable seam that closes pi's native "Available tools" list. We splice the
 *  substrate's boot sections right before it — the agent decides which capability
 *  to reach for while reading the tools, so skills/preferences must sit there,
 *  not far below. Mirrors crouter-help.ts. Falls back to appending if absent. */
const TOOLS_ANCHOR = '\n\nGuidelines:';

/**
 * Register the document substrate's two render hooks on `pi`.
 *
 * Returns immediately (inert) when CRTR_NODE_ID is absent — a non-canvas pi
 * session gets neither hook. Each handler is independently wrapped so a failure
 * degrades to a no-op (boot proceeds, the read returns) rather than bricking.
 */
export function registerCanvasDocSubstrate(pi: PiLike): void {
  const nodeId = process.env['CRTR_NODE_ID'];
  if (nodeId === undefined || nodeId.trim() === '') return; // not a canvas node — inert

  // Per-TRANSCRIPT set of injected doc realpaths → a doc surfaces at most once
  // across the node's conversation, EVEN across a dormancy → revive(resume)
  // cycle. A resume reuses the same .jsonl transcript in a NEW pi process, so
  // the set is REHYDRATED from disk at process start (not started empty) and is
  // NOT cleared on session_start — a resume continues the transcript, so the
  // dedup must carry forward. The one launch path that begins a FRESH transcript
  // (reviveNode with resume=false) deletes the file, so a new conversation
  // rehydrates empty here. See core/substrate/injected-store.ts.
  const injectedDocs = loadInjectedDocs(nodeId);
  pi.on('session_start', () => {
    // Only the per-session substrate PARSE cache resets each session (so the
    // corpus is re-scanned, picking up skill/memory writes). injectedDocs is
    // transcript-scoped, not session-scoped — deliberately NOT cleared here.
    clearSessionCache();
  });

  // 1. BOOT system-prompt half — splice `<skills>` + `<preferences>` +
  //    `<memory-guidance>`. The guidance block is always present for a canvas
  //    node (the memory system always exists), so the splice is never empty even
  //    when both trees are.
  pi.on('before_agent_start', (event) => {
    try {
      const sections = [
        renderSkillsSection(nodeId),
        renderPreferencesSection(nodeId),
        renderMemoryGuidance(),
      ].filter((s) => s !== '');
      if (sections.length === 0) return; // nothing eligible — leave the prompt untouched
      const block = sections.join('\n\n');
      const idx = event.systemPrompt.indexOf(TOOLS_ANCHOR);
      if (idx === -1) {
        return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
      }
      return {
        systemPrompt: `${event.systemPrompt.slice(0, idx)}\n\n${block}${event.systemPrompt.slice(idx)}`,
      };
    } catch {
      return; // inert on error — never brick node boot
    }
  });

  // 2. ON-READ half — augment a non-error `read` result with surfacing docs.
  pi.on('tool_result', (event, ctx) => {
    try {
      if (event.toolName !== 'read' || event.isError === true) return;
      const input = event.input as { path?: string; file_path?: string } | undefined;
      const rawPath = input?.path ?? input?.file_path;
      if (rawPath === undefined || rawPath === '') return;

      // Resolve to an absolute path (renderOnReadDocs realpaths it). pi's read
      // tool expands a leading `~`, but event.input keeps the raw form, so
      // expand it ourselves before resolving against the session cwd.
      const cwd = typeof ctx?.cwd === 'string' && ctx.cwd !== '' ? ctx.cwd : process.cwd();
      const expanded = rawPath.startsWith('~') ? join(homedir(), rawPath.slice(1)) : rawPath;
      const absFile = resolve(cwd, expanded);

      const injected = renderOnReadDocs(nodeId, absFile, injectedDocs);
      if (injected === '') return; // nothing surfaced — pass the read through unchanged

      // A doc surfaced → renderOnReadDocs grew injectedDocs; persist the set so
      // the dedup survives a later dormancy → revive(resume).
      saveInjectedDocs(nodeId, injectedDocs);

      // Prepend the surfacing docs ahead of the file contents.
      return { content: [{ type: 'text', text: injected }, ...event.content] };
    } catch {
      return; // inert on error — a bug must degrade a read, never break it
    }
  });
}

export default registerCanvasDocSubstrate;
