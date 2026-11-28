/**
 * App bridge server: localhost WebSocket the MCP server connects to. Electron-free, so it
 * is unit-tested with a real socket (`bridge.test.ts`). Protocol: `@third-wheel/core` bridge.ts.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, win32 } from 'node:path';
import {
  BRIDGE_MAX_REQUEST_BYTES,
  BRIDGE_PROTOCOL,
  parseBridgeRequest,
  type BridgeErrorCode,
  type BridgeFile,
  type BridgeResponse,
} from '@third-wheel/core';
import { WebSocketServer, type WebSocket } from 'ws';

/** About the connection a call came in on. */
export interface BridgeCallContext {
  /** Aborted when the caller's connection closes (the MCP tool call was cancelled or ended). */
  readonly signal: AbortSignal;
}

/** Handles one method; the result is sent as `{ result }`. Throw `BridgeMethodError` for a coded error. */
export type BridgeHandler = (params: unknown, context: BridgeCallContext) => unknown;

export class BridgeMethodError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface BridgeOptions {
  /** Where to write the bridge file (port + token). */
  readonly filePath: string;
  readonly version: string;
  readonly handlers: Readonly<Record<string, BridgeHandler>>;
}

export interface Bridge {
  readonly port: number;
  /** Stop listening, drop clients, remove the bridge file if it is still ours. */
  close(): Promise<void>;
  /** Same, blocking (process exit): only removes the file; the sockets die with the process. */
  removeFileSync(): void;
}

const HOST = '127.0.0.1';

export async function startBridge(options: BridgeOptions): Promise<Bridge> {
  const token = randomBytes(32).toString('hex');
  const expected = Buffer.from(`Bearer ${token}`);
  let port = 0;

  const wss = new WebSocketServer({
    host: HOST,
    port: 0, // any free port; clients find it in the bridge file
    maxPayload: BRIDGE_MAX_REQUEST_BYTES,
    verifyClient: (
      { req }: { req: IncomingMessage },
      done: (ok: boolean, code?: number) => void,
    ) => {
      done(...checkClient(req, expected, () => port));
    },
  });
  await new Promise<void>((ok, fail) => {
    wss.once('listening', ok);
    wss.once('error', fail);
  });
  const address = wss.address();
  if (address === null || typeof address === 'string')
    throw new Error('Bridge: unexpected address');
  port = address.port;
  // Later server errors are logged, never thrown in the main process.
  wss.on('error', (err) => {
    console.error('App bridge error:', err);
  });

  wss.on('connection', (socket) => {
    const closed = new AbortController();
    socket.once('close', () => {
      closed.abort(new Error('connection closed'));
    });
    const context: BridgeCallContext = { signal: closed.signal };
    socket.on('message', (data, isBinary) => {
      const text = isBinary ? '' : (data as Buffer).toString('utf8');
      void answer(text, options.handlers, context).then((response) => {
        send(socket, response);
      });
    });
  });

  const file: BridgeFile = {
    app: 'third-wheel',
    protocol: BRIDGE_PROTOCOL,
    port,
    token,
    pid: process.pid,
    version: options.version,
  };
  try {
    writeBridgeFile(options.filePath, file);
  } catch (err) {
    wss.close();
    throw err;
  }

  const removeFileSync = (): void => {
    // Another app copy started later owns the file now: leave its file alone.
    try {
      const current = JSON.parse(readFileSync(options.filePath, 'utf8')) as { token?: unknown };
      if (current.token === token) rmSync(options.filePath, { force: true });
    } catch {
      // gone or unreadable: nothing to remove
    }
  };

  return {
    port,
    removeFileSync,
    close: () =>
      new Promise<void>((done) => {
        removeFileSync();
        for (const client of wss.clients) client.terminate();
        wss.close(() => {
          done();
        });
      }),
  };
}

/** Refuse a connection unless it carries the token and comes as a plain local client (not a web page). */
function checkClient(
  req: IncomingMessage,
  expected: Buffer,
  port: () => number,
): [boolean, number?] {
  // Browsers always send Origin; our Node client never does. Blocks web pages outright.
  if (req.headers.origin !== undefined) return [false, 403];
  // DNS rebinding: a page's name pointing at 127.0.0.1 would arrive with its own Host.
  const host = req.headers.host;
  if (host !== `${HOST}:${String(port())}` && host !== `localhost:${String(port())}`)
    return [false, 403];
  const given = Buffer.from(req.headers.authorization ?? '');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return [false, 401];
  return [true];
}

async function answer(
  text: string,
  handlers: Readonly<Record<string, BridgeHandler>>,
  context: BridgeCallContext,
): Promise<BridgeResponse> {
  const parsed = parseBridgeRequest(text);
  if (!parsed.ok) return parsed.response;
  const { id, method, params } = parsed.request;
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
  if (!handler)
    return { id, error: { code: 'unknown_method', message: `Unknown method "${method}"` } };
  try {
    return { id, result: (await handler(params, context)) ?? null };
  } catch (err) {
    if (err instanceof BridgeMethodError)
      return { id, error: { code: err.code, message: err.message } };
    return {
      id,
      error: { code: 'failed', message: err instanceof Error ? err.message : String(err) },
    };
  }
}

function send(socket: WebSocket, response: BridgeResponse): void {
  if (socket.readyState !== socket.OPEN) return;
  let text: string;
  try {
    text = JSON.stringify(response);
  } catch (err) {
    text = JSON.stringify({
      id: response.id,
      error: { code: 'failed', message: `Answer not serialisable: ${String(err)}` },
    });
  }
  socket.send(text);
}

/** Write the bridge file readable only by this user (temp file + rename: never half a file). */
function writeBridgeFile(path: string, file: BridgeFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    // Before the rename: the token is never readable by others under its real name. A renamed
    // file keeps its own access list on Windows.
    restrictToUser(tmp);
    renameWithRetry(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Runs a program and waits (`execFileSync`'s shape, so tests can stand in). */
export type RunProgram = (file: string, args: readonly string[]) => unknown;

/**
 * Windows ignores the `0o600` mode: there, drop the access the file inherits from its folder and
 * give only this user full access (`icacls`). Fails soft with a warning — the file sits in the
 * user's own profile folder, which other users can't read by default. Elsewhere: nothing to do.
 * @returns whether the access list was set (false on other systems and on failure).
 */
export function restrictToUser(
  path: string,
  platform: string = process.platform,
  run: RunProgram = (file, args) =>
    execFileSync(file, args, { stdio: 'ignore', timeout: 10_000, windowsHide: true }),
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (platform !== 'win32') return false;
  const user = windowsUser(env);
  try {
    // By full path: a bare name could find an icacls.exe in the current folder first.
    const icacls = win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'icacls.exe');
    run(icacls, [path, '/inheritance:r', '/grant:r', `${user}:F`]);
    return true;
  } catch (err) {
    console.warn(`Could not make ${path} readable only by ${user}:`, err);
    return false;
  }
}

/** `DOMAIN\user` for the signed-in Windows user (just the name when the domain is unknown). */
function windowsUser(env: Readonly<Record<string, string | undefined>>): string {
  const name = env['USERNAME'] ?? userInfo().username;
  const domain = env['USERDOMAIN'];
  return domain ? `${domain}\\${name}` : name;
}

/** Codes Windows gives while antivirus / the indexer briefly holds a file. */
const BUSY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 4 || !BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}
