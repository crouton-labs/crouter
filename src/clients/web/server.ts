// server.ts — the unified `crtr web serve` host: the crouter web UI server.
//
// ONE long-running server process on 127.0.0.1 that serves THREE concerns on one
// origin (the §2 unified server):
//   • GET  /*               → the shell SPA (static dist/web-client/, or Vite
//                             middleware in --dev) + SPA fallback.
//   • POST /__crtr/source   → the source + command bridge: decode a SourceRequest
//                             and run it through the LOCAL transport (exec/file/
//                             http in this cwd). This serves views' READS and the
//                             command WRITES (`crtr …` subprocesses). Lifted here
//                             from the deleted `view serve`.
//   • GET  /__crtr/events   → the SSE change-invalidation lane (events.ts).
//   • WS   /node/<id>       → open that node's ALREADY-running broker `view.sock`
//                             and relay frames VERBATIM both directions. The relay
//                             adds NOTHING — the browser is the SAME protocol peer
//                             as `crtr attach`.
//
// §0 ONE-WRITER INVARIANT: the WS relay is ONLY a socket relay. It NEVER calls
// reviveNode, NEVER spawns `pi --session`, NEVER touches SessionManager, and
// NEVER opens/writes a `.jsonl`. It opens a `node:net` connection to an
// ALREADY-running broker's `view.sock`; if the broker is not running the WS is
// closed with a clear reason. The relay NEVER launches an engine. ALL writes go
// through the bridge running `crtr` SUBPROCESSES — this process is never the
// sanctioned writer; the CLI it shells out to is.
//
// One `view.sock` connection per browser-WS (N browsers of one node = N broker
// clients) — the broker fans out natively, so there is no bridge-side fan-out.

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import { WebSocketServer, type WebSocket } from 'ws';
import { nodeDir } from '../../core/canvas/paths.js';
import { getNode } from '../../core/canvas/index.js';
import {
  BROKER_READ_CAPS,
  CLIENT_READ_CAPS,
  FrameDecoder,
  FrameOverflowError,
} from '../../core/runtime/broker-protocol.js';
import { createLocalTransport } from '../../core/view/transport-local.js';
import { runSourceRequest } from '../../core/view/bridge.js';
import { startEventHub } from './events.js';
import { createDevServer } from './dev-server.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Candidate dirs to serve the shell SPA bundle from, in priority order: an
 *  explicit override, the compiled-module-relative `dist/web-client/` (what
 *  `vite build` emits and what we serve in production), and the placeholder
 *  copied from source. The first that exists wins. (--dev bypasses this entirely
 *  — Vite middleware owns asset serving in that mode.) */
