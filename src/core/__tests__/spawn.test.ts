// Tests for agent-CLI selection in spawn.ts (detectAgentKind + buildAgentCommand).
//
// Run with: node --import tsx/esm --test src/core/__tests__/spawn.test.ts

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectAgentKind,
  buildAgentCommand,
  buildAgentPrintArgv,
  buildAgentPrintCommand,
  normalizeModelForKind,
  subagentSessionName,
} from '../spawn.js';

const origPi = process.env['PI_CODING_AGENT'];

afterEach(() => {
  if (origPi === undefined) delete process.env['PI_CODING_AGENT'];
  else process.env['PI_CODING_AGENT'] = origPi;
});

describe('subagentSessionName', () => {
  test('derives a deterministic, tmux-safe name from a pane id', () => {
    assert.equal(subagentSessionName('%5'), 'crtr-agents-5');
    assert.equal(subagentSessionName('%23'), 'crtr-agents-23');
  });

  test('is stable for the same pane id and distinct across panes', () => {
    assert.equal(subagentSessionName('%7'), subagentSessionName('%7'));
    assert.notEqual(subagentSessionName('%7'), subagentSessionName('%8'));
  });

  test('strips characters tmux would treat specially', () => {
    assert.equal(subagentSessionName('%1.2'), 'crtr-agents-12');
    assert.match(subagentSessionName('%99'), /^crtr-agents-[a-zA-Z0-9]+$/);
  });
});

describe('detectAgentKind', () => {
  test('returns pi when PI_CODING_AGENT=true', () => {
    process.env['PI_CODING_AGENT'] = 'true';
    assert.equal(detectAgentKind(), 'pi');
  });

  test('defaults to claude when no signal is present', () => {
    delete process.env['PI_CODING_AGENT'];
    assert.equal(detectAgentKind(), 'claude');
  });
});

describe('buildAgentCommand: claude', () => {
  test('fresh prompt uses --dangerously-skip-permissions and quotes the prompt', () => {
    const cmd = buildAgentCommand({ prompt: 'do the thing', name: 'worker-1' }, 'claude');
    assert.equal(cmd, "claude -n 'worker-1' --dangerously-skip-permissions 'do the thing'");
  });

  test('fork uses --resume <id> --fork-session', () => {
    const cmd = buildAgentCommand({ prompt: 'p', fork: { sessionId: 'abc-123' } }, 'claude');
    assert.equal(cmd, "claude --resume 'abc-123' --fork-session --dangerously-skip-permissions 'p'");
  });
});

describe('buildAgentCommand: pi', () => {
  test('fresh prompt has no skip-permissions flag (pi has no permission popups)', () => {
    const cmd = buildAgentCommand({ prompt: 'do the thing', name: 'worker-1' }, 'pi');
    assert.equal(cmd, "pi -n 'worker-1' 'do the thing'");
    assert.ok(!cmd.includes('--dangerously-skip-permissions'));
  });

  test('fork uses --fork <id>', () => {
    const cmd = buildAgentCommand({ prompt: 'p', fork: { sessionId: 'abc-123' } }, 'pi');
    assert.equal(cmd, "pi --fork 'abc-123' 'p'");
  });

  test('single-quotes in the prompt are escaped safely', () => {
    const cmd = buildAgentCommand({ prompt: "it's fine" }, 'pi');
    assert.equal(cmd, "pi 'it'\\''s fine'");
  });
});

describe('buildAgentCommand: subagent persona (systemPrompt/model/tools)', () => {
  test('pi emits --model, --tools, and --append-system-prompt before the prompt', () => {
    const cmd = buildAgentCommand(
      { prompt: 'task', name: 'scout', systemPrompt: 'You are a scout.', model: 'haiku', tools: ['read', 'grep'] },
      'pi',
    );
    assert.equal(
      cmd,
      "pi -n 'scout' --model 'anthropic/haiku' --tools 'read,grep' --append-system-prompt 'You are a scout.' 'task'",
    );
  });

  test('claude emits --model and --append-system-prompt but NOT --tools (different tool model)', () => {
    const cmd = buildAgentCommand(
      { prompt: 'task', systemPrompt: 'persona', model: 'sonnet', tools: ['read', 'grep'] },
      'claude',
    );
    assert.ok(cmd.includes("--model 'sonnet'"));
    assert.ok(cmd.includes("--append-system-prompt 'persona'"));
    assert.ok(!cmd.includes('--tools'));
  });

  test('omitted persona fields add no flags', () => {
    const cmd = buildAgentCommand({ prompt: 'task' }, 'pi');
    assert.equal(cmd, "pi 'task'");
  });
});

