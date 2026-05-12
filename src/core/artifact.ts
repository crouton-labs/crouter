import { Command } from 'commander';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { CRTR_DIR_NAME } from '../types.js';
import { ensureDir, pathExists, readText, walkFiles } from './fs-utils.js';
import { usage, notFound, general } from './errors.js';
import { out, hint, jsonOut, handleError, info } from './output.js';
import {
  spawnSidePaneReview,
  DEFAULT_PANE_OPTS,
  type SidePaneResult,
} from './spawn.js';

export type ArtifactKind = 'plans' | 'specs';

export function mangleCwd(cwd: string = process.cwd()): string {
  return cwd.replace(/\//g, '-');
}

export function artifactsRoot(kind: ArtifactKind, cwd?: string): string {
  return join(homedir(), CRTR_DIR_NAME, mangleCwd(cwd), kind);
}

export function sanitizeName(raw: string): string {
  const trimmed = raw.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') throw usage('name must not be empty');
  if (trimmed.split('/').some((seg) => seg === '..' || seg === '.')) {
    throw usage(`name must not contain "." or ".." segments: ${raw}`);
  }
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    throw usage(`name must not be absolute: ${raw}`);
  }
  return trimmed;
}

export function artifactPath(kind: ArtifactKind, name: string, cwd?: string): string {
  return join(artifactsRoot(kind, cwd), `${sanitizeName(name)}.md`);
}

export function inTmux(): boolean {
  return Boolean(process.env.TMUX);
}