function resolveClientDir(): string {
  const candidates = [
    process.env['CRTR_WEB_CLIENT_DIR'],
    join(HERE, '../../web-client'),
    resolve(HERE, '../../../dist/web-client'),
  ].filter((p): p is string => p !== undefined && p !== '');
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  // Fall back to the module-relative path even if absent; missing-file handling
  // below returns a clear 503 so a not-yet-built shell is diagnosable.
  return join(HERE, '../../web-client');
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

/** Match a WS/GET path of the shape `/node/<id>` (with any number of leading
 *  segments, future-proofing a mount prefix). Returns the decoded node id, or
 *  null if the path doesn't match or the id is undecodable (malformed `%`). The
 *  caller must still VALIDATE the id (no separators / `..`) before building a
 *  filesystem path — see {@link isSafeNodeId}. */
function nodeIdFromPath(pathname: string): string | null {
  const m = /\/node\/([^/?#]+)\/?$/.exec(pathname);
  if (m === null) return null;
  try {
    return decodeURIComponent(m[1]!);
  } catch {
    return null; // malformed percent-encoding — treat as no match
  }
}

/** A node id is used to build `nodeDir(id)/view.sock`, so it MUST NOT contain a
 *  path separator or `..` (e.g. a decoded `..%2f..` would escape `nodes/`). */
function isSafeNodeId(id: string): boolean {
  return id !== '' && !/[/\\]/.test(id) && !id.includes('..');
}

/** A WS close reason is capped at 123 UTF-8 bytes by the protocol. */
function clampReason(reason: string): string {
  const buf = Buffer.from(reason, 'utf8');
  return buf.byteLength <= 123 ? reason : buf.subarray(0, 123).toString('utf8');
}

/** Read a request body fully into a string. Buffer.concat before decoding so a
 *  multibyte char split across chunks (UTF-8 in a write command's stdin) is
 *  never corrupted. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rej);
  });
}

export interface WebServerOptions {
  port: number;
  host?: string;
  /** --dev: mount a Vite dev server (middleware mode, HMR) for asset serving
   *  instead of the static dist/web-client/ bundle. The bridge + SSE + WS relay
   *  are identical in both modes. */
  dev?: boolean;
}

export interface RunningWebServer {
  url: string;
  port: number;
  clientDir: string;
  close: () => Promise<void>;
}

/** Serve a static file from the client dir, with SPA fallback to index.html for
 *  any unmatched (non-asset) GET — so `/` and `/node/<id>` both boot the app
 *  shell. Returns true if it wrote a response. */
function serveStatic(clientDir: string, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    // Malformed percent-encoding (e.g. `GET /%`) — never let it throw out of
    // the request listener and crash the whole multiplexing server (C1).
    res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('bad request\n');
    return;
  }

  // Resolve within clientDir; reject traversal.
  const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = join(clientDir, rel);
  if (!filePath.startsWith(clientDir)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('forbidden\n');
    return;
  }

  // Directory or root → index.html. A path with no file extension that does not
  // exist → SPA fallback to index.html (so deep links like /node/<id> boot).
  const isFile = existsSync(filePath) && statSync(filePath).isFile();
  if (!isFile) {
    filePath = join(clientDir, 'index.html');
  }

  if (!existsSync(filePath)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      'crtr web shell bundle not found — run `npm run build` to emit it into ' +
        `${clientDir} (or pass --dev for Vite middleware)\n`,
    );
    return;
  }

  res.writeHead(200, { 'content-type': contentTypeFor(filePath), 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
  stream.pipe(res);
}

/** Relay one browser WS ⇄ one node broker `view.sock`. Opens the socket on
 *  connect; forwards each complete frame socket→WS (bounded decode, one WS
 *  message per frame) and re-frames each WS message WS→socket (trailing
 *  newline). The relay is semantically verbatim — it never INTERPRETS a frame
 *  (it only splits/joins the newline framing). Closes the WS on socket
 *  gone/no-broker, destroys the socket on WS close; idempotent teardown, no
 *  leaks. Validates the node id first (path-safety + existence). */
function bridgeConnection(ws: WebSocket, nodeId: string): void {
  if (!isSafeNodeId(nodeId)) {
    try {
      ws.close(1008, clampReason(`invalid node id: ${nodeId}`));
    } catch {
      /* ignore */
    }
    return;
  }
  if (getNode(nodeId) === null) {
    try {
      ws.close(1011, clampReason(`no node ${nodeId}`));
    } catch {
      /* ignore */
    }
    return;
  }
  const sockPath = join(nodeDir(nodeId), 'view.sock');
  const socket: Socket = createConnection(sockPath);
  const decoder = new FrameDecoder(CLIENT_READ_CAPS);
  let closed = false;

  const teardown = (wsCode: number, reason: string): void => {
    if (closed) return;
    closed = true;
    if (!socket.destroyed) {
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
    try {
      ws.close(wsCode, clampReason(reason));
    } catch {
      /* ignore */
    }
  };

  // socket → WS: bounded decode, one WS text message per complete frame.
  socket.on('data', (chunk: Buffer) => {
    let frames: unknown[];
    try {
      frames = decoder.push(chunk);
    } catch (err) {
      const msg =
        err instanceof FrameOverflowError
          ? `broker sent an oversized frame (${err.message})`
          : `failed to decode a broker frame for ${nodeId}`;
      teardown(1009, msg);
      return;
    }
    for (const frame of frames) {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame));
    }
  });
  socket.on('error', (err: NodeJS.ErrnoException) => {
    const reason =
      err.code === 'ECONNREFUSED' || err.code === 'ENOENT'
        ? `no running broker for ${nodeId}`
        : `view socket error for ${nodeId}: ${err.message}`;
    teardown(1011, reason);
  });
  socket.on('close', () => teardown(1000, `broker for ${nodeId} closed`));

  // WS → socket: re-frame each message as one newline-terminated JSON line.
  // VERBATIM (no parse) — the broker validates and bounds its own reads.
  ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
    if (closed || socket.destroyed) return;
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(new Uint8Array(data));
    const text = buf.toString('utf8');
    const line = text.endsWith('\n') ? text : text + '\n';
    try {
      socket.write(line);
    } catch {
      /* dead socket — its 'close' drives teardown */
    }
  });
  ws.on('close', () => teardown(1000, 'browser closed'));
  ws.on('error', () => teardown(1011, 'browser ws error'));
}

/** Build + start the unified web server. Binds 127.0.0.1 only (remote access is
 *  out of scope — §9). Resolves once the server is listening. Async because
 *  --dev awaits a Vite middleware server before listening. */
