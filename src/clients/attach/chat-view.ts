// chat-view.ts — the render half of `crtr attach` (Phase 4, T5).
//
// A direct port of pi's `InteractiveMode.handleEvent()`
// (interactive-mode.js:2169-2462) + its rebuild path
// (`addMessageToChat`/`renderSessionContext`, :2483-2648) that DRIVES pi's own
// exported TUI components rather than reimplementing them. The viewer never
// spawns pi and never opens the session — it only consumes the relayed
// `AgentSessionEvent` stream + the `welcome` snapshot over `view.sock`.
//
// Ownership boundary: ChatView owns the chat scroll `Container` it is handed,
// plus an activity/status area pinned to the bottom of that container (working
// spinner, compaction/retry indicators, inline status/error lines). It does NOT
// own the editor, the footer, or the terminal title — those are chrome laid out
// by the attach command (T7). Events that only affect that chrome
// (queue_update / session_info_changed / thinking_level_changed) are forwarded
// to the optional `onFooterEvent` sink instead of rendered here.
//
// Custom-tool rendering (plan §3.3): extensions run in the broker, so the viewer
// has no `ToolDefinition`. Every tool renders through the DEFAULT
// `ToolExecutionComponent` path (toolDef = undefined) — builtin tools, diffs, and
// partial-result streaming all work; only custom `renderCall`/`renderResult`
// extensions degrade to the default, which is the decided Phase-4 behavior.

import { Container, Loader, Spacer, Text, type Component, type TUI } from '@earendil-works/pi-tui';
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  CustomMessageComponent,
  getMarkdownTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { BrokerSnapshot } from '../../core/runtime/broker-protocol.js';

/** One message from the catch-up snapshot — pi's `AgentMessage` union. */
type ChatMessage = BrokerSnapshot['messages'][number];

/** Minimal duck type for an assistant message's content items. We only ever read
 *  the tool-call shape; everything else falls through. */
type ToolCallContent = { type: 'toolCall'; id: string; name: string; arguments: unknown };

/** `theme` (the live instance) is NOT re-exported by pi's strict `.` map, so the
 *  loaders use small local ANSI styling rather than `theme.fg(...)`. Theme parity
 *  for activity spinners is cosmetic; the message components themselves still use
 *  `getMarkdownTheme()` for full-fidelity rendering. */
const spinnerStyle = (s: string): string => `\x1b[36m${s}\x1b[39m`; // cyan
const dimStyle = (s: string): string => `\x1b[2m${s}\x1b[22m`; // dim

export interface ChatViewOptions {
  /** Working dir used by `ToolExecutionComponent` for path/diff display. Defaults
   *  to the viewer's cwd; T7 may pass the node's working dir for nicer paths. */
  cwd?: string;
  /** Render inline images in tool output (terminal-dependent). Default true. */
  showImages?: boolean;
  /** Inline image width in cells. Default 60 (pi's default). */
  imageWidthCells?: number;
  /** Collapse the assistant thinking block. Default false. */
  hideThinking?: boolean;
  /** Label shown for a hidden thinking block. Default "Thinking...". */
  hiddenThinkingLabel?: string;
  /** Start tool output expanded. Default false. */
  toolOutputExpanded?: boolean;
  /** Sink for footer/header-only events ChatView does not itself render
   *  (queue_update, session_info_changed, thinking_level_changed). The attach
   *  command (T7) wires a footer here; absent → these events are no-ops. */
  onFooterEvent?: (event: AgentSessionEvent) => void;
}

export class ChatView {
  private readonly tui: TUI;
  /** The chat scroll area handed in by the attach command. */
  private readonly container: Container;
  /** Activity/status area, pinned as the LAST child of `container` (mirrors pi's
   *  statusContainer sitting directly below chatContainer). Holds the working
   *  spinner / compaction+retry loaders. */
  private readonly statusContainer = new Container();

  private readonly cwd: string;
  private readonly showImages: boolean;
  private readonly imageWidthCells: number;
  private readonly hideThinking: boolean;
  private readonly hiddenThinkingLabel: string;
  private readonly toolOutputExpanded: boolean;
  private readonly onFooterEvent: ((event: AgentSessionEvent) => void) | undefined;

