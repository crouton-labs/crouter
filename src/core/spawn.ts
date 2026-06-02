// Tmux pane spawning machinery for crtr job subtree.
//
// Kept: spawnAgent (fire-and-forget new pane), spawnAndDetach (used by human.ts for detached panes),
//       shellQuote, isInTmux, countPanesInCurrentWindow, findWindowWithSpace.
//
// Removed: createSession, submitToSession, awaitSession, waitForResult,
//          sessionDirForId, writeSessionMeta, readSessionMeta — all superseded
//          by the jobs.ts sidecar model (result.json + log.jsonl).
//
// Agent-CLI selection: crtr can be hosted by different coding agents (Claude
// Code, pi). `detectAgentKind()` inspects the environment crtr inherited from
// its host and `buildAgentCommand()` emits the matching invocation, so a spawn
// launches a sibling of whatever agent is driving it.
//
// Crash detection: the wrapper shell command is:
//   `<agent invocation>; crtr job _fail <job_id>`
// If the worker calls `crtr job submit` before the agent exits, result.json is
// written and `_fail` is a no-op (writeResult is idempotent for done status).
// If the agent dies without a submit, `_fail` writes status 'failed'. Either way
// `job read result` sees a terminal result.json.

import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// Path to the agent stop-hook extension loaded into every spawned pi agent
// (`pi -e <path>`). Resolved relative to this module so it works from both the
// compiled dist build and `tsx` dev runs.
const STOPHOOK_PATH: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url)); // dist/core or src/core
  const candidates = [
    join(here, '..', 'pi-extensions', 'agent-stophook.js'), // dist build
    join(here, '..', 'pi-extensions', 'agent-stophook.ts'), // tsx dev
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
})();

// Path to the parent-side inbox watcher loaded into every spawned pi agent
// (`pi -e <path>`). Lets a spawned agent that itself spawns children receive
// their completions pushed into its live session (R3/R6). Resolved the same way
// as STOPHOOK_PATH so it works from both the dist build and tsx dev runs.
const INBOX_WATCHER_PATH: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'pi-extensions', 'agent-inbox-watcher.js'), // dist build
    join(here, '..', 'pi-extensions', 'agent-inbox-watcher.ts'), // tsx dev
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
})();

export interface SpawnAgentOptions {
  /** First user message for the new agent session. */
  prompt: string;
  cwd: string;
  /** crtr job_id injected as CRTR_JOB_ID env var in the pane. */
  jobId: string;
  /** If set, resume this Claude Code session with --fork-session (new session id). */
  fork?: { sessionId: string };
  /** Max panes per tmux window before overflowing to a new window. */
  maxPanesPerWindow: number;
  /** Display name passed to the agent's `-n` flag; surfaces in pane title and resume picker. */
  name?: string;
  /** Persona appended via `--append-system-prompt` (subagent body). */
  systemPrompt?: string;
  /** Model pattern/id passed via `--model`. */
  model?: string;
  /** Tool allow-list passed to pi via `--tools`. */
  tools?: string[];
  /** Extra environment variables to inject into the pane alongside CRTR_JOB_ID. */
  env?: Record<string, string>;
  /** Job lifecycle; injected as CRTR_JOB_LIFECYCLE for the stop-hook. */
  lifecycle?: 'worker' | 'persistent';
}

export interface SpawnAgentResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  /** tmux pane id of the spawned pane. */
  paneId?: string;
  /** How the pane was placed. */
  placement?: 'split-window' | 'new-window';
  message: string;
}