export async function startWebServer(opts: WebServerOptions): Promise<RunningWebServer> {
  const host = opts.host ?? '127.0.0.1';
  const dev = opts.dev ?? false;
  const clientDir = resolveClientDir();

  // The bridge runs view sources + command verbs locally, in the cwd crtr was
  // invoked from (a git-pr view inspects THIS repo; a `crtr node new` lands here).
  const transport = createLocalTransport({ cwd: process.cwd() });
  // The SSE change lane — one hub, fanned to every connected EventSource.
  const eventHub = startEventHub();

  // Same-origin allowlist (M1): a browser bypasses same-origin policy on both
  // WebSockets AND cross-origin POSTs, so any web page the user visits could
  // otherwise open ws://127.0.0.1:PORT/node/<id> and DRIVE their agents, OR POST
  // /__crtr/source to run ARBITRARY exec. The same gate guards all three write/
  // drive surfaces (WS upgrade, bridge POST, SSE GET). Populated once we know the
  // bound port. A request with NO Origin (a CLI/curl/test client, not a browser)
  // is allowed — the threat model is foreign browser pages, which always send it.
  let allowedOrigins = new Set<string>();
  const originAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined || origin === '') return true;
    return allowedOrigins.has(origin);
  };

  // Assigned before listen() when --dev; the request handler closes over it.
  let vite: ViteDevServer | undefined;

  const httpServer: HttpServer = createHttpServer((req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;

      // The source + command bridge: POST /__crtr/source → run the SourceRequest
      // through the local transport. Origin-gated (same M1 gate as the WS relay):
      // arbitrary exec from a foreign browser page is exactly what M1 prevents.
      if (pathname === '/__crtr/source') {
        if (req.method !== 'POST') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'POST' });
          res.end('method not allowed\n');
          return;
        }
        if (!originAllowed(req.headers.origin)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('forbidden\n');
          return;
        }
        void readBody(req)
          .then((body) => runSourceRequest(transport, body))
          .then(({ status, body }) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(body);
          })
          .catch((e: unknown) => {
            res.writeHead(500, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ ok: false, stdout: '', stderr: e instanceof Error ? e.message : String(e) }),
            );
          });
        return;
      }

      // The SSE change-invalidation lane: GET /__crtr/events. Origin-gated too —
      // a foreign page should not even learn the user's graph is mutating.
      if (pathname === '/__crtr/events') {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET' });
          res.end('method not allowed\n');
          return;
        }
        if (!originAllowed(req.headers.origin)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('forbidden\n');
          return;
        }
        eventHub.addClient(res);
        return;
      }

      // --dev: Vite middleware owns all remaining asset/HTML serving (incl. its
      // own SPA fallback). It is mounted AFTER the bridge + SSE checks above, so
      // those never fall through to Vite.
      if (vite !== undefined) {
        vite.middlewares(req, res);
        return;
      }

      // Shipped: static shell bundle + SPA fallback.
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
        res.end('method not allowed\n');
        return;
      }
      serveStatic(clientDir, req, res);
    } catch {
      // Belt-and-suspenders: nothing in the handler should throw now (C1), but a
      // request listener that throws crashes the whole daemon — never allow it.
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('internal error\n');
    }
  });

  // noServer: we route the upgrade ourselves so only `/node/<id>` upgrades.
  // maxPayload bounds the INBOUND browser→broker path, so it tracks the broker's
  // own read cap (BROKER_READ_CAPS), not the generous client cap — otherwise a
  // browser could buffer 256MiB/message before the broker's 24MiB decoder rejects
  // it (memory amplification, M3).
  const wss = new WebSocketServer({ noServer: true, maxPayload: BROKER_READ_CAPS.maxLineBytes });

  httpServer.on('upgrade', (req, socket, head) => {
    // A raw upgrade socket with no 'error' listener throws on a write to a reset
    // peer — attach one before we ever write/destroy it (n8).
    socket.on('error', () => {
      /* peer reset mid-handshake — destroy below or already destroyed */
    });
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const nodeId = nodeIdFromPath(url.pathname);
      if (nodeId === null) {
        // --dev: Vite's HMR WebSocket shares this HTTP server. Vite registers its
        // OWN 'upgrade' listener (via server.hmr.server); leave every non-`/node/`
        // upgrade for it instead of destroying the socket.
        if (vite !== undefined) return;
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      if (!originAllowed(req.headers.origin)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => bridgeConnection(ws, nodeId));
    } catch {
      // Never let an upgrade-handler throw escape and crash the daemon (C1).
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    }
  });

  // --dev: create the Vite middleware server BEFORE listen so the request
  // handler's `vite` is set and Vite's HMR upgrade listener is attached (ours
  // was added first, so a vite-hmr upgrade hits ours → nodeId null → returns →
  // Vite's listener handles it).
  if (dev) {
    vite = await createDevServer(httpServer);
  }

  return new Promise((resolveListening, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, host, () => {
      httpServer.off('error', reject);
      // A server error AFTER listen (e.g. an accept failure) must not be an
      // unhandled 'error' that crashes the process (n9) — log + carry on.
      httpServer.on('error', (err) => {
        process.stderr.write(`crtr web: server error: ${err.message}\n`);
      });
      const addr = httpServer.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      const url = `http://${host}:${port}`;
      allowedOrigins = new Set([
        `http://${host}:${port}`,
        `http://127.0.0.1:${port}`,
        `http://localhost:${port}`,
      ]);
      const close = (): Promise<void> =>
        new Promise((done) => {
          eventHub.close();
          void vite?.close().catch(() => {
            /* best-effort */
          });
          wss.clients.forEach((c) => {
            try {
              c.terminate();
            } catch {
              /* ignore */
            }
          });
          wss.close(() => {
            httpServer.close(() => done());
            // Idle keep-alive HTTP connections would otherwise keep close()'s
            // callback from ever firing — drop them so shutdown completes (m4).
            httpServer.closeAllConnections();
          });
        });
      resolveListening({ url, port, clientDir, close });
    });
  });
}
