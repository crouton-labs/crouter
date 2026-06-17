import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { defineLeaf } from '../core/command.js';
import type { LeafDef } from '../core/command.js';
import { InputError } from '../core/io.js';
import { getNode } from '../core/canvas/index.js';
import { sessionPtrPath } from '../core/canvas/paths.js';
import { SessionManager } from '../core/runtime/broker-sdk.js';
import { BUILTIN_SLASH_COMMANDS } from '../core/runtime/pi-vendored.js';
import type { BrokerSnapshot } from '../core/runtime/broker-protocol.js';
import type { SessionStats } from '@earendil-works/pi-coding-agent';

function resolveSessionFile(nodeId: string, metaFile: string | null | undefined): string | null {
  if (typeof metaFile === 'string' && metaFile !== '' && existsSync(metaFile)) return metaFile;
  const ptr = sessionPtrPath(nodeId);
  if (!existsSync(ptr)) return null;
  const raw = readFileSync(ptr, 'utf8').trim();
  if (raw === '') return null;
  if (existsSync(raw)) return raw;
  return null;
}

function emptyStats(sessionId: string, sessionFile: string | undefined): SessionStats {
  return {
    sessionFile,
    sessionId,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    cost: 0,
  };
}

function statsFromMessages(messages: BrokerSnapshot['messages'], sessionId: string, sessionFile: string | undefined): SessionStats {
  const stats = emptyStats(sessionId, sessionFile);
  stats.totalMessages = messages.length;
  for (const message of messages) {
    if (message.role === 'user') stats.userMessages++;
    else if (message.role === 'assistant') {
      stats.assistantMessages++;
      const content = Array.isArray(message.content) ? message.content : [];
      stats.toolCalls += content.filter((c) => c !== null && typeof c === 'object' && (c as { type?: string }).type === 'toolCall').length;
      const usage = message.usage;
      if (usage !== undefined) {
        stats.tokens.input += usage.input ?? 0;
        stats.tokens.output += usage.output ?? 0;
        stats.tokens.cacheRead += usage.cacheRead ?? 0;
        stats.tokens.cacheWrite += usage.cacheWrite ?? 0;
        stats.cost += usage.cost?.total ?? 0;
      }
    } else if (message.role === 'toolResult') {
      stats.toolResults++;
    }
  }
  stats.tokens.total = stats.tokens.input + stats.tokens.output + stats.tokens.cacheRead + stats.tokens.cacheWrite;
  return stats;
}

export const nodeSnapshotLeaf: LeafDef = defineLeaf({
  name: 'snapshot',
  description: 'read a dormant node session snapshot without launching its broker',
  whenToUse: 'you need a read-only broker-compatible snapshot of a dormant node; it copies the session JSONL before parsing and never revives the node',
  help: {
    name: 'node snapshot',
    summary: 'read-only dormant node snapshot in the broker welcome shape',
    params: [{ kind: 'positional', name: 'id', type: 'string', required: true, constraint: 'Canvas node id.' }],
    output: [
      { name: 'node_id', type: 'string', required: true, constraint: 'The node id.' },
      { name: 'snapshot', type: 'object', required: true, constraint: 'BrokerSnapshot-compatible {messages, stats, state}.' },
      { name: 'commands', type: 'object[]', required: true, constraint: "Builtin slash commands only: {name,description,source:'builtin'}." },
    ],
    outputKind: 'object',
    effects: ['Read-only: copies the session JSONL to a temp dir, parses the copy, then deletes the temp dir. Does not launch or revive brokers.'],
  },
  run: async (input) => {
    const nodeId = input['id'] as string;
    const node = getNode(nodeId);
    if (node === null) {
      throw new InputError({ error: 'not_found', message: `no node: ${nodeId}`, field: 'id', next: 'List nodes with `crtr node inspect list`.' });
    }
    const sessionFile = resolveSessionFile(nodeId, node.pi_session_file);
    if (sessionFile === null) {
      throw new InputError({ error: 'no_session', message: `node has no readable session file: ${nodeId}`, field: 'id', next: 'Revive the node first, or choose a node that has captured pi_session_file.' });
    }

    const tempDir = mkdtempSync(join(tmpdir(), 'crtr-node-snapshot-'));
    try {
      const copy = join(tempDir, basename(sessionFile));
      copyFileSync(sessionFile, copy);
      const manager = SessionManager.open(copy);
      const context = manager.buildSessionContext();
      const messages = context.messages as BrokerSnapshot['messages'];
      const sessionId = manager.getSessionId();
      const sessionName = manager.getSessionName();
      const snapshot: BrokerSnapshot = {
        messages,
        stats: statsFromMessages(messages, sessionId, sessionFile),
        state: {
          sessionId,
          sessionFile,
          model: context.model?.modelId,
          isStreaming: false,
          thinkingLevel: context.thinkingLevel as BrokerSnapshot['state']['thinkingLevel'],
          steeringMode: 'one-at-a-time',
          followUpMode: 'one-at-a-time',
          sessionName,
          autoCompactionEnabled: true,
          pendingMessageCount: 0,
        },
      };
      return {
        node_id: nodeId,
        snapshot,
        commands: BUILTIN_SLASH_COMMANDS.map((c) => ({ ...c, source: 'builtin' })),
      };
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  },
});
