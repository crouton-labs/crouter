#!/usr/bin/env node
// fake-pi-host.ts — a deterministic stand-in for the pi LLM vehicle.
//
// This is NOT an LLM and NOT a mock of the extensions. It is the real pi
// vehicle's place in the system, occupied by a tiny event driver that loads the
// REAL canvas extensions (the `-e <path>` modules the runtime put in our argv)
// and fires REAL lifecycle events under harness control, so the real hooks
// drive real canvas state across the process boundary.
//
// The runtime exec's us exactly where it would exec `pi`, via the CRTR_PI_BINARY
// seam in piCommand (src/core/runtime/tmux.ts). We therefore receive:
//   • argv:  -e <ext> … -n <label> [--session <path>] [--model …] [--tools …]
//            [--append-system-prompt <file>] [<kickoff prompt>]   (buildPiArgv)
//   • env:   CRTR_NODE_ID, CRTR_KIND, CRTR_MODE, CRTR_LIFECYCLE, CRTR_HOME,
//            CRTR_PARENT_NODE_ID, CRTR_ROOT_SESSION, CRTR_FRONT_DOOR  (tmux -e)
//
// Run under tsx (so the `-e` paths resolve to the same .ts modules the CLI
// referenced when launched via `node --import tsx/esm src/cli.ts`).
//
// Control channel (one-way, polled file under the node dir):
//   <CRTR_HOME>/nodes/<id>/fake-pi.cmd   — harness writes one JSON command
//   <CRTR_HOME>/nodes/<id>/fake-pi.ack   — host appends an ack per command
// Proof / observability the harness reads:
//   <CRTR_HOME>/nodes/<id>/fake-pi.boot.json     — argv + env + loaded exts (latest boot)
//   <CRTR_HOME>/nodes/<id>/fake-pi.boots.jsonl    — append-only, one line per boot
//   <CRTR_HOME>/nodes/<id>/fake-pi.events.jsonl   — append-only, one line per fired event
//   <CRTR_HOME>/nodes/<id>/fake-pi.injected.jsonl — every sendUserMessage
//   <CRTR_HOME>/nodes/<id>/fake-pi.error          — any boot/import failure

import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const env = process.env;
const nodeId = (env['CRTR_NODE_ID'] ?? '').trim();
const home = (env['CRTR_HOME'] ?? '').trim();
const rawArgv = process.argv.slice(2); // everything after `node host.ts`

function recordError(msg: string): void {
  try {
    if (home && nodeId) {
      const dir = join(home, 'nodes', nodeId);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, 'fake-pi.error'), msg + '\n');
    }
  } catch {
    /* best effort */
  }
  try {
    process.stderr.write('[fake-pi] ' + msg + '\n');
  } catch {
    /* ignore */
  }
}

function fail(msg: string): never {
  recordError(msg);
  process.exit(17);
}

if (nodeId === '') fail('CRTR_NODE_ID missing in env');
if (home === '') fail('CRTR_HOME missing in env');

const nodeDir = join(home, 'nodes', nodeId);
mkdirSync(nodeDir, { recursive: true });

// --- parse the argv the runtime built (buildPiArgv → piCommand) ------------
const extPaths: string[] = [];
let sessionArg: string | undefined;
let label: string | undefined;
let prompt: string | undefined;
for (let i = 0; i < rawArgv.length; i++) {
  const a = rawArgv[i]!;
  if (a === '-e') extPaths.push(rawArgv[++i]!);
  else if (a === '-n') label = rawArgv[++i]!;
  else if (a === '--session') sessionArg = rawArgv[++i]!;
  else if (a === '--model' || a === '--tools' || a === '--append-system-prompt' || a === '--fork') i++;
  else if (!a.startsWith('-')) prompt = a; // positional kickoff (fresh start only)
}

const resuming = sessionArg !== undefined;
const sessionId = sessionArg ?? `fake-sess-${nodeId}-${Date.now()}`;
const sessionFile = join(nodeDir, 'fake-session.jsonl');
if (!existsSync(sessionFile)) writeFileSync(sessionFile, '');

// --- the faithful fake pi object (multi-handler `on`, real sendUserMessage) --
type Handler = (ev: unknown, ctx: unknown) => void | Promise<void>;
const handlers: Record<string, Handler[]> = {};
let shutdownRequested = false;
let streaming = false;
const injected: { content: string; deliverAs?: string }[] = [];

