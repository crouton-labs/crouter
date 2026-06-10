// `crtr sys feedback` — file a GitHub issue against the crtr repo when the
// harness itself misbehaves (a command errors unexpectedly, hangs, churns, or
// acts contrary to its documented contract). The agent supplies one prose
// description; everything else (version, node identity, recent activity) is
// auto-collected and templated into the issue body. gh-less / unauthed hosts
// fall back to a durable local file so the report is never lost.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';

import { defineLeaf } from '../../core/command.js';
import { usage } from '../../core/errors.js';
import { userScopeRoot } from '../../core/scope.js';
import { getNode, jobDir, readTelemetry } from '../../core/canvas/index.js';
import { readPackageVersion } from './shared.js';

/** Canonical repo for crtr harness feedback — feedback is always about the
 *  tool, regardless of which project the reporting agent is working in. */
const FEEDBACK_REPO = 'crouton-labs/crouter';

interface CollectedContext {
  version: string;
  platform: string;
  nodeId: string | null;
  kind: string | null;
  mode: string | null;
  lifecycle: string | null;
  cwd: string | null;
  cycle: number | null;
  contextTokens: number | null;
  logTail: string[];
}

function collectContext(): CollectedContext {
  const env = process.env;
  const nodeId = env['CRTR_NODE_ID'] ?? null;
  let cycle: number | null = null;
  let logTail: string[] = [];
  if (nodeId !== null) {
    const meta = getNode(nodeId);
    if (meta !== null && typeof meta.cycles === 'number') cycle = meta.cycles;
    logTail = readLogTail(nodeId);
  }
  const contextTokens = nodeId !== null ? readTelemetry(nodeId).context_tokens ?? null : null;
  return {
    version: readPackageVersion(),
    platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    nodeId,
    kind: env['CRTR_KIND'] ?? null,
    mode: env['CRTR_MODE'] ?? null,
    lifecycle: env['CRTR_LIFECYCLE'] ?? null,
    cwd: env['CRTR_NODE_CWD'] ?? process.cwd(),
    cycle,
    contextTokens,
    logTail,
  };
}

/** Last few lines of a node's job/log.jsonl — best-effort, never throws. Each
 *  line is truncated so a single fat event can't blow up the issue body. */
function readLogTail(nodeId: string, count = 15): string[] {
  try {
    const path = join(jobDir(nodeId), 'log.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-count)
      .map((l) => (l.length > 600 ? l.slice(0, 600) + '…' : l));
  } catch {
    return [];
  }
}

function deriveTitle(raw: string | undefined, message: string): string {
  const explicit = raw !== undefined && raw.trim() !== '' ? raw.trim() : undefined;
  const base = explicit ?? message.split('\n')[0].trim();
  const trimmed = base.length > 80 ? base.slice(0, 79) + '…' : base;
  return `[feedback] ${trimmed}`;
}

function buildBody(message: string, ctx: CollectedContext): string {
  const rows: string[] = [
    `| crtr version | \`${ctx.version}\` |`,
    `| platform | ${ctx.platform} |`,
  ];
  if (ctx.nodeId !== null) {
    rows.push(`| node id | \`${ctx.nodeId}\` |`);
    rows.push(`| kind / mode / lifecycle | ${ctx.kind ?? '?'} / ${ctx.mode ?? '?'} / ${ctx.lifecycle ?? '?'} |`);
    if (ctx.cycle !== null) rows.push(`| cycle | ${ctx.cycle} |`);
    if (ctx.contextTokens !== null) rows.push(`| context tokens | ${ctx.contextTokens.toLocaleString('en-US')} |`);
  }
  if (ctx.cwd !== null) rows.push(`| working dir | \`${ctx.cwd}\` |`);

  const parts = [
    message.trim(),
    '',
    '---',
    '_Filed via `crtr sys feedback` — context below auto-attached by the harness._',
    '',
    '### Environment',
    '| | |',
    '|---|---|',
    ...rows,
  ];

  if (ctx.logTail.length > 0) {
    parts.push(
      '',
      `### Recent node activity (last ${ctx.logTail.length} log events)`,
      '```jsonl',
      ...ctx.logTail,
      '```',
    );
  }
  return parts.join('\n') + '\n';
}

/** Persist a report locally when gh can't file it, so nothing is lost. Returns
 *  the absolute path written. */
function saveLocally(title: string, body: string): string {
  const dir = join(userScopeRoot(), 'feedback');
  mkdirSync(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = join(dir, `${ts}.md`);
  writeFileSync(path, `# ${title}\n\n${body}`, 'utf8');
  return path;
}

export const sysFeedbackLeaf = defineLeaf({
  name: 'feedback',
  description: 'report a crtr harness bug as a GitHub issue',
  whenToUse:
    'a crtr command itself misbehaves — it errors unexpectedly, hangs, churns, double-spawns, or acts contrary to its documented contract. NOT for your task work or decisions a human should make (that is `crtr human ask`); this reports the TOOL, filing an issue against the crtr repo with your node context auto-attached.',
  help: {
    name: 'sys feedback',
    summary: 'file a GitHub issue describing a crtr harness bug, with node context auto-attached',
    params: [
      {
        kind: 'positional',
        name: 'message',
        required: true,
        constraint:
          'What broke, in your own words: the command you ran, what you expected, what happened instead. Be concrete — this is the only part a human writes; everything else is auto-collected.',
      },
      {
        kind: 'flag',
        name: 'title',
        type: 'string',
        required: false,
        constraint: 'Issue title. Default: first line of the message, truncated.',
      },
    ],
    output: [
      { name: 'status', type: 'string', required: true, constraint: 'filed | saved-locally.' },
      { name: 'url', type: 'string', required: false, constraint: 'Issue URL when status is filed.' },
      { name: 'path', type: 'string', required: false, constraint: 'Local report path when status is saved-locally (gh unavailable).' },
      { name: 'error', type: 'string', required: false, constraint: 'Why filing fell back to local save.' },
    ],
    outputKind: 'object',
    effects: [
      `Opens a public GitHub issue on ${FEEDBACK_REPO} via gh.`,
      'On gh failure (missing / unauthenticated), writes the report to ~/.crouter/feedback/ instead — never lost.',
    ],
  },
  run: async (input) => {
    const message = (input['message'] as string | undefined)?.trim();
    if (message === undefined || message === '') {
      throw usage('feedback message is required: describe what broke. Run `crtr sys feedback -h`.');
    }
    const ctx = collectContext();
    const title = deriveTitle(input['title'] as string | undefined, message);
    const body = buildBody(message, ctx);

    const res = spawnSync(
      'gh',
      ['issue', 'create', '--repo', FEEDBACK_REPO, '--title', title, '--body-file', '-'],
      { input: body, encoding: 'utf8' },
    );

    if (res.error === undefined && res.status === 0) {
      const url = res.stdout.trim().split('\n').filter((l) => l.startsWith('http')).pop() ?? res.stdout.trim();
      return { status: 'filed', url };
    }

    // gh missing, unauthenticated, or the API call failed — persist locally so
    // the report survives, and tell the agent how to escalate.
    const reason =
      res.error !== undefined
        ? `gh not available: ${res.error.message}`
        : (res.stderr?.trim() || `gh exited ${res.status}`);
    const path = saveLocally(title, body);
    return { status: 'saved-locally', path, error: reason };
  },
});
