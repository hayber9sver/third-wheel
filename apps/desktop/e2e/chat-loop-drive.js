/* global window -- page.evaluate callbacks run in the app window */
// Chat listen-loop driver (not a test): starts the built app + the built MCP server and plays the
// agent with a scripted MCP client; the user's messages go in through the window's API. Checks
// idle / message / progress / answer / cancelled wait / queued messages / re-delivery, prints the
// window's chat view and the debug log's events.
// Run from third-wheel/ after `pnpm build`: node apps/desktop/e2e/chat-loop-drive.js <out-folder>
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const out = resolve(process.argv[2] ?? 'chat-loop-out');
mkdirSync(out, { recursive: true });
const bridgeFile = join(out, 'bridge.json');
const log = join(out, 'chat-log.jsonl');
const env = { ...process.env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile, THIRD_WHEEL_CHAT_LOG: log };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({
  args: ['apps/desktop', `--user-data-dir=${join(out, 'profile')}`],
  env: { ...env, THIRD_WHEEL_CHAT_WAIT_SEC: '3' },
});
const page = await app.firstWindow();
await page.waitForLoadState('domcontentloaded');

/** A scripted agent: its own MCP server process (like one Claude Code session). */
async function agent(name) {
  const client = new Client({ name, version: '1' });
  await client.connect(
    new StdioClientTransport({
      command: 'node',
      args: ['packages/mcp-server/build/third-wheel-mcp.js'],
      env,
    }),
  );
  return client;
}
const text = (r) => r.content.map((c) => c.text).join(' | ');
const say = (msg) => page.evaluate((m) => window.thirdWheel.chatSend(m), msg);
const view = () => page.evaluate(() => window.thirdWheel.chatView());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = (client, opts) =>
  client.callTool({ name: 'wait_for_message', arguments: {} }, undefined, opts);

console.log('state before any agent:', (await view()).status.state);
const a = await agent('agent-a');

let t = Date.now();
console.log('idle:', text(await wait(a)), Date.now() - t, 'ms');

const pending = wait(a);
await sleep(300);
console.log('state while waiting:', (await view()).status.state);
t = Date.now();
await say('make the hole 8 mm');
console.log('message:', text(await pending), Date.now() - t, 'ms');
console.log('state after hand-over:', (await view()).status.state);
await a.callTool({ name: 'post_progress', arguments: { text: 'Editing the CAD script' } });
await say('also round the corners'); // while it works: queued
console.log('queued while working:', (await view()).status.queued);
await a.callTool({
  name: 'send_chat_message',
  arguments: { text: 'Done: hole is now **Ø8 mm**.' },
});
console.log('next wait (acks, gets the queued one):', text(await wait(a)));

// Cancelled wait (Esc / client timeout): the next messages must not be lost.
const ac = new AbortController();
const cancelled = wait(a, { signal: ac.signal }).catch((e) => `aborted: ${e.message}`);
await sleep(300);
ac.abort('driver');
console.log('cancel:', await cancelled);
await sleep(300);
await say('two');
await say('three');
console.log('after cancel, together:', text(await wait(a)));

// The agent dies before handling a delivery; a new session's first wait gets it again.
await say('four');
const lost = await wait(a);
console.log('handed to the dying agent:', text(lost));
await a.close();
const b = await agent('agent-b');
console.log('new session gets it again:', text(await wait(b)));

const v = await view();
console.log('chat:', v.entries.map((e) => `${e.seq}:${e.kind}`).join(' '));
await page.screenshot({ path: join(out, 'window.png') });
console.log(
  'log:',
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l).event)
    .join(' '),
);
await b.close();
await app.close();