function recordInjected(rec: { content: string; deliverAs?: string }): void {
  injected.push(rec);
  try {
    appendFileSync(
      join(nodeDir, 'fake-pi.injected.jsonl'),
      JSON.stringify({ ...rec, ts: Date.now() }) + '\n',
    );
  } catch {
    /* best effort */
  }
}

// The faithful pi vehicle surface — the union of every method the 7 canvas
// extensions call at register time. `on` + `sendUserMessage` carry the
// lifecycle behavior under test; the rest are recording stubs so the chrome
// extensions (context-intro renderer, commands/nav slash-commands, goal-capture
// session name) register without throwing, exactly as they would against real pi.
const pi = {
  on(event: string, h: Handler): void {
    (handlers[event] ??= []).push(h);
  },
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void {
    recordInjected({ content, deliverAs: options?.deliverAs });
  },
  sendMessage(message: unknown, options?: { deliverAs?: string; triggerTurn?: boolean }): void {
    recordInjected({ content: JSON.stringify(message), deliverAs: options?.deliverAs });
  },
  registerMessageRenderer(_customType: string, _renderer: unknown): void {
    /* spike: no-op recording stub */
  },
  registerCommand(_name: string, _options: unknown): void {
    /* spike: no-op recording stub */
  },
  registerShortcut(_shortcut: string, _options: unknown): void {
    /* spike: no-op recording stub */
  },
  setSessionName(_name: string): void {
    /* spike: no-op recording stub */
  },
};

let eventSeq = 0;

// Append a durable record of every fired event BEFORE its handlers run. This is
// the harness's robust "the host received my command and is dispatching it"
// signal — it survives even when a handler tears the process down mid-flight
// (e.g. agent_end on a refresh/done node drives the broker shutdown), which is
// exactly the case where an after-the-fact ack would be lost.
function recordEvent(event: string, ev: unknown): void {
  try {
    const reason = (ev as { reason?: string } | null)?.reason;
    appendFileSync(
      join(nodeDir, 'fake-pi.events.jsonl'),
      JSON.stringify({ seq: ++eventSeq, event, reason: reason ?? null, ts: Date.now() }) + '\n',
    );
  } catch {
    /* best effort */
  }
}

async function fire(event: string, ev: unknown, ctx: unknown): Promise<void> {
  recordEvent(event, ev);
  for (const h of handlers[event] ?? []) {
    try {
      await h(ev, ctx);
    } catch (e) {
      recordError(`handler ${event} threw: ${String(e)}`);
    }
  }
}

// The minimum fake-ctx shape (union across both focus extensions), all
// dereferenced defensively by the hooks (ctx?.x?.()).
const ctx = {
  sessionManager: {
    getSessionId: (): string => sessionId,
    getSessionFile: (): string => sessionFile,
  },
  getContextUsage: (): { tokens: number } => ({ tokens: 1000 }),
  shutdown: (): void => {
    shutdownRequested = true;
  },
  isIdle: (): boolean => !streaming,
  abort: (): void => {
    /* spike: no-op */
  },
};

// --- load the REAL extension modules from the -e paths ----------------------
const loaded: string[] = [];
const failedExt: string[] = [];
for (const p of extPaths) {
  try {
    const mod: Record<string, unknown> = await import(pathToFileURL(p).href);
    const reg = (mod['default'] ?? mod['register']) as ((pi: unknown) => unknown) | undefined;
    if (typeof reg === 'function') {
      reg(pi);
      loaded.push(p);
    } else {
      failedExt.push(`${p} (no default export fn)`);
    }
  } catch (e) {
    failedExt.push(`${p} :: ${String(e)}`);
    recordError(`import ${p} failed: ${String(e)}`);
  }
}

// --- session_start: the real boot-confirm hook captures session id + pid -----
await fire('session_start', { reason: resuming ? 'resume' : 'startup' }, ctx);

