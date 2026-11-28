/**
 * Client side of the app bridge: find the running app through its bridge file, connect
 * with the token, send requests. Protocol: `@third-wheel/core` bridge.ts.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_PROTOCOL,
  bridgeFileSchema,
  bridgeFileSegments,
  bridgeResponseSchema,
  type BridgeFile,
} from '@third-wheel/core';
import WebSocket from 'ws';

/** Why a bridge call failed. `not_running`: no app to talk to (start it). Others come from the app. */
export class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BridgeError';
  }
}

const NOT_RUNNING = 'Third Wheel is not running — open the app first.';

/** Default bridge file for this user (or `THIRD_WHEEL_BRIDGE_FILE`). */
export function defaultBridgeFilePath(): string {
  return join(...bridgeFileSegments(process.platform, process.env, homedir()));
}

/** Read and check the bridge file; `not_running` when it is missing or unusable. */
export async function readBridgeFile(path = defaultBridgeFilePath()): Promise<BridgeFile> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      throw new BridgeError('not_running', NOT_RUNNING);
    throw err;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new BridgeError('not_running', `${NOT_RUNNING} (bridge file unreadable: ${path})`);
  }
  const parsed = bridgeFileSchema.safeParse(json);
  if (!parsed.success)
    throw new BridgeError('not_running', `${NOT_RUNNING} (bridge file unreadable: ${path})`);
  if (parsed.data.protocol !== BRIDGE_PROTOCOL)
    throw new BridgeError(
      'version_mismatch',
      `Third Wheel ${parsed.data.version} speaks bridge protocol ${String(parsed.data.protocol)}, this MCP server ${String(BRIDGE_PROTOCOL)} — update both to the same version.`,
    );
  return parsed.data;
}

export interface BridgeClient {
  /** Send one request; resolves with its `result`, rejects with a `BridgeError`. */
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  close(): void;
}

export interface ConnectOptions {
  /** Bridge file to read (default: `defaultBridgeFilePath()`). */
  readonly filePath?: string;
  /** Give up connecting after this long (default 5 s). */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** Connect to the running app. Rejects with `BridgeError` (`not_running`, `unauthorized`, …). */
export async function connectBridge(options: ConnectOptions = {}): Promise<BridgeClient> {
  const file = await readBridgeFile(options.filePath);
  const socket = new WebSocket(`ws://127.0.0.1:${String(file.port)}`, {
    headers: { Authorization: `Bearer ${file.token}` },
    handshakeTimeout: options.connectTimeoutMs ?? 5000,
  });
  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => {
      resolve();
    });
    // Stays on: `terminate()` below emits one more error; rejecting a settled promise is a no-op.
    socket.on('error', (err) => {
      reject(connectError(err));
    });
    socket.once('unexpected-response', (_req, res) => {
      reject(
        res.statusCode === 401
          ? new BridgeError(
              'unauthorized',
              'Third Wheel refused the connection (token changed — was the app restarted? try again).',
            )
          : new BridgeError(
              'refused',
              `Third Wheel refused the connection (HTTP ${String(res.statusCode)}).`,
            ),
      );
      socket.terminate();
    });
  });

  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const failAll = (err: BridgeError): void => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(err);
    }
  };

  socket.on('message', (data: Buffer) => {
    let parsed;
    try {
      parsed = bridgeResponseSchema.safeParse(JSON.parse(data.toString('utf8')));
    } catch {
      return; // not JSON: ignore
    }
    if (!parsed.success || typeof parsed.data.id !== 'number') return;
    const p = pending.get(parsed.data.id);
    if (!p) return; // timed out already
    pending.delete(parsed.data.id);
    clearTimeout(p.timer);
    if ('error' in parsed.data)
      p.reject(new BridgeError(parsed.data.error.code, parsed.data.error.message));
    else p.resolve(parsed.data.result);
  });
  socket.on('close', () => {
    failAll(new BridgeError('closed', 'Third Wheel closed the connection (was the app quit?).'));
  });

  return {
    call(method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) {
      if (socket.readyState !== WebSocket.OPEN)
        return Promise.reject(new BridgeError('closed', 'Not connected to Third Wheel.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new BridgeError(
              'timeout',
              `Third Wheel did not answer "${method}" in ${String(timeoutMs / 1000)} s.`,
            ),
          );
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

function connectError(err: Error): BridgeError {
  const code = (err as NodeJS.ErrnoException).code;
  // A bridge file left behind by a crashed app points at a port nobody listens on.
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET')
    return new BridgeError('not_running', NOT_RUNNING);
  return new BridgeError('connect_failed', `Cannot connect to Third Wheel: ${err.message}`);
}