  /** The assistant message component currently being streamed (between
   *  message_start and message_end for an assistant turn). */
  private streamingComponent: AssistantMessageComponent | undefined;
  /** Tool-call id → its execution component, for the duration of the call. */
  private readonly pendingTools = new Map<string, ToolExecutionComponent>();
  /** The single active activity loader (working/compaction/retry), if any. */
  private activityLoader: Loader | undefined;
  /** While true, `append` skips re-pinning the status container (bulk rebuild). */
  private bulkMode = false;

  constructor(tui: TUI, container: Container, opts: ChatViewOptions = {}) {
    this.tui = tui;
    this.container = container;
    this.cwd = opts.cwd ?? process.cwd();
    this.showImages = opts.showImages ?? true;
    this.imageWidthCells = opts.imageWidthCells ?? 60;
    this.hideThinking = opts.hideThinking ?? false;
    this.hiddenThinkingLabel = opts.hiddenThinkingLabel ?? 'Thinking...';
    this.toolOutputExpanded = opts.toolOutputExpanded ?? false;
    this.onFooterEvent = opts.onFooterEvent;
    this.container.addChild(this.statusContainer);
  }

  // -------------------------------------------------------------------------
  // Catch-up: render the welcome snapshot, then live events resume.
  // -------------------------------------------------------------------------

  /** Render the full message history from a `welcome` snapshot. Ports pi's
   *  `renderSessionContext` (interactive-mode.js:2553): assistant messages spawn
   *  tool-execution components matched to their toolResult messages; everything
   *  else routes through `addMessageToChat`. The TUI's differential renderer +
   *  reflow-on-resize is automatic — no scrollback reconstruction needed. */
  applySnapshot(snapshot: BrokerSnapshot): void {
    this.resetChat();
    const renderedPendingTools = new Map<string, ToolExecutionComponent>();
    const messages = snapshot.messages;
    const lastIndex = messages.length - 1;

    // Rebuild in bulk: detach the pinned status area, append children directly,
    // re-pin ONCE at the end. Keeps the rebuild O(N) instead of O(N²) re-pins for
    // a long transcript (see `append`).
    this.container.removeChild(this.statusContainer);
    this.bulkMode = true;
    try {
      for (let i = 0; i < messages.length; i++) {
        const message = messages[i];
        if (message.role === 'assistant') {
          // If the snapshot caught an IN-FLIGHT assistant turn (state.isStreaming
          // and this is the trailing, non-terminal assistant message), bind it as
          // the live streaming component so the relayed message_update/message_end
          // frames that follow `welcome` land on it. Otherwise the in-flight
          // message would freeze at its snapshot value until the next turn — the
          // common case, since you typically attach to a node that is working.
          const isStreamingTail =
            i === lastIndex &&
            snapshot.state.isStreaming &&
            message.stopReason !== 'aborted' &&
            message.stopReason !== 'error';
          if (isStreamingTail) {
            this.streamingComponent = new AssistantMessageComponent(
              undefined,
              this.hideThinking,
              getMarkdownTheme(),
              this.hiddenThinkingLabel,
            );
            this.append(this.streamingComponent);
            this.streamingComponent.updateContent(message as unknown as AssistantMessageLike);
          } else {
            this.addMessageToChat(message);
          }
          for (const content of this.assistantToolCalls(message)) {
            const component = this.makeToolComponent(content.name, content.id, content.arguments);
            this.append(component);
            // (isStreamingTail is never aborted/error, so its tools fall through to
            //  renderedPendingTools → pendingTools, where live tool events find them.)
            if (message.stopReason === 'aborted' || message.stopReason === 'error') {
              const errorMessage =
                message.stopReason === 'aborted'
                  ? 'Operation aborted'
                  : (message.errorMessage ?? 'Error');
              component.updateResult({ content: [{ type: 'text', text: errorMessage }], isError: true });
            } else {
              renderedPendingTools.set(content.id, component);
            }
          }
        } else if (message.role === 'toolResult') {
          const component = renderedPendingTools.get(message.toolCallId);
          if (component) {
            component.updateResult(message as unknown as ToolResultLike);
            renderedPendingTools.delete(message.toolCallId);
          }
        } else {
          this.addMessageToChat(message);
        }
      }
    } finally {
      this.bulkMode = false;
      this.container.addChild(this.statusContainer);
    }

    for (const [id, component] of renderedPendingTools) {
      this.pendingTools.set(id, component);
    }
    this.tui.requestRender();
  }