// --- the boot proof the harness asserts on ----------------------------------
const boot = {
  pid: process.pid,
  nodeId,
  home,
  rawArgv,
  extPaths,
  loaded,
  failedExt,
  sessionId,
  sessionFile,
  resuming,
  label: label ?? null,
  prompt: prompt ?? null,
  env: {
    CRTR_NODE_ID: env['CRTR_NODE_ID'] ?? null,
    CRTR_KIND: env['CRTR_KIND'] ?? null,
    CRTR_MODE: env['CRTR_MODE'] ?? null,
    CRTR_LIFECYCLE: env['CRTR_LIFECYCLE'] ?? null,
    CRTR_NODE_CWD: env['CRTR_NODE_CWD'] ?? null,
    CRTR_HOME: env['CRTR_HOME'] ?? null,
    CRTR_PARENT_NODE_ID: env['CRTR_PARENT_NODE_ID'] ?? null,
    CRTR_ROOT_SESSION: env['CRTR_ROOT_SESSION'] ?? null,
    CRTR_SUBTREE: env['CRTR_SUBTREE'] ?? null,
    CRTR_FRONT_DOOR: env['CRTR_FRONT_DOOR'] ?? null,
  },
  injectedDuringBoot: injected.slice(),
};
writeFileSync(join(nodeDir, 'fake-pi.boot.json'), JSON.stringify(boot, null, 2));
// Append-only boot log so the harness can count re-boots (a resume after an
// idle-release wake, or a fresh pi after a refresh-yield).
try {
  appendFileSync(join(nodeDir, 'fake-pi.boots.jsonl'), JSON.stringify(boot) + '\n');
} catch {
  /* best effort */
}

// --- control loop: poll for one harness command at a time -------------------
const cmdFile = join(nodeDir, 'fake-pi.cmd');
const ackFile = join(nodeDir, 'fake-pi.ack');

function ack(id: string, body: Record<string, unknown>): void {
  try {
    appendFileSync(ackFile, JSON.stringify({ id, ...body, ts: Date.now() }) + '\n');
  } catch {
    /* best effort */
  }
}

async function doShutdown(): Promise<never> {
  // A clean pi /quit. The stophook's session_shutdown handler resolves a still-
  // active node to done (markCleanExitDone → finalize). Mirrors real pi exiting.
  await fire('session_shutdown', { reason: 'quit' }, ctx);
  ack('shutdown', { ok: true });
  clearInterval(timer);
  process.exit(0);
}

async function dispatch(cmd: {
  cmd?: string;
  id?: string;
  reason?: string;
  text?: string;
  errorMessage?: string;
}): Promise<void> {
  const id = cmd.id ?? cmd.cmd ?? 'cmd';
  switch (cmd.cmd) {
    case 'shutdown':
      await doShutdown();
      break;
    case 'stop':
      streaming = false;
      await fire(
        'agent_end',
        {
          messages: [
            {
              role: 'assistant',
              stopReason: cmd.reason ?? 'stop',
              // A real engine attaches errorMessage on a stopReason:'error' turn;
              // the stophook classifies it (connection/rate-limit/…) for the
              // error-stall marker. Forward it so a test can drive a CONNECTION
              // stall faithfully.
              ...(cmd.errorMessage === undefined ? {} : { errorMessage: cmd.errorMessage }),
              content: [{ type: 'text', text: cmd.text ?? '' }],
            },
          ],
        },
        ctx,
      );
      ack(id, { ok: true });
      break;
    case 'turn':
      streaming = true;
      await fire('agent_start', {}, ctx);
      streaming = false;
      await fire('turn_end', { message: { role: 'assistant', usage: { input: 10, output: 5 }, model: 'fake' } }, ctx);
      await fire(
        'agent_end',
        { messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: cmd.text ?? '' }] }] },
        ctx,
      );
      ack(id, { ok: true });
      break;
    default:
      ack(id, { ok: false, error: `unknown cmd: ${String(cmd.cmd)}` });
  }
}

async function step(): Promise<void> {
  if (shutdownRequested) {
    await doShutdown();
    return;
  }
  if (!existsSync(cmdFile)) return;
  let cmd: { cmd?: string } | null = null;
  try {
    cmd = JSON.parse(readFileSync(cmdFile, 'utf8')) as { cmd?: string };
  } catch {
    cmd = null;
  }
  try {
    unlinkSync(cmdFile);
  } catch {
    /* ignore */
  }
  if (cmd) await dispatch(cmd);
  if (shutdownRequested) await doShutdown();
}

const timer = setInterval(() => {
  void step().catch((e) => recordError(`step: ${String(e)}`));
}, 100);