export interface DetachOptions {
  /** Inner command to run in the pane. If omitted, build the detected agent's
   *  invocation around `<prompt>`. */
  command?: string;
  /** Full first user message for the new agent session (ignored when `command`
   *  is set). No custom system prompt. */
  prompt?: string;
  cwd: string;
  /** crtr job_id injected as CRTR_JOB_ID env var in the pane and used by the
   *  `_fail` guard. Optional only when `failGuard` is false. */
  jobId?: string;
  /** Where to open the new pane. */
  placement: 'split-h' | 'split-v' | 'new-window';
  /** Seconds to wait before killing the originating pane so the caller can finish. */
  killAfterSeconds: number;
  /** Append `; crtr job _fail <jobId>` and inject CRTR_JOB_ID. Default true. */
  failGuard?: boolean;
  /** Pin the new pane to this tmux pane: split-window splits it; new-window is
   *  inserted immediately after its window (-a -t <pane>). Without this, tmux
   *  uses the attached client's currently-focused pane — which drifts if the
   *  user switches windows between kickoff and spawn. */
  targetPane?: string;
  /** Display name passed to the agent's `-n` flag; ignored when `command` is set
   *  (caller controls the full argv in that mode). */
  name?: string;
}

export interface DetachResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  paneId?: string;
  message: string;
}

export function isInTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Agent CLI selection
// ---------------------------------------------------------------------------

/** Coding-agent CLIs crtr knows how to spawn as a sibling worker. */
export type AgentKind = 'claude' | 'pi';

/**
 * Foreground `comm` names that mark a tmux pane as hosting an interactive
 * agent. claude reports `claude`; pi sets process.title to `pi`. Used by
 * findWindowWithSpace so panes of EITHER agent count as agent panes and a
 * mixed window still qualifies for placement.
 */
const AGENT_COMMS = new Set<string>(['claude', 'pi']);

/**
 * Detect which coding-agent CLI is hosting the current crtr process so spawns
 * launch a matching sibling. pi exports `PI_CODING_AGENT=true` into its tool
 * subprocess environment; Claude Code exports `CLAUDECODE` /
 * `CLAUDE_CODE_SESSION_ID`. Defaults to claude when no signal is present
 * (preserves prior behavior).
 */
export function detectAgentKind(): AgentKind {
  if (process.env.PI_CODING_AGENT === 'true') return 'pi';
  return 'claude';
}

/** Bare Claude-Code model aliases that subagent frontmatter uses. */
const CLAUDE_MODEL_ALIASES = new Set<string>(['sonnet', 'opus', 'haiku']);

/**
 * Normalize a `--model` value for the target agent CLI.
 *
 * Subagent frontmatter uses Claude Code's bare aliases (`sonnet`, `opus`,
 * `haiku`, optionally with a `:thinking` suffix). The `claude` CLI resolves
 * those natively, but `pi` maps a bare alias to its default provider —
 * `amazon-bedrock` — which most users have not authenticated, so the spawn
 * dies with "No API key found for amazon-bedrock". These aliases name Anthropic
 * models, so under pi we pin them to the `anthropic/` provider (preserving any
 * `:thinking` suffix). Values that already carry a `provider/` prefix or are
 * concrete model ids are passed through untouched.
 */
export function normalizeModelForKind(model: string, kind: AgentKind): string {
  if (kind !== 'pi') return model;
  if (model.includes('/')) return model;
  const [base, ...rest] = model.split(':');
  if (!CLAUDE_MODEL_ALIASES.has(base.toLowerCase())) return model;
  const suffix = rest.length > 0 ? `:${rest.join(':')}` : '';
  return `anthropic/${base.toLowerCase()}${suffix}`;
}

export interface AgentCommandOptions {
  /** First user message delivered to the new agent session. */
  prompt: string;
  /** Display name (`-n`); surfaces in the pane title and resume picker. */
  name?: string;
  /** Fork an existing session into a fresh one rather than starting clean. */
  fork?: { sessionId: string };
  /** Persona/system prompt appended to the agent's default (`--append-system-prompt`).
   *  Used to apply a subagent definition's body. */
  systemPrompt?: string;
  /** Model pattern/id passed via `--model` (both claude and pi). */
  model?: string;
  /** Tool allow-list. Passed to pi via `--tools`; ignored for claude, whose
   *  tool names and gating flag differ. */
  tools?: string[];
}

