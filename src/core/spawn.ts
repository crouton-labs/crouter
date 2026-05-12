import { spawnSync } from 'node:child_process';
import { mkdirSync, watch, readFileSync, existsSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { general, notFound } from './errors.js';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PANE_POLL_MS = 2000;

export interface SidePaneOptions {
  /** Full first user message — task + checklist + submit instructions all in one. */
  prompt: string;
  cwd: string;
  timeoutMs: number;
}

export const DEFAULT_PANE_OPTS = {
  timeoutMs: DEFAULT_TIMEOUT_MS,
};

export type SidePaneStatus = 'submitted' | 'timeout' | 'pane-closed' | 'spawn-failed';

export interface SidePaneResult {
  status: SidePaneStatus;
  content: string;
  paneId?: string;
  sessionDir: string;
}

function isInTmux(): boolean {
  return Boolean(process.env.TMUX);
}

function sessionRoot(): string {
  const root = join(tmpdir(), 'crtr-sessions');
  mkdirSync(root, { recursive: true });
  return root;
}

export function createSession(): { id: string; dir: string } {
  const id = randomUUID();
  const dir = join(sessionRoot(), id);
  mkdirSync(dir, { recursive: true });
  return { id, dir };
}

export function submitToSession(sessionDir: string, content: string): void {
  const tmp = join(sessionDir, '.content.tmp');
  const final = join(sessionDir, 'content');
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, final);
}

function paneAlive(paneId: string): boolean {
  const result = spawnSync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return false;
  return result.stdout.split('\n').some((line) => line.trim() === paneId);
}

function killPane(paneId: string): void {
  spawnSync('tmux', ['kill-pane', '-t', paneId], { stdio: 'ignore' });
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

export interface DetachOptions {
  /** Full first user message for the new claude session. No custom system prompt. */
  prompt: string;
  cwd: string;
  /** Where to open the new pane. */
  placement: 'split-h' | 'split-v' | 'new-window';
  /** Seconds to wait before killing the originating pane so the caller can finish. */
  killAfterSeconds: number;
}

export interface DetachResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  paneId?: string;
  message: string;
}

/**
 * Fire-and-forget: launch an interactive `claude` in a new pane (or window),
 * then schedule the originating pane to be killed after `killAfterSeconds`.
 *
 * No custom system prompt — the task is delivered as the first user message
 * so the user can `/clear` to fall back to a normal default Claude session.
 *
 * Returns as soon as the new pane is up; does NOT wait for claude to finish.
 */
export function spawnAndDetach(opts: DetachOptions): DetachResult {
  if (!isInTmux()) {
    return {
      status: 'not-in-tmux',
      message: 'handoff requires tmux (TMUX env var not set)',
    };
  }

  const claudeCmd = [
    'claude',
    '--dangerously-skip-permissions',
    shellQuote(opts.prompt),
  ].join(' ');

  const splitArgs: string[] = [];
  if (opts.placement === 'new-window') {
    splitArgs.push('new-window');
  } else {
    splitArgs.push('split-window');
    splitArgs.push(opts.placement === 'split-h' ? '-h' : '-v');
  }
  splitArgs.push('-P', '-F', '#{pane_id}');
  splitArgs.push('-c', opts.cwd);
  splitArgs.push(claudeCmd);

  const split = spawnSync('tmux', splitArgs, { encoding: 'utf8' });
  if (split.status !== 0) {
    const stderrText = split.stderr.trim();
    const msg = stderrText === '' ? 'tmux split-window/new-window failed' : stderrText;
    return { status: 'spawn-failed', message: msg };
  }
  const paneId = split.stdout.trim();

  // Schedule self-kill of the originating pane. We detach this so it survives
  // crtr's exit.
  const currentPane = process.env.TMUX_PANE;
  if (currentPane !== undefined && currentPane !== '' && opts.killAfterSeconds > 0) {
    const killCmd = `sleep ${opts.killAfterSeconds}; tmux kill-pane -t ${currentPane}`;
    spawnSync('sh', ['-c', `nohup sh -c ${shellQuote(killCmd)} </dev/null >/dev/null 2>&1 &`], {
      stdio: 'ignore',
    });
  }

  return {
    status: 'spawned',
    paneId,
    message: `handed off to pane ${paneId}; this pane will close in ${opts.killAfterSeconds}s`,
  };
}