  /** Stop any spinning activity loader. A one-shot `crtr attach` process lets its
   *  timers die with the process, but if T7 reuses a ChatView across reconnects in
   *  one process it should call this on detach to avoid a leaked interval. */
  dispose(): void {
    this.setActivity(undefined);
  }

  // -------------------------------------------------------------------------
  // Live stream: the 15-of-17-case handleEvent port (turn_start/turn_end no-op,
  // exactly as interactive pi falls through default for those two).
  // -------------------------------------------------------------------------

  handleEvent(event: AgentSessionEvent): void {
    switch (event.type) {
      case 'agent_start': {
        this.pendingTools.clear();
        this.setActivity(this.makeLoader('Working...'));
        break;
      }

      case 'agent_end': {
        // Drop a dangling streaming component (e.g. aborted before message_end).
        if (this.streamingComponent) {
          this.container.removeChild(this.streamingComponent);
          this.streamingComponent = undefined;
        }
        this.pendingTools.clear();
        this.setActivity(undefined);
        break;
      }

      case 'message_start': {
        if (event.message.role === 'custom' || event.message.role === 'user') {
          this.addMessageToChat(event.message);
        } else if (event.message.role === 'assistant') {
          this.streamingComponent = new AssistantMessageComponent(
            undefined,
            this.hideThinking,
            getMarkdownTheme(),
            this.hiddenThinkingLabel,
          );
          this.append(this.streamingComponent);
          this.streamingComponent.updateContent(event.message as unknown as AssistantMessageLike);
        }
        break;
      }

      case 'message_update': {
        if (this.streamingComponent && event.message.role === 'assistant') {
          this.streamingComponent.updateContent(event.message as unknown as AssistantMessageLike);
          for (const content of this.assistantToolCalls(event.message)) {
            const existing = this.pendingTools.get(content.id);
            if (existing) {
              existing.updateArgs(content.arguments);
            } else {
              const component = this.makeToolComponent(content.name, content.id, content.arguments);
              this.append(component);
              this.pendingTools.set(content.id, component);
            }
          }
        }
        break;
      }

      case 'message_end': {
        if (event.message.role !== 'assistant') break;
        if (this.streamingComponent) {
          const stopReason = event.message.stopReason;
          let errorMessage = event.message.errorMessage;
          if (stopReason === 'aborted' && !errorMessage) {
            errorMessage = 'Operation aborted';
            // Surface the abort on the assistant bubble itself, mirroring pi
            // (interactive-mode.js:2280 sets streamingMessage.errorMessage before
            // updateContent) so the rendered message shows the annotation.
            event.message.errorMessage = errorMessage;
          }
          this.streamingComponent.updateContent(event.message as unknown as AssistantMessageLike);
          if (stopReason === 'aborted' || stopReason === 'error') {
            const text = errorMessage ?? 'Error';
            for (const component of this.pendingTools.values()) {
              component.updateResult({ content: [{ type: 'text', text }], isError: true });
            }
            this.pendingTools.clear();
          } else {
            // Args complete → trigger diff computation for edit tools.
            for (const component of this.pendingTools.values()) {
              component.setArgsComplete();
            }
          }
          this.streamingComponent = undefined;
        }
        break;
      }

      case 'tool_execution_start': {
        let component = this.pendingTools.get(event.toolCallId);
        if (!component) {
          component = this.makeToolComponent(event.toolName, event.toolCallId, event.args);
          this.append(component);
          this.pendingTools.set(event.toolCallId, component);
        }
        component.markExecutionStarted();
        break;
      }

      case 'tool_execution_update': {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) {
          component.updateResult({ ...event.partialResult, isError: false }, true);
        }
        break;
      }

      case 'tool_execution_end': {
        const component = this.pendingTools.get(event.toolCallId);
        if (component) {
          component.updateResult({ ...event.result, isError: event.isError });
          this.pendingTools.delete(event.toolCallId);
        }
        break;
      }

      case 'compaction_start': {
        const label = event.reason === 'manual' ? 'Compacting context...' : 'Auto-compacting...';
        this.setActivity(this.makeLoader(label));
        break;
      }

      case 'compaction_end': {
        this.setActivity(undefined);
        if (event.aborted) {
          this.showStatus(event.reason === 'manual' ? 'Compaction cancelled' : 'Auto-compaction cancelled');
        } else if (event.result) {
          // 0.78.1 divergence from the §3.2 sketch: `compaction_end` carries only
          // the CompactionResult (summary + tokensBefore), NOT the post-compaction
          // message list — so the viewer cannot clear+rebuild the transcript the
          // way in-process pi does (it rebuilds from its own SessionManager). We
          // append the compaction summary marker instead and KEEP the
          // pre-compaction scrollback for the rest of this attach session; a fresh
          // re-attach gets the already-compacted history via `welcome`. (Reported
          // in T5's final.)
          this.addMessageToChat({
            role: 'compactionSummary',
            summary: event.result.summary,
            tokensBefore: event.result.tokensBefore,
            timestamp: Date.now(),
          } as ChatMessage);
        } else if (event.errorMessage) {
          this.showError(event.errorMessage);
        }
        break;
      }

      case 'auto_retry_start': {
        const seconds = Math.ceil(event.delayMs / 1000);
        this.setActivity(this.makeLoader(`Retrying (${event.attempt}/${event.maxAttempts}) in ${seconds}s...`));
        break;
      }

      case 'auto_retry_end': {
        this.setActivity(undefined);
        if (!event.success) {
          this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError ?? 'Unknown error'}`);
        }
        break;
      }

      // Footer/header-only — ChatView owns no footer; forward to the sink.
      case 'queue_update':
      case 'session_info_changed':
      case 'thinking_level_changed':
        this.onFooterEvent?.(event);
        break;

      // turn_start / turn_end — interactive pi ignores these (falls through
      // default); the viewer does too.
      default:
        break;
    }
    this.tui.requestRender();
  }

  // -------------------------------------------------------------------------
  // Rebuild path (ports addMessageToChat, interactive-mode.js:2483).
  // -------------------------------------------------------------------------

  private addMessageToChat(message: ChatMessage): void {
    switch (message.role) {
      case 'bashExecution': {
        const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
        if (message.output) component.appendOutput(message.output);
        component.setComplete(
          message.exitCode,
          message.cancelled,
          // pi's interactive mode passes a minimal `{truncated:true}` marker here
          // (interactive-mode.js:2489) where the typed param is the full
          // TruncationResult; the snapshot message only carries the boolean, so we
          // mirror pi and cast.
          message.truncated ? ({ truncated: true } as unknown as TruncationResultLike) : undefined,
          message.fullOutputPath,
        );
        this.append(component);
        break;
      }
      case 'custom': {
        if (message.display) {
          // No extension renderer in the viewer → default custom-message render.
          const component = new CustomMessageComponent(message, undefined, getMarkdownTheme());
          component.setExpanded(this.toolOutputExpanded);
          this.append(component);
        }
        break;
      }
      case 'compactionSummary': {
        this.append(new Spacer(1));
        const component = new CompactionSummaryMessageComponent(message, getMarkdownTheme());
        component.setExpanded(this.toolOutputExpanded);
        this.append(component);
        break;
      }
      case 'branchSummary': {
        this.append(new Spacer(1));
        const component = new BranchSummaryMessageComponent(message, getMarkdownTheme());
        component.setExpanded(this.toolOutputExpanded);
        this.append(component);
        break;
      }
      case 'user': {
        const textContent = this.userMessageText(message);
        if (!textContent) break;
        if (this.chatChildCount() > 0) this.append(new Spacer(1));
        const skillBlock = parseSkillBlock(textContent);
        if (skillBlock) {
          const component = new SkillInvocationMessageComponent(skillBlock, getMarkdownTheme());
          component.setExpanded(this.toolOutputExpanded);
          this.append(component);
          if (skillBlock.userMessage) {
            this.append(new UserMessageComponent(skillBlock.userMessage, getMarkdownTheme()));
          }
        } else {
          this.append(new UserMessageComponent(textContent, getMarkdownTheme()));
        }
        break;
      }
      case 'assistant': {
        this.append(
          new AssistantMessageComponent(
            message as unknown as AssistantMessageLike,
            this.hideThinking,
            getMarkdownTheme(),
            this.hiddenThinkingLabel,
          ),
        );
        break;
      }
      // toolResult is rendered inline with its tool call (handled in applySnapshot).
      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Default-path tool component (toolDef undefined → builtin/default rendering). */
  private makeToolComponent(name: string, id: string, args: unknown): ToolExecutionComponent {
    const component = new ToolExecutionComponent(
      name,
      id,
      args,
      { showImages: this.showImages, imageWidthCells: this.imageWidthCells },
      undefined,
      this.tui,
      this.cwd,
    );
    component.setExpanded(this.toolOutputExpanded);
    return component;
  }

  /** Append a child while keeping the activity/status area pinned to the bottom. */
  private append(child: Component): void {
    if (this.bulkMode) {
      this.container.addChild(child);
      return;
    }
    this.container.removeChild(this.statusContainer);
    this.container.addChild(child);
    this.container.addChild(this.statusContainer);
  }

  /** Number of chat children excluding the pinned status container. */
  private chatChildCount(): number {
    return this.container.children.filter((c) => c !== this.statusContainer).length;
  }

  /** Clear all chat content and re-pin an empty status container. */
  private resetChat(): void {
    this.setActivity(undefined);
    this.streamingComponent = undefined;
    this.pendingTools.clear();
    this.container.clear();
    this.container.addChild(this.statusContainer);
  }

  private makeLoader(message: string): Loader {
    return new Loader(this.tui, spinnerStyle, dimStyle, message);
  }

  /** Swap the single active activity indicator (working/compaction/retry). */
  private setActivity(loader: Loader | undefined): void {
    this.activityLoader?.stop();
    this.statusContainer.clear();
    this.activityLoader = loader;
    if (loader) this.statusContainer.addChild(loader);
  }

  private showStatus(message: string): void {
    this.append(new Spacer(1));
    this.append(new Text(dimStyle(message), 1, 0));
  }

  private showError(message: string): void {
    this.append(new Spacer(1));
    this.append(new Text(`\x1b[31m${message}\x1b[39m`, 1, 0));
  }

  /** Extract the tool-call content items from an assistant message. */
  private assistantToolCalls(message: { content?: unknown }): ToolCallContent[] {
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.filter(
      (c): c is ToolCallContent =>
        typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'toolCall',
    );
  }

  /** Concatenate the text blocks of a user message (string or content array). */
  private userMessageText(message: { content?: unknown }): string {
    const content = (message as { content?: unknown }).content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .filter((c): c is { type: 'text'; text: string } =>
        typeof c === 'object' && c !== null && (c as { type?: unknown }).type === 'text',
      )
      .map((c) => c.text)
      .join('');
  }
}

/** The structural shape `AssistantMessageComponent.updateContent` consumes.
 *  pi's own JS passes `AgentMessage` where pi-ai's `AssistantMessage` is typed;
 *  the two are structurally identical but nominally distinct across the
 *  pi-ai / pi-agent-core module boundary, so we bridge with a local alias rather
 *  than a deep import of pi-ai's `AssistantMessage`. */
type AssistantMessageLike = Parameters<AssistantMessageComponent['updateContent']>[0];

/** The structural shape `ToolExecutionComponent.updateResult` consumes for a
 *  finished toolResult message. */
type ToolResultLike = Parameters<ToolExecutionComponent['updateResult']>[0];

/** The truncation-marker shape `BashExecutionComponent.setComplete` consumes. */
type TruncationResultLike = Parameters<BashExecutionComponent['setComplete']>[2];
