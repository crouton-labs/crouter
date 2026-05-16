import { Command } from 'commander';
import { existsSync } from 'node:fs';
import { artifactPath, artifactsRoot } from '../core/artifact.js';
import { readConfig } from '../core/config.js';
import {
  spawnAgent,
  spawnAndDetach,
  awaitSession,
  submitToSession,
  DEFAULT_PANE_OPTS,
  type DetachOptions,
} from '../core/spawn.js';
import { pathExists } from '../core/fs-utils.js';
import { notFound, usage } from '../core/errors.js';
import { handleError, hint, out, info } from '../core/output.js';
import {
  implementHandoffPrompt,
  planHandoffPrompt,
  reviewHandoffPrompt,
} from '../prompts/agent.js';

// Seconds before the originating pane is closed in fire-and-forget workflow
// handoffs (plan/implement/review). Override with --kill-after.
const DEFAULT_KILL_SECS = 2;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function resolvePrompt(positional: string | undefined): Promise<string> {
  if (positional !== undefined && positional !== '') return positional;
  if (!process.stdin.isTTY) {
    const piped = await readStdin();
    if (piped.trim() !== '') return piped;
  }
  throw usage('no prompt provided. Pass a positional arg or pipe via stdin.');
}

function resolveMaxPanes(override: string | undefined): number {
  if (override !== undefined) {
    const n = Number(override);
    if (!Number.isFinite(n) || n < 1) {
      throw usage(`--max-panes must be an integer >= 1 (got: ${override})`);
    }
    return Math.floor(n);
  }
  const cfg = readConfig('user');
  return cfg.max_panes_per_window;
}

function emitDetach(result: ReturnType<typeof spawnAndDetach>, label: string): void {
  if (result.status === 'spawned') {
    const paneLabel = result.paneId === undefined ? '(unknown)' : result.paneId;
    out(`handoff: ${label} launched in pane ${paneLabel}`);
    hint(result.message);
    return;
  }
  if (result.status === 'not-in-tmux') {
    throw usage(result.message);
  }
  throw new Error(result.message);
}

function parseKillAfter(raw: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw usage(`--kill-after must be a non-negative number (got: ${raw})`);
  }
  return n;
}

function baseDetachOpts(): Pick<DetachOptions, 'cwd' | 'placement' | 'killAfterSeconds'> {
  return {
    cwd: process.cwd(),
    placement: 'split-h',
    killAfterSeconds: DEFAULT_KILL_SECS,
  };
}

