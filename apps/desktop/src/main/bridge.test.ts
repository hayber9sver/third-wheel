/**
 * App bridge over a real localhost socket: the app side (`bridge.ts`) with the MCP server's
 * client (`@third-wheel/mcp-server`). The window round-trip is covered by the e2e test.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BridgeError,
  connectBridge,
  readBridgeFile,
  type BridgeClient,
} from '@third-wheel/mcp-server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import {
  BridgeMethodError,
  restrictToUser,
  startBridge,
  type Bridge,
  type BridgeHandler,
} from './bridge.js';

let dir: string;
let filePath: string;
const bridges: Bridge[] = [];
const clients: BridgeClient[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'third-wheel-bridge-'));
  filePath = join(dir, 'sub', 'bridge.json');
});

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const b of bridges.splice(0)) await b.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(handlers: Record<string, BridgeHandler> = {}): Promise<Bridge> {
  const bridge = await startBridge({ filePath, version: '1.2.3', handlers });
  bridges.push(bridge);
  return bridge;
}

async function connect(): Promise<BridgeClient> {
  const client = await connectBridge({ filePath });
  clients.push(client);
  return client;
}

async function rejection(p: Promise<unknown>): Promise<BridgeError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(BridgeError);
    return err as BridgeError;
  }
  throw new Error('expected a rejection');
}

/** Raw upgrade with chosen headers → HTTP status of the refusal, or 101 when it opened. */
function rawStatus(port: number, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${String(port)}`, { headers });
    ws.once('open', () => {
      ws.close();
      resolve(101);
    });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('error', () => {
      // after unexpected-response
    });
  });
}

describe('app bridge', () => {
  it('tells a handler when the caller closes its connection (a cancelled tool call)', async () => {
    let signal: AbortSignal | undefined;
    const aborted = new Promise<void>((resolve) => {
      void start({
        hold: (_params, context) => {
          signal = context.signal;
          context.signal.addEventListener('abort', () => {
            resolve();
          });
          return new Promise(() => undefined);
        },
      }).then(async () => {
        const client = await connect();
        void client.call('hold', {}).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 50));
        expect(signal?.aborted).toBe(false);
        client.close();
      });
    });
    await aborted;
    expect(signal?.aborted).toBe(true);
  });

  it('writes a bridge file with port and token, readable only by the user', async () => {
    const bridge = await start();
    const file = await readBridgeFile(filePath);
    expect(file).toMatchObject({
      app: 'third-wheel',
      protocol: 1,
      port: bridge.port,
      version: '1.2.3',
      pid: process.pid,
    });
    expect(file.token).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') expect(statSync(filePath).mode & 0o777).toBe(0o600);
    else {
      // Windows ignores the mode: the access list must hold this user, nothing inherited, and no
      // other account. An elevated process (CI runs as an administrator) also gets SYSTEM and
      // Administrators on the files it creates: they can open any file anyway, so they may stay.
      const acl = execFileSync('icacls', [filePath], { encoding: 'utf8' });
      const entries = acl.split(/\r?\n/).filter((line) => /:\([A-Z,()]+\)\s*$/.test(line));
      const user = process.env['USERNAME'] ?? '';
      expect(
        entries.filter((e) => e.includes(user)),
        acl,
      ).toHaveLength(1);
      const others = entries.filter(
        (e) => !e.includes(user) && !/NT AUTHORITY\\SYSTEM:|BUILTIN\\Administrators:/.test(e),
      );
      expect(others, acl).toEqual([]);
      expect(acl).not.toContain('(I)');
    }
  });

  it('on Windows asks icacls to drop inherited access and grant only the user; elsewhere does nothing', () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const run = (file: string, args: readonly string[]) => calls.push({ file, args });
    const env = { USERNAME: 'Ana', USERDOMAIN: 'PC1' };
    expect(restrictToUser('C:\\t\\bridge.json', 'darwin', run, env)).toBe(false);
    expect(calls).toEqual([]);
    expect(restrictToUser('C:\\t\\bridge.json', 'win32', run, env)).toBe(true);
    expect(calls).toEqual([
      {
        file: 'C:\\Windows\\System32\\icacls.exe',
        args: ['C:\\t\\bridge.json', '/inheritance:r', '/grant:r', 'PC1\\Ana:F'],
      },
    ]);
    const failing = () => {
      throw new Error('icacls missing');
    };
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(restrictToUser('x', 'win32', failing, env)).toBe(false);
    } finally {
      console.warn = warn;
    }
  });

  it('answers requests, overlapping ones by id', async () => {
    await start({
      echo: (p) => p,
      slow: () =>
        new Promise((r) => {
          setTimeout(() => {
            r('slow');
          }, 30);
        }),
      nothing: () => undefined,
    });
    const client = await connect();
    const [slow, echo] = await Promise.all([
      client.call('slow'),
      client.call('echo', { a: [1, 2] }),
    ]);
    expect(slow).toBe('slow');
    expect(echo).toEqual({ a: [1, 2] });
    expect(await client.call('nothing')).toBeNull();
  });

  it('reports unknown methods and handler errors with codes', async () => {
    await start({
      boom: () => {
        throw new Error('kaput');
      },
      coded: () => Promise.reject(new BridgeMethodError('no_window', 'no window')),
    });
    const client = await connect();
    expect(await rejection(client.call('nope'))).toMatchObject({ code: 'unknown_method' });
    expect(await rejection(client.call('toString'))).toMatchObject({ code: 'unknown_method' });
    expect(await rejection(client.call('boom'))).toMatchObject({
      code: 'failed',
      message: 'kaput',
    });
    expect(await rejection(client.call('coded'))).toMatchObject({ code: 'no_window' });
  });

  it('answers a malformed message with bad_request and stays usable', async () => {
    const bridge = await start({ ping: () => 'pong' });
    const { token } = await readBridgeFile(filePath);
    const ws = new WebSocket(`ws://127.0.0.1:${String(bridge.port)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await new Promise((r) => ws.once('open', r));
    const replies: unknown[] = [];
    const got = new Promise<void>((done) => {
      ws.on('message', (d: Buffer) => {
        replies.push(JSON.parse(d.toString('utf8')));
        if (replies.length === 2) done();
      });
    });
    ws.send('not json');
    ws.send('{"id":5,"method":"ping"}');
    await got;
    ws.close();
    expect(replies).toEqual([
      { id: null, error: { code: 'bad_request', message: 'Message is not JSON' } },
      { id: 5, result: 'pong' },
    ]);
  });

  it('refuses a missing or wrong token, browser pages and foreign host names', async () => {
    const bridge = await start();
    const { token } = await readBridgeFile(filePath);
    const ok = `Bearer ${token}`;
    expect(await rawStatus(bridge.port, {})).toBe(401);
    expect(await rawStatus(bridge.port, { Authorization: `Bearer ${'0'.repeat(64)}` })).toBe(401);
    expect(
      await rawStatus(bridge.port, { Authorization: ok, Origin: 'https://evil.example' }),
    ).toBe(403);
    expect(
      await rawStatus(bridge.port, {
        Authorization: ok,
        Host: `evil.example:${String(bridge.port)}`,
      }),
    ).toBe(403);
    expect(await rawStatus(bridge.port, { Authorization: ok })).toBe(101);

    // The client's own wording when the token is stale (app restarted between read and connect).
    writeFileSync(
      filePath,
      JSON.stringify({ ...(await readBridgeFile(filePath)), token: 'f'.repeat(64) }),
    );
    expect(await rejection(connectBridge({ filePath }))).toMatchObject({ code: 'unauthorized' });
  });

  it('removes its file on close; the client then says the app is not running', async () => {
    const bridge = await start({ hang: () => new Promise(() => undefined) });
    const client = await connect();
    const pending = client.call('hang', undefined, 5000);
    await bridge.close();
    bridges.length = 0;
    expect(existsSync(filePath)).toBe(false);
    expect(await rejection(pending)).toMatchObject({ code: 'closed' });
    const err = await rejection(connectBridge({ filePath }));
    expect(err.code).toBe('not_running');
    expect(err.message).toContain('not running');
  });

  it('a file left by a crashed app (nobody listening) → not running', async () => {
    const bridge = await start();
    const stale = readFileSync(filePath, 'utf8');
    await bridge.close();
    bridges.length = 0;
    writeFileSync(filePath, stale);
    expect(await rejection(connectBridge({ filePath }))).toMatchObject({ code: 'not_running' });
  });

  it('a later app copy owns the file; closing the first leaves it', async () => {
    const first = await start();
    const second = await start({ who: () => 'second' });
    expect((await readBridgeFile(filePath)).port).toBe(second.port);
    await first.close();
    expect(existsSync(filePath)).toBe(true);
    expect(await (await connect()).call('who')).toBe('second');
  });

  it('times out a call the app never answers', async () => {
    await start({ hang: () => new Promise(() => undefined) });
    const client = await connect();
    expect(await rejection(client.call('hang', undefined, 50))).toMatchObject({ code: 'timeout' });
  });
});
