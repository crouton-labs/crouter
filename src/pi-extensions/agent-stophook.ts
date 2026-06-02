// crtr agent stop-hook.
//
// Loaded into crtr-spawned pi agents via `pi -e <this file>` (wired in
// buildAgentCommand, ../core/spawn.ts). It is INERT in a normal pi session — it
// only activates when CRTR_JOB_ID is present, i.e. when this pi process is a
// crtr-spawned agent.
//
// It does two things, removing the old "agent must call `crtr job submit`"
// contract and fixing always-zero telemetry:
//   - turn_end:  push live token telemetry onto the job record (so the agent
//                bar / `job read` show real token counts as work happens).
//   - agent_end: submit the agent's final assistant message as the result and
//                exit pi cleanly (the tmux pane then auto-closes).
//
// Deliberately written as plain JS-with-types (no imports from @earendil-works/*)
// so it compiles inside crouter's own tsc build without taking a dependency on
// the pi packages. Shapes used here are verified against pi's types:
//   turn_end  event: { message: AssistantMessage, ... }
//   agent_end event: { messages: AgentMessage[] }
//   AssistantMessage: { role:'assistant', content:(TextContent|...)[], usage:{input,output,...}, model }
//   ctx.shutdown(): exits pi.

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

type PiEvents = 'turn_end' | 'agent_end';
interface PiLike {
  on: (event: PiEvents, handler: (event: any, ctx: any) => void | Promise<void>) => void;
}

/** Injectable spawn dependencies — exposed for testing via __testing. */
export interface SpawnDeps {
  spawnSyncFn: typeof spawnSync;
  spawnFn: typeof spawn;
}

function resolveMetaLifecycle(jobId: string): string | undefined {
  try {
    const xdg = process.env['XDG_STATE_HOME'];
    const base = (xdg !== undefined && xdg !== '') ? xdg : join(homedir(), '.local', 'state');
    const metaPath = join(base, 'crtr', 'jobs', jobId, 'meta.json');
    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as { lifecycle?: string };
    return meta.lifecycle;
  } catch {
    return undefined;
  }
}

/**
 * Build and register the turn_end / agent_end handlers on `pi` for `jobId`.
 * Exported (via `__testing`) so tests can drive the handlers with injectable
 * spawn functions without calling the real crtr binary.
 */