export function registerAgentCommand(program: Command): void {
  const agent = program
    .command('agent')
    .description('spawn, fork, await, and submit between sibling claude sessions');

  agent
    .command('new [prompt]')
    .description('spawn a fresh claude in a sibling pane; prints session id, returns async')
    .option('--max-panes <n>', 'max panes per window before overflowing to a new window')
    .action(async (prompt: string | undefined, options: { maxPanes?: string }) => {
      try {
        const body = await resolvePrompt(prompt);
        const maxPanes = resolveMaxPanes(options.maxPanes);
        const result = spawnAgent({
          prompt: body,
          cwd: process.cwd(),
          maxPanesPerWindow: maxPanes,
        });
        if (result.status === 'not-in-tmux') throw usage(result.message);
        if (result.status === 'spawn-failed') throw new Error(result.message);
        const sessionId = result.sessionId;
        if (sessionId === undefined) {
          throw new Error('spawn succeeded but no session id returned');
        }
        out(sessionId);
        info(result.message);
        hint(`await with: crtr agent await ${sessionId}`);
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command('fork [prompt]')
    .description(
      'fork the current Claude Code session into a sibling pane with a new prompt; prints session id',
    )
    .option('--max-panes <n>', 'max panes per window before overflowing to a new window')
    .action(async (prompt: string | undefined, options: { maxPanes?: string }) => {
      try {
        const parentSessionId = process.env.CLAUDE_CODE_SESSION_ID;
        if (parentSessionId === undefined || parentSessionId === '') {
          throw usage(
            'crtr agent fork requires $CLAUDE_CODE_SESSION_ID — must run inside Claude Code',
          );
        }
        const body = await resolvePrompt(prompt);
        const maxPanes = resolveMaxPanes(options.maxPanes);
        const result = spawnAgent({
          prompt: body,
          cwd: process.cwd(),
          fork: { sessionId: parentSessionId },
          maxPanesPerWindow: maxPanes,
        });
        if (result.status === 'not-in-tmux') throw usage(result.message);
        if (result.status === 'spawn-failed') throw new Error(result.message);
        const sessionId = result.sessionId;
        if (sessionId === undefined) {
          throw new Error('spawn succeeded but no session id returned');
        }
        out(sessionId);
        info(result.message);
        hint(`await with: crtr agent await ${sessionId}`);
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command('await <id>')
    .description('block until agent <id> calls `crtr agent submit`; prints submitted content')
    .option(
      '--timeout <seconds>',
      `seconds before giving up (default ${DEFAULT_PANE_OPTS.timeoutMs / 1000})`,
    )
    .option('--keep-pane', 'do not kill the child pane after submission')
    .action(async (id: string, options: { timeout?: string; keepPane?: boolean }) => {
      try {
        let timeoutMs = DEFAULT_PANE_OPTS.timeoutMs;
        if (options.timeout !== undefined) {
          const n = Number(options.timeout);
          if (!Number.isFinite(n) || n <= 0) {
            throw usage(`--timeout must be a positive number (got: ${options.timeout})`);
          }
          timeoutMs = Math.floor(n * 1000);
        }
        const killPane = options.keepPane !== true;
        const result = await awaitSession(id, { timeoutMs, killPane });
        if (result.status === 'submitted') {
          process.stdout.write(result.content);
          if (!result.content.endsWith('\n')) process.stdout.write('\n');
          return;
        }
        if (result.status === 'timeout') {
          throw new Error(`agent ${id} did not submit before timeout`);
        }
        if (result.status === 'pane-closed') {
          throw new Error(`agent ${id} pane closed before submission`);
        }
        throw new Error(`agent ${id} await failed: ${result.status}`);
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command('submit [content]')
    .description(
      'inside a crtr-spawned session, deliver content back to the parent (uses $CRTR_PIPE)',
    )
    .action(async (content: string | undefined) => {
      try {
        const sessionDir = process.env.CRTR_PIPE;
        if (sessionDir === undefined || sessionDir === '') {
          throw usage(
            'not in a crtr session — $CRTR_PIPE is not set. ' +
              '`crtr agent submit` is only valid inside a crtr-spawned pane.',
          );
        }
        if (!existsSync(sessionDir)) {
          throw notFound(
            `session directory not found: ${sessionDir} (the parent may have timed out)`,
          );
        }

        let body: string;
        if (content !== undefined) {
          body = content;
        } else if (!process.stdin.isTTY) {
          body = await readStdin();
        } else {
          throw usage(
            'no content provided. Pass content as a positional arg or pipe via stdin.',
          );
        }

        if (body.trim() === '') {
          throw usage('content is empty');
        }

        submitToSession(sessionDir, body);
        out('submitted');
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command('plan')
    .description('launch a planner for an approved spec in a new pane; close current pane')
    .requiredOption('--spec <name>', 'name of the spec to plan')
    .option(
      '--kill-after <seconds>',
      `seconds before closing the originating pane (default ${DEFAULT_KILL_SECS})`,
      String(DEFAULT_KILL_SECS),
    )
    .action((options: { spec: string; killAfter: string }) => {
      try {
        const specPath = artifactPath('specs', options.spec);
        if (!pathExists(specPath)) {
          throw notFound(`spec not found: ${options.spec} (looked at ${specPath})`);
        }
        const killAfter = parseKillAfter(options.killAfter);
        const result = spawnAndDetach({
          ...baseDetachOpts(),
          prompt: planHandoffPrompt(specPath, artifactsRoot('plans')),
          killAfterSeconds: killAfter,
        });
        emitDetach(result, `planner for spec ${options.spec}`);
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command('implement')
    .description('launch an implementer for an approved plan in a new pane; close current pane')
    .requiredOption('--plan <name>', 'name of the plan to implement')
    .option(
      '--kill-after <seconds>',
      `seconds before closing the originating pane (default ${DEFAULT_KILL_SECS})`,
      String(DEFAULT_KILL_SECS),
    )
    .action((options: { plan: string; killAfter: string }) => {
      try {
        const planPath = artifactPath('plans', options.plan);
        if (!pathExists(planPath)) {
          throw notFound(`plan not found: ${options.plan} (looked at ${planPath})`);
        }
        const killAfter = parseKillAfter(options.killAfter);
        const result = spawnAndDetach({
          ...baseDetachOpts(),
          prompt: implementHandoffPrompt(planPath),
          killAfterSeconds: killAfter,
        });
        emitDetach(result, `implementer for plan ${options.plan}`);
      } catch (e) {
        handleError(e);
      }
    });

  agent
    .command('review')
    .description('launch a code reviewer of the working tree in a new pane; close current pane')
    .option(
      '--kill-after <seconds>',
      `seconds before closing the originating pane (default ${DEFAULT_KILL_SECS})`,
      String(DEFAULT_KILL_SECS),
    )
    .action((options: { killAfter: string }) => {
      try {
        const killAfter = parseKillAfter(options.killAfter);
        const result = spawnAndDetach({
          ...baseDetachOpts(),
          prompt: reviewHandoffPrompt(),
          killAfterSeconds: killAfter,
        });
        emitDetach(result, 'code reviewer');
      } catch (e) {
        handleError(e);
      }
    });
}
