// server.ts — the `crtr web` multiplexing socket↔WS bridge (Phase 4, T10).
//
// ONE long-running server process that multiplexes ALL nodes (NOT a
// bridge-per-node). It binds 127.0.0.1, serves the static browser bundle (built
// by T11 under src/clients/web/client/, copied to dist at build), and on a
// browser `ws://127.0.0.1:PORT/node/<id>` connection it opens that node's
// ALREADY-running broker `view.sock` on demand and relays frames VERBATIM both
// directions (socket bytes ↔ WS messages). The bridge adds NOTHING — it is a
// transparent relay, so the browser is the SAME protocol peer as `crtr attach`;
// controller arbitration, dialogs, and backpressure all ride the existing
// broker-protocol frames over the wire.
//
// §0 ONE-WRITER INVARIANT: this directory contains ONLY a socket relay. It NEVER
// calls reviveNode, NEVER spawns `pi --session`, NEVER touches SessionManager,
// and NEVER opens/writes a `.jsonl`. It opens a `node:net` connection to an
// ALREADY-running broker's `view.sock`; if the broker is not running the WS is
// closed with a clear reason. The bridge NEVER launches an engine.
//
// One `view.sock` connection per browser-WS (N browsers of one node = N broker
// clients) — the broker fans out natively, so there is no bridge-side fan-out.

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createConnection, type Socket } from 'node:net';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { nodeDir } from '../../core/canvas/paths.js';
import { getNode } from '../../core/canvas/index.js';
import {
  BROKER_READ_CAPS,
  CLIENT_READ_CAPS,
  FrameDecoder,
  FrameOverflowError,
} from '../../core/runtime/broker-protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Candidate dirs to serve the browser bundle from, in priority order:
 *  an explicit override, the compiled-module-relative `client/` (dist at
 *  runtime), and the source tree (dev under tsx). The first that exists wins —
 *  T11 emits its browser-ready assets into `src/clients/web/client/`, which the
 *  build copies to `dist/clients/web/client/` (what we serve in production). */
function resolveClientDir(): string {
  const candidates = [
    process.env['CRTR_WEB_CLIENT_DIR'],
    join(HERE, 'client'),
    resolve(HERE, '../../../src/clients/web/client'),
  ].filter((p): p is string => p !== undefined && p !== '');
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  // Fall back to the module-relative path even if absent; missing-file handling
  // below returns a clear 404/503 so a not-yet-built client is diagnosable.
  return join(HERE, 'client');
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

export interface WebServerOptions {
  port: number;
  host?: string;
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
      'crtr web client bundle not found — build the web client (T11) into ' +
        `${clientDir}\n`,
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

/** Build + start the multiplexing web bridge. Binds 127.0.0.1 only (remote
 *  access is out of scope). Resolves once the server is listening. */
export function startWebServer(opts: WebServerOptions): Promise<RunningWebServer> {
  const host = opts.host ?? '127.0.0.1';
  const clientDir = resolveClientDir();

  // Same-origin allowlist for WS upgrades (M1): a browser bypasses same-origin
  // policy on WebSockets, so any web page the user visits could otherwise open
  // ws://127.0.0.1:PORT/node/<id> and DRIVE their agents. Populated once we know
  // the bound port. A request with NO Origin (a CLI/test client, not a browser)
  // is allowed — the threat model is foreign browser pages, which always send it.
  let allowedOrigins = new Set<string>();
  const originAllowed = (origin: string | undefined): boolean => {
    if (origin === undefined || origin === '') return true;
    return allowedOrigins.has(origin);
  };

  const httpServer: HttpServer = createHttpServer((req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' });
        res.end('method not allowed\n');
        return;
      }
      serveStatic(clientDir, req, res);
    } catch {
      // Belt-and-suspenders: nothing in serveStatic should throw now (C1), but a
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
