// events.ts — the `crtr web` realtime push lane.
//
// ONE server-sent-events stream, `GET /__crtr/events`, that carries change
// invalidations — never data. The shell and built-in views subscribe and, on an
// event, re-pull through their existing bridge reads instead of waiting on a
// fixed poll tick. SSE carries "something in this class changed"; the consumer
// decides what to re-read.
//
// Event vocabulary (deliberately minimal): { kind: 'nodes' | 'inbox', ts }.
//   - 'nodes' — the node graph changed (topology, status/intent transitions,
//     naming). Source: canvas.db (+ its WAL sidecar) mtime. Every transition()
//     and canvas mutation writes the WAL, so a watch on the home dir's
//     `canvas.db*` files detects all of them with one cheap watcher.
//   - 'inbox' — a node's inbox.jsonl gained a message. Source: a recursive watch
//     on the nodes/ tree, filtered to `inbox.jsonl` writes.
//
// WHY these sources: they are the cheapest things that detect node-graph +
// inbox changes without a daemon hook or a db trigger — pure fs.watch on the
// two on-disk authorities (canvas.db for the graph, inbox.jsonl for messages).

import { watch, type FSWatcher } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { crtrHome, nodesRoot, ensureHome } from '../../core/canvas/paths.js';

export type ChangeKind = 'nodes' | 'inbox';

/** Coalesce a burst of fs events into one emission per kind. WAL writes and
 *  inbox appends arrive in clusters (a single transition can touch -wal/-shm);
 *  a short trailing debounce collapses each cluster into a single invalidation,
 *  which is all a re-pull consumer needs. */
const DEBOUNCE_MS = 150;
/** SSE keepalive comment cadence — keeps proxies/clients from idling the stream
 *  shut. A bare `:` comment line is ignored by EventSource. */
const HEARTBEAT_MS = 25_000;

export interface EventHub {
  /** Register an SSE client: writes the event-stream headers, streams events
   *  until the connection closes, and self-removes on close. */
  addClient: (res: ServerResponse) => void;
  /** Tear down watchers + heartbeat and end all open streams. */
  close: () => void;
}

/** Start the change-event hub: open the two fs watchers once, fan their
 *  debounced invalidations out to every connected SSE client. Watchers run for
 *  the server's lifetime (cheap — two inotify/FSEvents registrations), not
 *  per-client, so N browsers share one watch. */
export function startEventHub(): EventHub {
  ensureHome();
  const clients = new Set<ServerResponse>();
  const watchers: FSWatcher[] = [];
  const timers = new Map<ChangeKind, NodeJS.Timeout>();

  const broadcast = (kind: ChangeKind): void => {
    const line = `data: ${JSON.stringify({ kind, ts: Date.now() })}\n\n`;
    for (const res of clients) {
      try {
        res.write(line);
      } catch {
        /* a dead stream is reaped by its own 'close' handler */
      }
    }
  };

  // Debounce per kind: an fs event arms a trailing timer; a fresh event within
  // the window resets it, so a write cluster emits exactly once.
  const emit = (kind: ChangeKind): void => {
    const existing = timers.get(kind);
    if (existing !== undefined) clearTimeout(existing);
    timers.set(
      kind,
      setTimeout(() => {
        timers.delete(kind);
        broadcast(kind);
      }, DEBOUNCE_MS),
    );
  };

  // Watcher 1 — the canvas home dir (non-recursive). canvas.db lives in WAL
  // mode, so graph writes land in canvas.db-wal and checkpoints in canvas.db;
  // watching the dir catches every `canvas.db*` sidecar touch → 'nodes'.
  try {
    const homeWatcher = watch(crtrHome(), (_event, filename) => {
      if (filename !== null && filename.startsWith('canvas.db')) emit('nodes');
    });
    homeWatcher.on('error', () => {
      /* watch dropped (dir replaced) — non-fatal; the poll cadence still backs us */
    });
    watchers.push(homeWatcher);
  } catch {
    /* fs.watch unavailable on this platform — degrade to poll-only (no SSE) */
  }

  // Watcher 2 — the nodes/ tree (recursive). An inbox.jsonl append is a message
  // landing; a meta.json write is a graph/identity change (naming, polymorph).
  // Recursive fs.watch is supported on macOS/Windows always and Linux ≥ v20.
  try {
    const nodesWatcher = watch(nodesRoot(), { recursive: true }, (_event, filename) => {
      if (filename === null) return;
      if (filename.endsWith('inbox.jsonl')) emit('inbox');
      else if (filename.endsWith('meta.json')) emit('nodes');
    });
    nodesWatcher.on('error', () => {
      /* recursive watch refused/dropped — non-fatal */
    });
    watchers.push(nodesWatcher);
  } catch {
    /* recursive watch unsupported — inbox push degrades to poll-only */
  }

  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try {
        res.write(': ping\n\n');
      } catch {
        /* reaped by its 'close' handler */
      }
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    addClient(res: ServerResponse): void {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // The browser EventSource is same-origin here; no CORS header needed.
      });
      // An initial comment flushes headers and confirms the stream is open.
      res.write(': connected\n\n');
      clients.add(res);
      const drop = (): void => {
        clients.delete(res);
      };
      res.on('close', drop);
      res.on('error', drop);
    },
    close(): void {
      clearInterval(heartbeat);
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          /* ignore */
        }
      }
      for (const res of clients) {
        try {
          res.end();
        } catch {
          /* ignore */
        }
      }
      clients.clear();
    },
  };
}