describe('buildAgentPrintArgv: subagent persona', () => {
  test('pi threads model/tools/system prompt as discrete args', () => {
    const { args } = buildAgentPrintArgv(
      { prompt: 'task', systemPrompt: 'persona', model: 'haiku', tools: ['read', 'bash'] },
      'pi',
    );
    assert.deepEqual(args, ['--model', 'anthropic/haiku', '--tools', 'read,bash', '--append-system-prompt', 'persona', '-p', 'task']);
  });

  test('claude threads model/system prompt but not tools', () => {
    const { args } = buildAgentPrintArgv(
      { prompt: 'task', systemPrompt: 'persona', model: 'sonnet', tools: ['read'] },
      'claude',
    );
    assert.deepEqual(args, ['--model', 'sonnet', '--append-system-prompt', 'persona', '-p', '--dangerously-skip-permissions', 'task']);
  });
});

describe('normalizeModelForKind: pi Claude-alias resolution', () => {
  test('pins bare Claude aliases to the anthropic provider under pi', () => {
    assert.equal(normalizeModelForKind('sonnet', 'pi'), 'anthropic/sonnet');
    assert.equal(normalizeModelForKind('opus', 'pi'), 'anthropic/opus');
    assert.equal(normalizeModelForKind('haiku', 'pi'), 'anthropic/haiku');
  });

  test('preserves a :thinking suffix when pinning the provider', () => {
    assert.equal(normalizeModelForKind('sonnet:high', 'pi'), 'anthropic/sonnet:high');
  });

  test('leaves provider-prefixed and concrete ids untouched under pi', () => {
    assert.equal(normalizeModelForKind('anthropic/sonnet', 'pi'), 'anthropic/sonnet');
    assert.equal(normalizeModelForKind('openai/gpt-4o', 'pi'), 'openai/gpt-4o');
    assert.equal(normalizeModelForKind('claude-sonnet-4-6', 'pi'), 'claude-sonnet-4-6');
    assert.equal(normalizeModelForKind('gpt-4o-mini', 'pi'), 'gpt-4o-mini');
  });

  test('never rewrites for the claude CLI (native alias support)', () => {
    assert.equal(normalizeModelForKind('sonnet', 'claude'), 'sonnet');
    assert.equal(normalizeModelForKind('opus', 'claude'), 'opus');
  });
});

describe('buildAgentCommand: defaults to detected kind', () => {
  test('uses pi when PI_CODING_AGENT=true and no explicit kind passed', () => {
    process.env['PI_CODING_AGENT'] = 'true';
    const cmd = buildAgentCommand({ prompt: 'hi' });
    assert.ok(cmd.startsWith('pi '));
  });
});

describe('buildAgentPrintArgv (headless print mode)', () => {
  test('pi uses -p and no skip-permissions flag', () => {
    const { cmd, args } = buildAgentPrintArgv({ prompt: 'do it', name: 'w1' }, 'pi');
    assert.equal(cmd, 'pi');
    assert.deepEqual(args, ['-n', 'w1', '-p', 'do it']);
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  test('claude uses -p plus --dangerously-skip-permissions', () => {
    const { cmd, args } = buildAgentPrintArgv({ prompt: 'do it' }, 'claude');
    assert.equal(cmd, 'claude');
    assert.deepEqual(args, ['-p', '--dangerously-skip-permissions', 'do it']);
  });

  test('argv passes the prompt as a discrete arg (no shell quoting)', () => {
    const { args } = buildAgentPrintArgv({ prompt: "it's $weird" }, 'pi');
    assert.equal(args[args.length - 1], "it's $weird");
  });
});

describe('buildAgentPrintCommand (shell string)', () => {
  test('pi prints with -p and shell-quotes the prompt', () => {
    const cmd = buildAgentPrintCommand({ prompt: "it's fine" }, 'pi');
    assert.equal(cmd, "pi '-p' 'it'\\''s fine'");
  });
});