/**
 * Spawn a side-pane `claude` reviewer. Blocks until the reviewer calls
 * `crtr agent submit <content>`, the 10-min budget elapses, or the pane is closed.
 *
 * No custom system prompt — the task is delivered as the first user message
 * so the reviewer is a normal Claude session running a single task.
 */
export async function spawnSidePaneReview(opts: SidePaneOptions): Promise<SidePaneResult> {
  if (!isInTmux()) {
    throw general('side-pane review requires tmux (TMUX env var not set)');
  }

  const session = createSession();
  const timeoutMs = opts.timeoutMs;
  const cwd = opts.cwd;

  const claudeCmd = [
    'claude',
    '-p',
    '--dangerously-skip-permissions',
    shellQuote(opts.prompt),
  ].join(' ');

  // After claude exits, sleep briefly so the watcher can confirm submission.
  // The watcher kills the pane anyway once content arrives.
  const fullCmd = `cd ${shellQuote(cwd)} && ${claudeCmd}; sleep 2`;

  const splitArgs = [
    'split-window',
    '-h',
    '-P',
    '-F',
    '#{pane_id}',
    '-e',
    `CRTR_SESSION=${session.id}`,
    '-e',
    `CRTR_PIPE=${session.dir}`,
    fullCmd,
  ];
  const split = spawnSync('tmux', splitArgs, { encoding: 'utf8' });
  if (split.status !== 0) {
    rmSync(session.dir, { recursive: true, force: true });
    const stderrText = split.stderr.trim();
    const msg = stderrText === '' ? 'tmux split-window failed' : stderrText;
    return {
      status: 'spawn-failed',
      content: msg,
      sessionDir: session.dir,
    };
  }
  const paneId = split.stdout.trim();

  const contentPath = join(session.dir, 'content');

  const result = await waitForResult(session.dir, contentPath, paneId, timeoutMs);

  if (paneAlive(paneId)) killPane(paneId);
  try {
    rmSync(session.dir, { recursive: true, force: true });
  } catch {
    /* noop */
  }

  return { ...result, paneId, sessionDir: session.dir };
}

export interface SpawnAgentOptions {
  /** First user message for the new claude session. */
  prompt: string;
  cwd: string;
  /** If set, resume this Claude Code session with --fork-session (new session id). */
  fork?: { sessionId: string };
  /** Max panes per tmux window before overflowing to a new window. */
  maxPanesPerWindow: number;
}

export interface SpawnAgentResult {
  status: 'spawned' | 'spawn-failed' | 'not-in-tmux';
  /** crtr session UUID — pass to `crtr agent await` to receive the result. */
  sessionId?: string;
  /** tmux pane id of the spawned pane. */
  paneId?: string;
  /** How the pane was placed. */
  placement?: 'split-window' | 'new-window';
  message: string;
}

interface SessionMeta {
  paneId: string;
  createdAt: number;
  kind: 'new' | 'fork';
}

function metaPath(sessionDir: string): string {
  return join(sessionDir, 'meta.json');
}

function writeSessionMeta(sessionDir: string, meta: SessionMeta): void {
  writeFileSync(metaPath(sessionDir), JSON.stringify(meta), 'utf8');
}

function readSessionMeta(sessionDir: string): SessionMeta | undefined {
  const p = metaPath(sessionDir);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SessionMeta;
  } catch {
    return undefined;
  }
}

export function sessionDirForId(sessionId: string): string {
  return join(sessionRoot(), sessionId);
}

