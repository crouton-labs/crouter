import { spawn } from 'node:child_process';
import { readConfig, readState, updateState } from './config.js';
import { nowIso } from './fs-utils.js';
import { info } from './output.js';
import { selfCheck, contentCheck } from './self-update.js';

const HOUR_MS = 60 * 60 * 1000;

const SKIP_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'update',
  'help',
  '--help',
  '-h',
  '--version',
  '-v',
]);

function shouldSkipForArgv(argv: string[]): boolean {
  const sub = argv[2];
  if (sub === undefined) return true;
  return SKIP_SUBCOMMANDS.has(sub);
}

function withinInterval(lastIso: string | undefined, intervalHours: number): boolean {
  if (!lastIso) return false;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return false;
  return Date.now() - last < intervalHours * HOUR_MS;
}

function spawnDetachedSelfUpdate(): void {
  const child = spawn('npm', ['i', '-g', '@crouton-kit/crouter@latest'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

function spawnDetachedContentUpdate(): void {
  const child = spawn('crtr', ['update', '--content'], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

export function maybeAutoUpdate(argv: string[]): void {
  try {
    if (process.env.CRTR_NO_AUTO_UPDATE === '1') return;
    if (shouldSkipForArgv(argv)) return;

    const cfg = readConfig('user');
    const { crtr, content, interval_hours } = cfg.auto_update;
    if (crtr === false && content === false) return;

    const state = readState('user');

    if (state.last_self_check === undefined) {
      updateState('user', (s) => {
        s.last_self_check = nowIso();
      });
      return;
    }

    if (withinInterval(state.last_self_check, interval_hours)) return;

    updateState('user', (s) => {
      s.last_self_check = nowIso();
    });

    if (crtr === 'notify') {
      const r = selfCheck();
      if (r !== null && r.latest !== r.current) {
        process.stderr.write(`crtr: v${r.latest} available (current ${r.current}) — run \`crtr sys update\`\n`);
      }
    } else if (crtr === 'apply') {
      info('applying self-update in background');
      spawnDetachedSelfUpdate();
    }

    if (content === 'notify') {
      const stale = contentCheck().filter((e) => !e.up_to_date && !e.unreachable);
      if (stale.length > 0) {
        const list = stale.map((e) => `${e.kind} ${e.name}`).join(', ');
        process.stderr.write(`crtr: updates available for ${list} — run \`crtr sys update\`\n`);
      }
    } else if (content === 'apply') {
      info('applying content updates in background');
      spawnDetachedContentUpdate();
    }
  } catch (e) {
    if (process.env.CRTR_DEBUG === '1') {
      const msg = e instanceof Error ? e.message : String(e);
      process.stderr.write(`crtr: auto-update hook error: ${msg}\n`);
    }
  }
}