/**
 * Build the agent-CLI invocation (no job wrapper) for the given kind.
 *
 *   claude: `claude [-n <name>] [--resume <id> --fork-session] \
 *            --dangerously-skip-permissions <prompt>`
 *   pi:     `pi [-n <name>] [--fork <id>] <prompt>`
 *
 * pi has no permission popups, so it needs no skip-permissions flag.
 */
export function buildAgentCommand(
  opts: AgentCommandOptions,
  kind: AgentKind = detectAgentKind(),
): string {
  if (kind === 'pi') {
    const parts: string[] = ['pi'];
    // Stop-hook: auto-submit the agent's final message + push live telemetry.
    parts.push('-e', shellQuote(STOPHOOK_PATH));
    // Inbox watcher: push child-completion notices into this agent's session if
    // it spawns its own children (R3/R6).
    parts.push('-e', shellQuote(INBOX_WATCHER_PATH));
    if (opts.name !== undefined && opts.name !== '') {
      parts.push('-n', shellQuote(opts.name));
    }
    if (opts.fork !== undefined) {
      parts.push('--fork', shellQuote(opts.fork.sessionId));
    }
    if (opts.model !== undefined && opts.model !== '') {
      parts.push('--model', shellQuote(normalizeModelForKind(opts.model, 'pi')));
    }
    if (opts.tools !== undefined && opts.tools.length > 0) {
      parts.push('--tools', shellQuote(opts.tools.join(',')));
    }
    if (opts.systemPrompt !== undefined && opts.systemPrompt.trim() !== '') {
      parts.push('--append-system-prompt', shellQuote(opts.systemPrompt));
    }
    parts.push(shellQuote(opts.prompt));
    return parts.join(' ');
  }

  const parts: string[] = ['claude'];
  if (opts.name !== undefined && opts.name !== '') {
    parts.push('-n', shellQuote(opts.name));
  }
  if (opts.fork !== undefined) {
    parts.push('--resume', shellQuote(opts.fork.sessionId), '--fork-session');
  }
  if (opts.model !== undefined && opts.model !== '') {
    parts.push('--model', shellQuote(opts.model));
  }
  if (opts.systemPrompt !== undefined && opts.systemPrompt.trim() !== '') {
    parts.push('--append-system-prompt', shellQuote(opts.systemPrompt));
  }
  parts.push('--dangerously-skip-permissions', shellQuote(opts.prompt));
  return parts.join(' ');
}