export function registerHandlers(
  pi: PiLike,
  jobId: string,
  deps: SpawnDeps,
): void {
  const { spawnSyncFn, spawnFn } = deps;

  let totalIn = 0;
  let totalOut = 0;
  let model = '';
  let done = false;

  const accumulate = (msg: any): void => {
    if (!msg || msg.role !== 'assistant' || !msg.usage) return;
    totalIn += Number(msg.usage.input ?? 0) || 0;
    totalOut += Number(msg.usage.output ?? 0) || 0;
    if (typeof msg.model === 'string' && msg.model !== '') model = msg.model;
  };

  const pushTelemetry = (sync: boolean): void => {
    const args = ['job', 'telemetry', jobId, '--tokens-in', String(totalIn), '--tokens-out', String(totalOut)];
    if (model !== '') args.push('--model', model);
    try {
      if (sync) {
        spawnSyncFn('crtr', args, { stdio: 'ignore', timeout: 5000 });
      } else {
        const child = spawnFn('crtr', args, { stdio: 'ignore', detached: true });
        child.on('error', () => {});
        child.unref();
      }
    } catch {
      /* telemetry is best-effort */
    }
  };

  // Live telemetry: refresh token counts after every assistant turn.
  pi.on('turn_end', (event: any) => {
    accumulate(event?.message);
    pushTelemetry(false);
  });

  // Stop hook: the agent finished responding — gate on lifecycle then either
  // stay live (persistent) or submit and exit (worker).
  pi.on('agent_end', (event: any, ctx: any) => {
    if (done) return;

    const messages: any[] = Array.isArray(event?.messages) ? event.messages : [];
    for (const m of messages) accumulate(m);

    // Resolve effective lifecycle by reading meta.json on every stop so that
    // Phase 5 can flip a live agent persistent→worker and have its next stop
    // finalize it. Guard in try/catch — a missing or locked meta never wedges
    // the agent.
    const metaLifecycle = resolveMetaLifecycle(jobId);
    const effectiveLifecycle = metaLifecycle ?? process.env['CRTR_JOB_LIFECYCLE'] ?? 'worker';

    if (effectiveLifecycle === 'persistent') {
      // Persistent agent: push telemetry and stay live — no submit, no shutdown.
      pushTelemetry(true);
      return;
    }

    // Worker path (default): submit the final message and exit.
    pushTelemetry(true);

    // The result is the last assistant message.
    let last: any;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i] && messages[i].role === 'assistant') {
        last = messages[i];
        break;
      }
    }

    // Only auto-submit on a NATURAL end of turn. On an interrupt ('aborted', e.g.
    // the user hitting Esc or the agent-bar wrap-up) or a provider 'error', stay
    // alive and inert so the agent can be steered — a later natural completion
    // submits then. This is what makes the bar's `x` (Esc + 'wrap it up') work
    // instead of submitting a half-finished turn and closing the pane.
    const reason = last?.stopReason;
    if (reason !== 'stop' && reason !== 'length') return;

    done = true;

    const text = last
      ? (Array.isArray(last.content) ? last.content : [])
          .filter((c: any) => c && c.type === 'text' && typeof c.text === 'string')
          .map((c: any) => c.text)
          .join('\n')
          .trim()
      : '';

    try {
      if (text !== '') {
        spawnSyncFn('crtr', ['job', 'submit', jobId], {
          input: text,
          stdio: ['pipe', 'ignore', 'ignore'],
          timeout: 10000,
        });
      } else {
        spawnSyncFn('crtr', ['job', 'submit', jobId, '--status', 'failed', '--reason', 'agent ended with no final text'], {
          stdio: 'ignore',
          timeout: 10000,
        });
      }
    } catch {
      /* best-effort; the spawn wrapper's `crtr job _fail` is the backstop */
    }

    // Completion notification is no longer fired here. `crtr job submit` (above)
    // drives the centralized notify in the jobs layer (jobs.ts notifyReportTo),
    // which delivers to every report_to parent recorded in meta.json — uniformly
    // across all four terminal-transition paths, idempotently. See spec
    // auto-inject-job-completion R2.

    // If our pane has been relocated out of its home tmux session (e.g. an
    // agent-bar UI swap-pane'd us onto the parent's slot to view us full-screen),
    // restore the parent to that slot before we exit. Otherwise our pane would
    // close on the parent's stage and strand the parent in our old slot. This is
    // a safe no-op whenever we're still in our home session.
    try {
      const me = process.env.TMUX_PANE;
      const rootPane = process.env.CRTR_ROOT_PANE;
      const homeSession = process.env.CRTR_AGENT_SESSION;
      if (me && rootPane && homeSession) {
        const cur = spawnSyncFn('tmux', ['display', '-p', '-t', me, '#{session_name}'], {
          encoding: 'utf8',
          timeout: 3000,
        });
        const curSession = ((cur as any).stdout || '').trim();
        if (curSession !== '' && curSession !== homeSession) {
          spawnSyncFn('tmux', ['swap-pane', '-s', rootPane, '-t', me], { stdio: 'ignore', timeout: 3000 });
        }
      }
    } catch {
      /* best-effort */
    }

    // Exit pi; the tmux pane closes when the process ends.
    try {
      ctx?.shutdown?.();
    } catch {
      /* ignore */
    }
  });
}

export default function agentStopHook(pi: PiLike): void {
  const jobId = process.env.CRTR_JOB_ID;
  if (!jobId || jobId.trim() === '') return; // normal pi session — stay inert

  registerHandlers(pi, jobId, { spawnSyncFn: spawnSync, spawnFn: spawn });
}

/** For tests: injectable spawn deps + resolveMetaLifecycle helper. */
export const __testing = { registerHandlers, resolveMetaLifecycle };
