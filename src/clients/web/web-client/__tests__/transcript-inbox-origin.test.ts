// Regression: the fold-in to the in-tree web client dropped the inbox-origin
// stamping that the old crouter-web NodeSessionHub did at fold time, so inbox
// digest messages (injected by canvas-inbox-watcher) rendered as ordinary user
// messages instead of the distinct InboundView. `isInboxDigest` was defined but
// never called in-tree. This locks in that `transcript.ts` re-tags
// `role:'user'` digest messages with `origin:'inbox'` on both ingest paths
// (applySnapshot + message_start), and leaves normal user messages untagged.
//
// Ported from the old crouter-web `inbox-detect.test.ts`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applySnapshot, reduce, initialConvState } from '../transcript.js';
import type { BrokerSnapshot, AgentSessionEvent, AnyMessage } from '../protocol.js';

// A coalesce() digest exactly as canvas-inbox-watcher injects it.
const DIGEST = 'From mqifzplr-0753bde3 — 2 update(s):\n  [report] done (ref: /tmp/x.md)';
const NORMAL = 'please run the build and report back';

function userMsg(text: string): AnyMessage {
  return { role: 'user', content: text } as AnyMessage;
}
function originOf(m: AnyMessage): string | undefined {
  return (m as { origin?: string }).origin;
}

test('applySnapshot: inbox digest user message gets origin:inbox; normal user message does not', () => {
  const snapshot = {
    messages: [userMsg(NORMAL), userMsg(DIGEST)],
    state: { isStreaming: false },
  } as unknown as BrokerSnapshot;

  const state = applySnapshot(snapshot);

  assert.equal(originOf(state.messages[0]!), undefined, 'normal user message stays untagged');
  assert.equal(originOf(state.messages[1]!), 'inbox', 'inbox digest gets origin:inbox');
});

test('applySnapshot: block-content user message (text blocks) is detected', () => {
  const blockMsg = { role: 'user', content: [{ type: 'text', text: DIGEST }] } as AnyMessage;
  const state = applySnapshot({ messages: [blockMsg], state: { isStreaming: false } } as unknown as BrokerSnapshot);
  assert.equal(originOf(state.messages[0]!), 'inbox');
});

test('message_start: inbox digest user message gets origin:inbox', () => {
  const event = { type: 'message_start', message: userMsg(DIGEST) } as unknown as AgentSessionEvent;
  const state = reduce(initialConvState(), event);
  assert.equal(originOf(state.messages[0]!), 'inbox');
});

test('message_start: normal user message stays untagged', () => {
  const event = { type: 'message_start', message: userMsg(NORMAL) } as unknown as AgentSessionEvent;
  const state = reduce(initialConvState(), event);
  assert.equal(originOf(state.messages[0]!), undefined);
});

test('message_start: assistant messages are never tagged inbox', () => {
  const assistant = { role: 'assistant', content: [{ type: 'text', text: DIGEST }] } as AnyMessage;
  const event = { type: 'message_start', message: assistant } as unknown as AgentSessionEvent;
  const state = reduce(initialConvState(), event);
  assert.equal(originOf(state.messages[0]!), undefined);
});