export function openInTmuxPane(path: string): void {
  const result = spawnSync('termrender', ['--tmux', path], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      hint('termrender not found on $PATH — install it to auto-open in tmux');
    } else {
      hint(`termrender failed: ${result.error.message}`);
    }
    return;
  }
  if (result.status !== 0) {
    const stderrText = result.stderr.toString().trim();
    hint(`termrender exited with ${result.status}${stderrText ? `: ${stderrText}` : ''}`);
    return;
  }
  const paneId = result.stdout.toString().trim();
  if (paneId) hint(`opened in tmux pane ${paneId}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function listArtifactNames(kind: ArtifactKind): string[] {
  const root = artifactsRoot(kind);
  if (!pathExists(root)) return [];
  return walkFiles(root, (n) => n.endsWith('.md'))
    .map((abs) => abs.substring(root.length + 1).replace(/\.md$/, ''))
    .sort();
}

export interface SaveOptionDef {
  flag: string;
  description: string;
  key: string;
}

export interface ReviewerConfig {
  buildPrompt: (artifactPath: string, opts: Record<string, string | undefined>) => string;
  extraSaveOptions?: SaveOptionDef[];
}

export interface RegisterArtifactOptions {
  command: 'plan' | 'spec';
  kind: ArtifactKind;
  promptFn: (artifactsDir: string) => string;
  reviewer?: ReviewerConfig;
  /** If set and the saved body exceeds this many lines, emit a breakdown advisory. */
  oversizeWarnLines?: number;
}

type SaveOptions = {
  name?: string;
  review?: boolean;
} & Record<string, string | boolean | undefined>;

export function registerArtifactCommand(program: Command, opts: RegisterArtifactOptions): void {
  const { command, kind, promptFn, reviewer, oversizeWarnLines } = opts;

  const saveCmd = program
    .command(`${command} [content]`)
    .description(`print the ${command} prompt, or save a ${command} with --name`)
    .option('--name <name>', `save the ${command} under this name`);

  if (reviewer !== undefined) {
    saveCmd.option(
      '--no-review',
      'skip the auto-review step (use for trivial artifacts)',
    );
    for (const extra of reviewer.extraSaveOptions ?? []) {
      saveCmd.option(extra.flag, extra.description);
    }
  }

  saveCmd.action(
    async (content: string | undefined, options: SaveOptions) => {
      try {
        if (options.name === undefined) {
          if (content !== undefined) {
            throw usage(
              `positional content requires --name (try \`crtr ${command} --name <name> ...\`)`,
            );
          }
          out(promptFn(artifactsRoot(kind)));
          return;
        }

        let body: string;
        if (content !== undefined) {
          body = content;
        } else if (!process.stdin.isTTY) {
          body = await readStdin();
        } else {
          throw usage(
            `no content provided. Pipe via stdin (heredoc) or pass as a positional arg:\n` +
              `  crtr ${command} --name <name> <<'EOF'\n  <content>\n  EOF`,
          );
        }

        if (body.trim() === '') {
          throw usage('content is empty');
        }

        const filePath = artifactPath(kind, options.name);
        ensureDir(dirname(filePath));
        const finalBody = body.endsWith('\n') ? body : body + '\n';
        writeFileSync(filePath, finalBody, 'utf8');
        out(filePath);

        if (inTmux()) openInTmuxPane(filePath);

        if (oversizeWarnLines !== undefined) {
          const lineCount = finalBody.split('\n').length - 1;
          if (lineCount > oversizeWarnLines) {
            out('');
            out('--- advisory ---');
            out(
              `This ${command} is ${lineCount} lines (> ${oversizeWarnLines}). ` +
                `Consider splitting it into multiple ${command}s under a shared prefix ` +
                `(e.g. \`crtr ${command} --name ${options.name}/part-1\`, ` +
                `\`crtr ${command} --name ${options.name}/part-2\`) and linking them ` +
                `from a brief index ${command} at \`${options.name}\`. ` +
                `Smaller ${command}s are easier to execute and review.`,
            );
          }
        }

        if (reviewer !== undefined) {
          const reviewSkipped = options.review === false;
          if (reviewSkipped) {
            hint('review skipped (--no-review)');
          } else if (!inTmux()) {
            hint('review skipped (not in tmux — auto-review needs a tmux pane)');
          } else {
            await runReviewer(filePath, reviewer, options);
          }
        }
      } catch (e) {
        handleError(e);
      }
    },
  );

  const cmd = saveCmd;

  cmd
    .command('list')
    .description(`list ${kind} for the current directory`)
    .option('--json', 'emit JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const names = listArtifactNames(kind);
        if (options.json) {
          jsonOut({
            [kind]: names.map((name) => ({ name, path: artifactPath(kind, name) })),
          });
          return;
        }
        for (const n of names) out(n);
      } catch (e) {
        handleError(e, { json: options.json });
      }
    });

  cmd
    .command('show <name>')
    .description(`print the body of a ${command}`)
    .action(async (name: string) => {
      try {
        const filePath = artifactPath(kind, name);
        if (!pathExists(filePath)) {
          throw notFound(`${command} not found: ${name} (looked at ${filePath})`);
        }
        out(readText(filePath));
        hint(`crtr: edit with \`crtr ${command} edit ${name}\` (${filePath})`);
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command('path [name]')
    .description(`print the absolute path of a ${command} or the ${kind} directory`)
    .action(async (name: string | undefined) => {
      try {
        out(name === undefined ? artifactsRoot(kind) : artifactPath(kind, name));
      } catch (e) {
        handleError(e);
      }
    });

  cmd
    .command('edit <name>')
    .description(`open the ${command} in $EDITOR`)
    .action(async (name: string) => {
      try {
        const filePath = artifactPath(kind, name);
        if (!pathExists(filePath)) {
          throw notFound(`${command} not found: ${name} (looked at ${filePath})`);
        }
        const editor =
          process.env.EDITOR !== undefined && process.env.EDITOR !== ''
            ? process.env.EDITOR
            : 'vi';
        await new Promise<void>((resolve, reject) => {
          const child = spawn(editor, [filePath], { stdio: 'inherit' });
          child.on('error', (e) =>
            reject(general(`failed to launch editor: ${e.message}`)),
          );
          child.on('close', (code) => {
            if (code !== 0 && code !== null) {
              reject(general(`editor exited with code ${code}`));
            } else {
              resolve();
            }
          });
        });
      } catch (e) {
        handleError(e);
      }
    });
}

async function runReviewer(
  artifactFilePath: string,
  reviewer: ReviewerConfig,
  options: Record<string, string | boolean | undefined>,
): Promise<void> {
  const extraOpts: Record<string, string | undefined> = {};
  for (const def of reviewer.extraSaveOptions ?? []) {
    const value = options[def.key];
    if (typeof value === 'string') extraOpts[def.key] = value;
  }

  info('spawning reviewer in side pane (10-min budget) — output below…');
  const result: SidePaneResult = await spawnSidePaneReview({
    prompt: reviewer.buildPrompt(artifactFilePath, extraOpts),
    cwd: process.cwd(),
    timeoutMs: DEFAULT_PANE_OPTS.timeoutMs,
  });

  out('');
  out('--- review ---');
  if (result.status === 'submitted') {
    out(result.content.trim());
  } else if (result.status === 'timeout') {
    out('REVIEW_TIMEOUT: reviewer did not submit within the 10-minute budget.');
  } else if (result.status === 'pane-closed') {
    out('REVIEW_ABORTED: reviewer pane closed before submission.');
  } else {
    out(`REVIEW_FAILED: ${result.content}`);
  }
}