export function countPanesInCurrentWindow(): number {
  const result = spawnSync('tmux', ['list-panes', '-F', '#{pane_id}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

interface WindowInfo {
  windowId: string;
  paneCount: number;
  isActive: boolean;
}

function listWindowsInCurrentSession(): WindowInfo[] {
  const result = spawnSync(
    'tmux',
    ['list-windows', '-F', '#{window_id} #{window_panes} #{window_active}'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [id, count, active] = line.split(' ');
      return {
        windowId: id,
        paneCount: Number.parseInt(count, 10),
        isActive: active === '1',
      };
    });
}

/**
 * Map of window_id → list of pane TTYs (basename, e.g. `ttys008`) for every
 * pane in the current tmux session. Used as the bridge between tmux's pane
 * model and the system process table for foreground-command lookup.
 *
 * tmux's `#{pane_current_command}` is unreliable on macOS because the Claude
 * Code CLI sets `process.title` to its version (e.g. `2.1.143`), which is what
 * tmux then reports. Going through the TTY + `ps` gives us the real foreground
 * `comm` (`claude`, or `pi` from its process.title) from the kernel.
 */
function paneTtysByWindow(): Map<string, string[]> {
  const result = spawnSync(
    'tmux',
    ['list-panes', '-s', '-F', '#{window_id} #{pane_tty}'],
    { encoding: 'utf8' },
  );
  const out = new Map<string, string[]>();
  if (result.status !== 0) return out;
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const windowId = line.slice(0, idx);
    const tty = line.slice(idx + 1);
    const ttyBase = tty.startsWith('/dev/') ? tty.slice(5) : tty;
    const existing = out.get(windowId);
    if (existing === undefined) {
      out.set(windowId, [ttyBase]);
    } else {
      existing.push(ttyBase);
    }
  }
  return out;
}

/**
 * Map of tty basename → set of foreground process `comm` names on that tty.
 * A process is "foreground" if its STAT field includes `+` (member of the
 * terminal's foreground process group). Built from one `ps -axo ...` call.
 */
function foregroundCommsByTty(): Map<string, Set<string>> {
  const result = spawnSync('ps', ['-axo', 'stat=,comm=,tty='], { encoding: 'utf8' });
  const out = new Map<string, Set<string>>();
  if (result.status !== 0) return out;
  for (const line of result.stdout.split('\n')) {
    if (line.trim() === '') continue;
    const m = line.match(/^(\S+)\s+(.+?)\s+(\S+)\s*$/);
    if (m === null) continue;
    const [, stat, comm, tty] = m;
    if (!stat.includes('+')) continue;
    if (tty === '??' || tty === '?') continue;
    const existing = out.get(tty);
    if (existing === undefined) {
      out.set(tty, new Set<string>([comm.trim()]));
    } else {
      existing.add(comm.trim());
    }
  }
  return out;
}

/**
 * Find a window in the current tmux session with fewer than `maxPanesPerWindow`
 * panes AND where every existing pane hosts an agent (claude or pi) as its
 * foreground process. Prefers the active window so the spawned pane is visible
 * to the user; otherwise falls back to the first other eligible window. Returns
 * the tmux window id (e.g. `@5`) to pass via `-t`, or null if no window qualifies.
 *
 * Windows holding non-agent panes (dashboards, log tails, idle shells, editors,
 * REPLs, etc.) are skipped so spawning never disrupts those workflows. A pane
 * qualifies as long as an agent comm is among its foreground commands —
 * co-resident helpers like `caffeinate` don't disqualify it.
 */
export function findWindowWithSpace(maxPanesPerWindow: number): string | null {
  const windows = listWindowsInCurrentSession();
  const ttysByWindow = paneTtysByWindow();
  const fgByTty = foregroundCommsByTty();
  const isAgentOnly = (windowId: string): boolean => {
    const ttys = ttysByWindow.get(windowId);
    if (ttys === undefined || ttys.length === 0) return false;
    return ttys.every((tty) => {
      const comms = fgByTty.get(tty);
      if (comms === undefined) return false;
      for (const c of comms) {
        if (AGENT_COMMS.has(c)) return true;
      }
      return false;
    });
  };
  const eligible = windows.filter(
    (w) => w.paneCount < maxPanesPerWindow && isAgentOnly(w.windowId),
  );
  const active = eligible.find((w) => w.isActive);
  if (active !== undefined) return active.windowId;
  const first = eligible[0];
  if (first === undefined) return null;
  return first.windowId;
}

/**
 * Schedule a kill-pane on the *current* tmux pane after `delaySeconds`, detached
 * so the caller can return normally before the pane dies. No-op outside tmux
 * or when TMUX_PANE is unset.
 *
 * Used by `crtr job submit` (kill_pane=true) so an agent can self-close
 * its pane after delivering its verdict, and by `spawnAndDetach` when
 * a detached pane needs to kill its origin after handoff.
 */
export function scheduleKillCurrentPane(delaySeconds: number): boolean {
  const currentPane = process.env.TMUX_PANE;
  if (currentPane === undefined || currentPane === '' || delaySeconds <= 0) {
    return false;
  }
  const killCmd = `sleep ${delaySeconds}; tmux kill-pane -t ${currentPane}`;
  spawnSync('sh', ['-c', `nohup sh -c ${shellQuote(killCmd)} </dev/null >/dev/null 2>&1 &`], {
    stdio: 'ignore',
  });
  return true;
}

/**
 * Build the wrapper shell command passed to the tmux pane.
 *
 * Pattern: `<agent invocation>; crtr job _fail <job_id>`
 *
 * If the worker submits via `crtr job submit` before the agent exits,
 * result.json is already written (`done`); `_fail` sees it and is a no-op.
 * If the agent crashes/exits without submitting, `_fail` writes status `failed`
 * so `job read result` can distinguish completion from crash.
 */
function wrapperCmd(agentCmd: string, jobId: string): string {
  return `${agentCmd}; crtr job _fail ${shellQuote(jobId)}`;
}

/**
 * Fire-and-forget: launch an interactive agent in a new pane (or window),
 * then schedule the originating pane to be killed after `killAfterSeconds`.
 *
 * No custom system prompt — the task is delivered as the first user message.
 * Returns as soon as the new pane is up; does NOT wait for the agent to finish.
 */
export function spawnAndDetach(opts: DetachOptions): DetachResult {
  if (!isInTmux()) {
    return {
      status: 'not-in-tmux',
      message: 'handoff requires tmux (TMUX env var not set)',
    };
  }

  const inner = opts.command !== undefined
    ? opts.command
    : buildAgentCommand({ prompt: opts.prompt as string, name: opts.name });

  const useFailGuard = opts.failGuard !== false;
  const fullCmd = useFailGuard ? wrapperCmd(inner, opts.jobId as string) : inner;

  const splitArgs: string[] = [];
  if (opts.placement === 'new-window') {
    splitArgs.push('new-window');
    if (opts.targetPane !== undefined && opts.targetPane !== '') {
      // -a = insert after target window; -t <pane> resolves to that pane's window.
      splitArgs.push('-a', '-t', opts.targetPane);
    }
  } else {
    splitArgs.push('split-window');
    splitArgs.push(opts.placement === 'split-h' ? '-h' : '-v');
    if (opts.targetPane !== undefined && opts.targetPane !== '') {
      splitArgs.push('-t', opts.targetPane);
    }
  }
  splitArgs.push('-P', '-F', '#{pane_id}');
  splitArgs.push('-c', opts.cwd);
  if (opts.jobId !== undefined) {
    splitArgs.push('-e', `CRTR_JOB_ID=${opts.jobId}`);
  }
  splitArgs.push(fullCmd);

  const split = spawnSync('tmux', splitArgs, { encoding: 'utf8' });
  if (split.status !== 0) {
    const stderrText = split.stderr.trim();
    const msg = stderrText === '' ? 'tmux split-window/new-window failed' : stderrText;
    return { status: 'spawn-failed', message: msg };
  }
  const paneId = split.stdout.trim();

  // Schedule self-kill of the originating pane.
  scheduleKillCurrentPane(opts.killAfterSeconds);

  return {
    status: 'spawned',
    paneId,
    message: `handed off to pane ${paneId}; this pane will close in ${opts.killAfterSeconds}s`,
  };
}

// ---------------------------------------------------------------------------
// Dedicated subagent session
//
// Every subagent crtr spawns lands in a tmux session dedicated to the pi/claude
// session that launched it, instead of splitting the user's working window. The
// session is keyed on the originating pane ($TMUX_PANE) so it is reused across
// spawns for the life of that pane. Spawns are interactive (headed) panes but
// never steal focus — the user jumps to the session with Alt-o.
//
// Navigation state is written as tmux user-options so a keybinding can toggle
// between the two without crtr involvement:
//   - origin session:   @crtr_subagent_session = <subagent session name>
//   - subagent session: @crtr_origin_session   = <origin session id>
//                       @crtr_origin_pane      = <origin pane id>
// ---------------------------------------------------------------------------

function tmuxQuery(args: string[]): string | null {
  const r = spawnSync('tmux', args, { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

/** Originating pane id + session id of the host (pi/claude) crtr runs under. */
export function originContext(): { pane: string; sessionId: string } | null {
  const pane = process.env.TMUX_PANE;
  if (pane === undefined || pane === '') return null;
  const sessionId = tmuxQuery(['display-message', '-p', '-t', pane, '#{session_id}']);
  if (sessionId === null || sessionId === '') return null;
  return { pane, sessionId };
}

/** Deterministic subagent session name for an originating pane id (e.g. `%5`). */
export function subagentSessionName(pane: string): string {
  return `crtr-agents-${pane.replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** A window in `session` with fewer than `maxPanes` panes (active preferred). */
function findWindowWithSpaceInSession(session: string, maxPanes: number): string | null {
  const r = spawnSync(
    'tmux',
    ['list-windows', '-t', session, '-F', '#{window_id} #{window_panes} #{window_active}'],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) return null;
  const wins = r.stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const [id, count, active] = l.split(' ');
      return { id, count: Number.parseInt(count, 10), active: active === '1' };
    });
  const eligible = wins.filter((w) => w.count < maxPanes);
  const active = eligible.find((w) => w.active);
  if (active !== undefined) return active.id;
  return eligible[0]?.id ?? null;
}

interface PlaceResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  paneId?: string;
  session?: string;
  placement?: 'new-session' | 'split-window' | 'new-window';
  message: string;
}

/**
 * Ensure the dedicated subagent session exists and launch `fullCmd` in it,
 * filling windows up to `maxPanes` before opening a new window. Records the
 * cross-session navigation options on both sides. Never switches focus — the
 * user navigates to the subagent session themselves (Alt-o).
 */
function placeInSubagentSession(opts: {
  fullCmd: string;
  jobId?: string;
  lifecycle?: string;
  env?: Record<string, string>;
  cwd: string;
  maxPanes: number;
}): PlaceResult {
  if (!isInTmux()) {
    return { status: 'not-in-tmux', message: 'requires tmux (TMUX env var not set)' };
  }
  const origin = originContext();
  if (origin === null) {
    return { status: 'not-in-tmux', message: 'requires tmux (TMUX_PANE not set)' };
  }
  const session = subagentSessionName(origin.pane);
  const envMap: Record<string, string> = {};
  if (opts.jobId !== undefined) envMap['CRTR_JOB_ID'] = opts.jobId;
  if (opts.lifecycle !== undefined) envMap['CRTR_JOB_LIFECYCLE'] = opts.lifecycle;
  // Home tmux session + originating (parent) pane. The agent stop-hook uses these
  // to detect when its pane has been relocated out of its home session (e.g.
  // swap-pane'd onto the parent's slot by a UI) and to restore the parent there
  // before the agent exits, so it never closes someone else's pane slot.
  envMap['CRTR_AGENT_SESSION'] = session;
  envMap['CRTR_ROOT_PANE'] = origin.pane;
  if (opts.env !== undefined) Object.assign(envMap, opts.env);
  const envArgs = Object.entries(envMap).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
  const exists = spawnSync('tmux', ['has-session', '-t', session], { encoding: 'utf8' }).status === 0;

  let paneId: string;
  let placement: PlaceResult['placement'];
  if (!exists) {
    const r = spawnSync(
      'tmux',
      ['new-session', '-d', '-s', session, '-c', opts.cwd, '-P', '-F', '#{pane_id}', ...envArgs, opts.fullCmd],
      { encoding: 'utf8' },
    );
    if (r.status !== 0) {
      return { status: 'spawn-failed', message: r.stderr.trim() || 'tmux new-session failed' };
    }
    paneId = r.stdout.trim();
    placement = 'new-session';
  } else {
    const targetWindow = findWindowWithSpaceInSession(session, opts.maxPanes);
    if (targetWindow === null) {
      const r = spawnSync(
        'tmux',
        ['new-window', '-t', session, '-c', opts.cwd, '-P', '-F', '#{pane_id}', ...envArgs, opts.fullCmd],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) {
        return { status: 'spawn-failed', message: r.stderr.trim() || 'tmux new-window failed' };
      }
      paneId = r.stdout.trim();
      placement = 'new-window';
    } else {
      const r = spawnSync(
        'tmux',
        ['split-window', '-h', '-t', targetWindow, '-c', opts.cwd, '-P', '-F', '#{pane_id}', ...envArgs, opts.fullCmd],
        { encoding: 'utf8' },
      );
      if (r.status !== 0) {
        return { status: 'spawn-failed', message: r.stderr.trim() || 'tmux split-window failed' };
      }
      paneId = r.stdout.trim();
      placement = 'split-window';
      spawnSync('tmux', ['select-layout', '-t', paneId, 'even-horizontal'], { encoding: 'utf8' });
    }
  }

  // Record navigation state for the M-o toggle keybinding.
  spawnSync('tmux', ['set-option', '-t', origin.sessionId, '@crtr_subagent_session', session], { encoding: 'utf8' });
  spawnSync('tmux', ['set-option', '-t', session, '@crtr_origin_session', origin.sessionId], { encoding: 'utf8' });
  spawnSync('tmux', ['set-option', '-t', session, '@crtr_origin_pane', origin.pane], { encoding: 'utf8' });

  return {
    status: 'spawned',
    paneId,
    session,
    placement,
    message: `agent spawned in pane ${paneId} of session ${session} (${placement})`,
  };
}

/**
 * Pull `targetPane` out of its current session/window into the caller's window
 * as a horizontal split alongside `callerPane`, then tidy the layout.
 *
 * Wraps `tmux join-pane -h -s <targetPane> -t <callerPane>` followed by
 * `tmux select-layout -t <callerPane> even-horizontal`. Returns `{ ok, message }`
 * so the command layer stays thin and the tmux specifics are unit-testable.
 */
export function joinPane(
  targetPane: string,
  callerPane: string,
): { ok: boolean; message: string } {
  const join = spawnSync('tmux', ['join-pane', '-h', '-s', targetPane, '-t', callerPane], {
    encoding: 'utf8',
  });
  if (join.status !== 0) {
    const msg = join.stderr.trim() || 'tmux join-pane failed';
    return { ok: false, message: msg };
  }
  // Normalise the layout so both panes split evenly.
  spawnSync('tmux', ['select-layout', '-t', callerPane, 'even-horizontal'], { encoding: 'utf8' });
  return { ok: true, message: `joined pane ${targetPane} into window of ${callerPane}` };
}

/**
 * Async sibling spawn. Launches an interactive agent (claude or pi, per
 * detectAgentKind) in the dedicated subagent session, progressively filling
 * windows up to `maxPanesPerWindow` before creating a new window. Returns
 * immediately with the pane id; the parent stays alive. Focus is never
 * switched — the user jumps to the subagent session with Alt-o.
 *
 * If `fork` is set, forks the host session into a fresh one.
 */
export function spawnAgent(opts: SpawnAgentOptions): SpawnAgentResult {
  if (!isInTmux()) {
    return {
      status: 'not-in-tmux',
      message: 'crtr job requires tmux (TMUX env var not set)',
    };
  }

  const agentCmd = buildAgentCommand({
    prompt: opts.prompt,
    name: opts.name,
    fork: opts.fork,
    systemPrompt: opts.systemPrompt,
    model: opts.model,
    tools: opts.tools,
  });

  const fullCmd = wrapperCmd(agentCmd, opts.jobId);
  const placed = placeInSubagentSession({
    fullCmd,
    jobId: opts.jobId,
    lifecycle: opts.lifecycle,
    env: opts.env,
    cwd: opts.cwd,
    maxPanes: opts.maxPanesPerWindow,
  });

  return {
    status: placed.status,
    paneId: placed.paneId,
    placement: placed.placement === 'split-window' ? 'split-window' : 'new-window',
    message: placed.message,
  };
}