export function countPanesInCurrentWindow(): number {
  // -t '' targets the current window of the current session.
  const result = spawnSync('tmux', ['list-panes', '-F', '#{pane_id}'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return 0;
  return result.stdout.split('\n').filter((line) => line.trim() !== '').length;
}

/**
 * Async sibling spawn. Launches a claude session in a new tmux pane or window
 * (depending on current pane count vs maxPanesPerWindow). Returns immediately
 * with the crtr session id; the parent stays alive.
 *
 * If `fork` is set, uses `claude --resume <id> --fork-session` so the child
 * gets a fresh session id and does not contend with the parent's JSONL.
 */
export function spawnAgent(opts: SpawnAgentOptions): SpawnAgentResult {
  if (!isInTmux()) {
    return {
      status: 'not-in-tmux',
      message: 'crtr agent requires tmux (TMUX env var not set)',
    };
  }

  const session = createSession();

  const claudeParts: string[] = ['claude'];
  if (opts.fork !== undefined) {
    claudeParts.push('--resume', opts.fork.sessionId, '--fork-session');
  }
  claudeParts.push('--dangerously-skip-permissions', shellQuote(opts.prompt));
  const claudeCmd = claudeParts.join(' ');

  const useNewWindow = countPanesInCurrentWindow() >= opts.maxPanesPerWindow;
  const placement: 'split-window' | 'new-window' = useNewWindow ? 'new-window' : 'split-window';

  const tmuxArgs: string[] = [placement];
  if (!useNewWindow) tmuxArgs.push('-h');
  tmuxArgs.push(
    '-P',
    '-F',
    '#{pane_id}',
    '-c',
    opts.cwd,
    '-e',
    `CRTR_SESSION=${session.id}`,
    '-e',
    `CRTR_PIPE=${session.dir}`,
    claudeCmd,
  );

  const split = spawnSync('tmux', tmuxArgs, { encoding: 'utf8' });
  if (split.status !== 0) {
    rmSync(session.dir, { recursive: true, force: true });
    const stderrText = split.stderr.trim();
    const msg = stderrText === '' ? `tmux ${placement} failed` : stderrText;
    return { status: 'spawn-failed', message: msg };
  }
  const paneId = split.stdout.trim();

  writeSessionMeta(session.dir, {
    paneId,
    createdAt: Date.now(),
    kind: opts.fork !== undefined ? 'fork' : 'new',
  });

  return {
    status: 'spawned',
    sessionId: session.id,
    paneId,
    placement,
    message: `agent ${session.id} spawned in pane ${paneId} (${placement})`,
  };
}

export interface AwaitOptions {
  timeoutMs: number;
  /** Kill the child pane after content is received. Default true. */
  killPane: boolean;
}

/**
 * Block until the agent identified by `sessionId` calls `crtr agent submit`.
 * Returns content + status. Cleans up the session dir on completion.
 */
export async function awaitSession(
  sessionId: string,
  opts: AwaitOptions,
): Promise<SidePaneResult> {
  const sessionDir = sessionDirForId(sessionId);
  if (!existsSync(sessionDir)) {
    throw notFound(`agent session not found: ${sessionId} (looked at ${sessionDir})`);
  }

  const meta = readSessionMeta(sessionDir);
  let paneId: string | undefined;
  if (meta !== undefined && meta.paneId !== '') {
    paneId = meta.paneId;
  }
  const contentPath = join(sessionDir, 'content');

  const result = await waitForResult(sessionDir, contentPath, paneId, opts.timeoutMs);

  if (opts.killPane && paneId !== undefined && paneAlive(paneId)) killPane(paneId);
  try {
    rmSync(sessionDir, { recursive: true, force: true });
  } catch {
    /* noop */
  }

  return { ...result, paneId, sessionDir };
}

function waitForResult(
  sessionDir: string,
  contentPath: string,
  paneId: string | undefined,
  timeoutMs: number,
): Promise<Pick<SidePaneResult, 'status' | 'content'>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: SidePaneStatus, content: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (paneTimer !== undefined) clearInterval(paneTimer);
      try {
        watcher.close();
      } catch {
        /* noop */
      }
      resolve({ status, content });
    };

    const watcher = watch(sessionDir, (_event, name) => {
      if (name === 'content' && existsSync(contentPath)) {
        const content = readFileSync(contentPath, 'utf8');
        finish('submitted', content);
      }
    });

    if (existsSync(contentPath)) {
      finish('submitted', readFileSync(contentPath, 'utf8'));
      return;
    }

    const timeoutTimer = setTimeout(() => {
      finish('timeout', '');
    }, timeoutMs);

    let paneTimer: NodeJS.Timeout | undefined;
    if (paneId !== undefined) {
      const watchedPaneId = paneId;
      paneTimer = setInterval(() => {
        if (!paneAlive(watchedPaneId)) {
          if (existsSync(contentPath)) {
            finish('submitted', readFileSync(contentPath, 'utf8'));
          } else {
            finish('pane-closed', '');
          }
        }
      }, PANE_POLL_MS);
    }
  });
}
