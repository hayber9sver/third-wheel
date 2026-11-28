/**
 * e2e: the Agent chat with a scripted agent over the real MCP server.
 */
import type { Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve, join, basename } from 'node:path';
import { realpathSync, mkdtempSync, copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { readProjectOf } from './notes.js';
import {
  app,
  appDir,
  bridgeFile,
  closeApp,
  dir,
  expect,
  type HookWindow,
  launchApp,
  listenOnce,
  loadedWindow,
  openStubbed,
  test,
} from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

/**
 * An agent listened once this app session (the Agent tab's message box unlocks): one
 * wait_for_message over the real MCP server (a new connection is answered at once), then it goes
 * and its "stopped listening" line is written. Only while the box is locked: lets a chat test that
 * types run on its own (`-g`).
 */
async function agentListenedOnce(page: Page, cwd: string): Promise<void> {
  await page.locator('#tab-chat').click();
  const unlocked = await page.locator('#chat-compose').isVisible();
  if (!unlocked) await listenOnce(cwd, page);
  await page.locator('#tab-bodies').click();
}

test('Chat: the message box is locked until an agent listens; a scripted agent walks the states; queued messages go together', async () => {
  const page = await loadedWindow(); // a project is open (the message box needs one)
  await page.evaluate(() => {
    (window as HookWindow).__thirdWheelTest?.chatHintMs(400);
  });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  // Named like Claude Code's own MCP client: the chat shows "Claude Code".
  const agent = new Client({ name: 'claude-code', version: '1' });
  type Content = { type: string; text?: string }[];
  /** The result's first text (a message hand-over: pure JSON; other results: JSON + a hint). */
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const r = (await agent.callTool({ name, arguments: args })) as { content: Content };
    return r.content[0]?.text ?? '';
  };
  const messages = async (): Promise<unknown> =>
    JSON.parse(await tool('wait_for_message')) as unknown;
  const state = page.locator('#chat-state');
  const log = page.locator('#chat-log');
  const send = async (text: string): Promise<void> => {
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-input').press('ControlOrMeta+Enter');
    await expect(page.locator('#chat-input')).toHaveValue('');
  };

  await page.locator('#tab-chat').click();
  await expect(page.locator('#chat')).toBeVisible();
  await expect(state).toHaveAttribute('data-dot', 'grey');
  await expect(state).toHaveText('No agent connected');
  // No agent yet: a card with the connect steps and the start phrase replaces the message box.
  const locked = page.locator('#chat-locked [data-lock="agent"]');
  await expect(locked).toBeVisible();
  await expect(page.locator('#chat-compose')).toBeHidden();
  await expect(locked.locator('.chat-command code')).toContainText(
    "If you don't have that tool, say so and stop.",
  );
  await expect(locked.locator('[data-connect]')).toHaveText('How to set it up…');
  await expect(log.locator('.chat-help')).toHaveCount(0); // the steps are on the card only

  await agent.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js')],
      cwd: dir,
      env: { ...env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
      stderr: 'ignore',
    }),
  );
  try {
    // The first wait comes back at once with the catch-up; the box unlocks.
    expect(await messages()).toMatchObject({ state: 'message', messages: [] });
    await expect(page.locator('#chat-compose')).toBeVisible();
    await expect(page.locator('#chat-locked')).toBeHidden();
    // Its next wait is open: listening, in the tab and in the status bar.
    const first = messages();
    await expect(state).toHaveText('Claude Code · listening');
    await expect(page.locator('#ai-status')).toHaveText('AI: listening');
    await send('make the hole 8 mm');
    expect(await first).toMatchObject({
      state: 'message',
      messages: [{ text: 'make the hole 8 mm' }],
    });
    await expect(state).toHaveAttribute('data-dot', 'blue');
    await expect(state).toHaveText('Claude Code · working…');
    await expect(log.locator('.chat-user.queued')).toHaveCount(0);
    await expect(log.locator('.chat-working')).toBeVisible();
    await tool('post_progress', { text: 'Editing the CAD script' });
    await expect(log.locator('.chat-working .chat-progress')).toHaveText('Editing the CAD script');
    // No new line for a while: the permission hint (shortened for the test).
    await expect(log.locator('.chat-working .chat-hint')).toContainText(
      'asking for permission in its terminal',
    );

    // Two messages while it works: queued after the "…", handed over together next time.
    await send('also round the corners');
    await send('and a 1 mm chamfer');
    await expect(log.locator('.chat-user.queued')).toHaveCount(2);
    await expect(log.locator('.chat-note')).toHaveText('Queued · goes to the agent when it’s done');
    await tool('send_chat_message', { text: 'Done: the hole is now **Ø8 mm**.' });
    const answer = log.locator('.chat-agent:not(.chat-replied)[data-seq]').first();
    await expect(answer.locator('.chat-bubble strong')).toHaveText('Ø8 mm');
    await expect(answer.locator('.chat-steps summary')).toHaveText('1 step');
    expect(await messages()).toMatchObject({
      state: 'message',
      messages: [{ text: 'also round the corners' }, { text: 'and a 1 mm chamfer' }],
    });

    // Folded panel: the answer shows as unread on the Chat tab until the tab is opened.
    await page.locator('#left-fold').click();
    await tool('send_chat_message', { text: 'Rounded the corners (2 mm) and added the chamfer.' });
    await expect(page.locator('#chat-unread')).toBeVisible();
    await expect(page.locator('#chat-unread')).toHaveText('1');
    await page.locator('#tab-chat').click();
    await expect(page.locator('#chat')).toBeVisible();
    await expect(page.locator('#chat-unread')).toBeHidden();

    // Listening: a wait is open.
    const open = tool('wait_for_message');
    await expect(state).toHaveText('Claude Code · listening');
    await expect(state).toHaveAttribute('data-dot', 'green');
    expect(await open).toContain('{"state":"waiting"}');
  } finally {
    await agent.close();
  }
  // The agent stopped calling: after the grace the chat says so and shows the line to type.
  await expect(state).toHaveText('Claude Code · not listening', { timeout: 15_000 });
  await expect(state).toHaveAttribute('data-dot', 'amber');
  await expect(log.locator('.chat-help.warn [data-copy]')).toBeVisible();
  await expect(page.locator('#ai-status')).toHaveText(/AI: last call /);
  // Once an agent listened, the box stays open: messages wait for it.
  await expect(page.locator('#chat-input')).toHaveAttribute(
    'placeholder',
    'Message Claude Code… (queued)',
  );
  await send('are you there?');
  await expect(log.locator('.chat-user.queued')).toHaveCount(1);
  await page.locator('#tab-bodies').click();
});

test('Chat: Send review, the agent replies under a comment, the user answers in the thread', async () => {
  const page = await loadedWindow();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  const agent = new Client({ name: 'claude-code', version: '1' });
  type Content = { type: string; text?: string }[];
  const tool = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
    const r = (await agent.callTool({ name, arguments: args })) as { content: Content };
    return r.content[0]?.text ?? '';
  };
  interface About {
    kind: string;
    n?: number;
    commentId?: string;
    payload?: { comments: { id: string; n: number; text: string }[] };
    models?: { modelId: string; newComments: { id: string; n: number }[] }[];
  }
  /** Listens like an agent (waits are 2 s here) until a message comes; its last message. */
  const nextMessage = async (): Promise<{ text: string; about?: About }> => {
    for (let round = 0; round < 30; round++) {
      const text = await tool('wait_for_message');
      if (text.startsWith('{"state":"waiting"}')) continue;
      const r = JSON.parse(text) as { messages: { text: string; about?: About }[] };
      const last = r.messages.at(-1);
      if (last) return last;
    }
    throw new Error('no message');
  };
  const log = page.locator('#chat-log');
  await agent.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js')],
      cwd: dir,
      env: { ...env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
      stderr: 'ignore',
    }),
  );
  try {
    // Older messages from other tests are handed over first; then the agent listens.
    await tool('wait_for_message');
    const idle = tool('wait_for_message');
    await expect(page.locator('#chat-state')).toHaveText('Claude Code · listening');
    await idle;
    await expect(page.locator('#send-ai-label')).toHaveText('Send review');

    // A new comment waits for Send review (the count = comments the agent hasn't had).
    const section = page.locator('#comments');
    const before = Number((await page.locator('#send-ai-count').textContent()) || '0');
    await section.locator('#comment-add').click();
    await section.locator('textarea.comment-input:not(.reply-input)').fill('The lid needs a lip');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator('#send-ai-count')).toHaveText(String(before + 1));
    const listening = nextMessage();
    await page.locator('#send-ai').click();
    const review = (await listening).about;
    expect(review?.kind).toBe('review');
    await expect(page.locator('#send-ai-count')).toBeHidden();
    await expect(log.locator('.chat-review .chat-bubble')).toContainText('Review sent:');
    await expect(page.locator('#tab-chat')).toHaveAttribute('aria-selected', 'true');

    // The agent answers under the comment: a link line in the chat, a blue dot on the card.
    const card = page.locator('.comment-card', { hasText: 'The lid needs a lip' });
    const commentId = (await card.getAttribute('data-comment')) ?? '';
    const n = Number(((await card.locator('.comment-num').textContent()) ?? '#0').slice(1));
    // Earlier tests may have left unsent comments on other models of this session: they go too.
    const shown = review?.models?.find((m) =>
      m.newComments.some((c) => c.id === commentId && c.n === n),
    );
    expect(shown).toBeDefined();
    const modelId = shown?.modelId ?? '';
    expect(
      await tool('reply_to_comment', { modelId, commentId, text: 'How tall, 2 mm?' }),
    ).toContain('call wait_for_message');
    const link = log.locator('.chat-replied .chat-ref').last();
    await expect(link).toContainText(`Replied under #${String(n)} The lid needs a lip`);
    await expect(card.locator('.comment-unread')).toBeVisible();
    await link.click();
    await expect(card).toHaveClass(/focused/);
    await expect(card.locator('.comment-unread')).toHaveCount(0);

    // The user answers in the thread: it goes to the agent at once, with the comment's details.
    const answer = nextMessage();
    await card.locator('.reply-input').fill('Yes, 2 mm');
    await card.locator('#reply-post').click();
    const got = await answer;
    expect(got.text).toBe('Yes, 2 mm');
    expect(got.about).toMatchObject({ kind: 'thread', commentId, n });
    expect(got.about?.payload?.comments).toMatchObject([
      { id: commentId, n, text: 'The lid needs a lip' },
    ]);
    await expect(log.locator('.chat-thread .chat-ref').last()).toContainText(
      `You replied under #${String(n)}`,
    );
    // Already with the agent: Send review has nothing new from it.
    await expect(page.locator('#send-ai-count')).toBeHidden();
  } finally {
    await agent.close();
  }
  await page.locator('#tab-bodies').click();
});

test('Chat: saved in the project; model event lines; New topic; an earlier topic is read-only; the agent connects, catches up, leaves', async () => {
  const page = await loadedWindow();
  // A project of its own: the e2e folder's chat holds other tests' lines.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'third-wheel-chat-')));
  const part = join(root, 'part.step');
  const cover = join(root, 'cover.step');
  copyFileSync(join(dir, 'box.step'), part);
  copyFileSync(join(dir, 'lid.step'), cover);
  const open = async (file: string): Promise<void> => {
    await app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, file);
    await openStubbed();
    await expect(page.locator('#model-info')).toHaveText(
      new RegExp(`^${basename(file).replace(/[.()]/g, '\\$&')} · `),
      { timeout: 60_000 },
    );
  };
  const send = async (text: string): Promise<void> => {
    await page.locator('#chat-input').fill(text);
    await page.locator('#chat-input').press('ControlOrMeta+Enter');
    await expect(page.locator('#chat-input')).toHaveValue('');
  };
  const titles = (): string[] | undefined => readProjectOf(part)?.chats.map((c) => c.title);
  const log = page.locator('#chat-log');
  try {
    // The box needs an agent that listened this session (in the e2e folder's project).
    await agentListenedOnce(page, dir);
    await open(part);
    await page.locator('#tab-chat').click();
    await expect(log.locator('.chat-event').last()).toHaveText('Opened part.step');
    // Just looking writes nothing.
    expect(existsSync(join(root, '.thirdwheel'))).toBe(false);

    await send('First chat: make it lighter');
    await expect.poll(titles).toEqual(['First chat: make it lighter']);
    // Chats and the lock stay out of git unless the user removes the lines.
    const ignore = readFileSync(join(root, '.thirdwheel', '.gitignore'), 'utf8');
    expect(ignore.split('\n')).toEqual(expect.arrayContaining(['chats/', 'lock']));
    const first = readProjectOf(part)?.chats[0]?.id ?? '';
    const lines = (): { kind: string; text: string; model?: string }[] =>
      readFileSync(join(root, '.thirdwheel', 'chats', `${first}.jsonl`), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { kind: string; text: string; model?: string });
    expect(lines().map((l) => [l.kind, l.text])).toEqual([
      ['event', 'Opened part.step'],
      ['user', 'First chat: make it lighter'],
    ]);

    // Another model of the project: a line in the chat.
    await open(cover);
    await expect(log.locator('.chat-event').last()).toHaveText('Opened cover.step');

    // New chat: empty but for the model line since the last message; greyed until a message.
    await page.locator('#chat-new').click();
    await expect(log.locator('.chat-user')).toHaveCount(0);
    await expect(log.locator('.chat-event')).toHaveText(['Opened cover.step']);
    await expect(page.locator('#chat-new')).toBeDisabled();
    await send('Second chat');
    await expect.poll(titles).toEqual(['First chat: make it lighter', 'Second chat']);
    expect(lines()).toHaveLength(2); // the old chat got nothing more

    // 🕘: newest first; an old chat opens read-only with the way back.
    await page.locator('#chat-history').click();
    const items = page.locator('.context-menu [data-action^="chat-"]');
    await expect(items).toHaveCount(2);
    await expect(items.nth(0)).toContainText('Second chat');
    await expect(items.nth(1)).toContainText('First chat: make it lighter');
    await items.nth(1).click();
    await expect(page.locator('#chat-past')).toBeVisible();
    await expect(page.locator('#chat-past-title')).toContainText('First chat: make it lighter');
    await expect(page.locator('#chat-compose')).toBeHidden();
    await expect(log.locator('.chat-user .chat-bubble')).toHaveText([
      'First chat: make it lighter',
    ]);
    await page.screenshot({ path: 'test-results/chat-past.png' });
    await page.locator('#chat-back').click();
    await expect(page.locator('#chat-past')).toBeHidden();
    await expect(page.locator('#chat-compose')).toBeVisible();
    await expect(log.locator('.chat-user .chat-bubble')).toHaveText(['Second chat']);
    await page.screenshot({ path: 'test-results/chat-current.png' });

    // An agent connects: "connected" line, a catch-up right away (folded line), the rail.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    const agent = new Client({ name: 'claude-code', version: '1' });
    type Content = { type: string; text?: string }[];
    const tool = async (name: string, args: Record<string, unknown> = {}): Promise<string> => {
      const r = (await agent.callTool({ name, arguments: args })) as { content: Content };
      return r.content[0]?.text ?? '';
    };
    await agent.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js')],
        cwd: root,
        env: { ...env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
        stderr: 'ignore',
      }),
    );
    try {
      const first = JSON.parse(await tool('wait_for_message')) as {
        catchUp?: { shown?: { file: string }; topic: { latest: unknown[] } };
        messages: { text: string; shown?: { file: string } }[];
      };
      expect(first.catchUp?.shown?.file).toBe('cover.step');
      // Messages still waiting (other topics too) go along, each naming the model it was about.
      expect(first.messages.map((m) => [m.text, m.shown?.file])).toEqual(
        expect.arrayContaining([
          ['First chat: make it lighter', 'part.step'],
          ['Second chat', 'cover.step'],
        ]),
      );
      await expect(log.locator('.chat-event', { hasText: 'Claude Code connected · ' })).toHaveCount(
        1,
      );
      const caught = log.locator('.chat-folded').last();
      await expect(caught.locator('summary')).toContainText('Caught up · cover.step');
      await caught.locator('summary').click();
      await expect(caught.locator('.chat-folded-body')).toContainText('On screen: cover.step');
      await expect(log.locator('.chat-rail')).toBeVisible();
      // The message it was handed is on the rail; nothing before it fades here (it is the first).
      await expect(log.locator('.before-rail')).toHaveCount(1); // the "Opened cover.step" line
      await tool('send_chat_message', { text: 'Made the cover **1 mm** thinner.' });
      const answer = log.locator('.chat-agent[data-seq]').last();
      await expect(answer.locator('.chat-agent-name')).toHaveText('Claude Code>_');
      expect(
        await tool('post_chat_summary', { text: 'Cover 1 mm thinner; part lighter: open' }),
      ).toContain('Stored');
      await expect(log.locator('.chat-folded summary').last()).toHaveText(
        'Saved a summary of this topic',
      );
      await expect
        .poll(() => readProjectOf(part)?.chats.at(-1)?.summary)
        .toBe('Cover 1 mm thinner; part lighter: open');
      const history = JSON.parse(await tool('get_chat_history', { limit: 50 })) as {
        topic: { title: string; current: boolean };
        lines: { kind: string; text: string }[];
        topics: unknown[];
      };
      expect(history.topic).toMatchObject({ title: 'Second chat', current: true });
      expect(history.lines.map((l) => l.kind)).toEqual(
        expect.arrayContaining(['user', 'joined', 'agent', 'summary']),
      );
      expect(history.topics).toHaveLength(2);
      await page.screenshot({ path: 'test-results/chat-agent-view.png' });

      // Asked here, then New topic while it works: the answer stays in the topic asked in.
      await send('Round the corners');
      await tool('wait_for_message');
      await page.locator('#chat-new').click();
      await expect(log.locator('.chat-user')).toHaveCount(0);
      await tool('send_chat_message', { text: 'Rounded the corners: R2.' });
      const note = log.locator('.chat-answered-in');
      await expect(note).toHaveText('Answered in topic “Second chat” →');
      await expect(log.locator('.chat-agent[data-seq]')).toHaveCount(0);
      await expect(page.locator('#chat-history')).toHaveAttribute('data-unread', '1');
      await page.screenshot({ path: 'test-results/chat-answered-in.png' });
      const secondId = readProjectOf(part)?.chats.at(-1)?.id ?? '';
      const secondLines = (): string[] =>
        readFileSync(join(root, '.thirdwheel', 'chats', `${secondId}.jsonl`), 'utf8')
          .trim()
          .split('\n')
          .map((l) => (JSON.parse(l) as { text: string }).text);
      await expect.poll(secondLines).toContain('Rounded the corners: R2.');
      // The note opens that topic (read-only); the count goes; new answers show there live.
      await note.click();
      await expect(page.locator('#chat-past-title')).toContainText('Second chat');
      await expect(log.locator('.chat-agent .chat-bubble').last()).toContainText('R2');
      await expect(page.locator('#chat-history')).not.toHaveAttribute('data-unread');
      await tool('send_chat_message', { text: 'Exported part_v2.step too.' });
      await expect(log.locator('.chat-agent .chat-bubble').last()).toContainText('part_v2.step');
      await page.locator('#chat-back').click();
      await expect(note).toHaveCount(1); // one note for the run of answers
      const h2 = JSON.parse(await tool('get_chat_history', {})) as {
        topic: { title: string; current: boolean };
      };
      expect(h2.topic).toMatchObject({ title: 'Second chat', current: true });
    } finally {
      await agent.close();
    }
    // It stopped calling: after the grace and the leave time the rail goes and its "stopped
    // listening" line is the last (an earlier test's agent may have left a line here too).
    await expect(log.locator('.chat-rail')).toHaveCount(0, { timeout: 20_000 });
    await expect(log.locator('.chat-event').last()).toContainText(
      'Claude Code stopped listening · ',
    );
  } finally {
    // Back to the box for the next tests.
    await open(join(dir, 'box.step'));
    await page.locator('#tab-bodies').click();
    rmSync(root, { recursive: true, force: true });
  }
});

test('Connect pop-up: Chat in Third Wheel — start line, start phrase, live status, fewer permission questions', async () => {
  const page = await loadedWindow(); // the box in the e2e folder: that folder is the project
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  /** An agent starting the real MCP server in `cwd` (it says hello once its handshake is done). */
  const start = async (cwd: string): Promise<Client> => {
    const agent = new Client({ name: 'claude-code', version: '1' });
    await agent.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js')],
        cwd,
        env: { ...env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
        stderr: 'ignore',
      }),
    );
    return agent;
  };
  const settings = join(dir, '.claude', 'settings.local.json');
  const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-elsewhere-')));
  await page.locator('#ai-status').click();
  const status = page.locator('#connect-chat-status');
  const agents: Client[] = [];
  try {
    await expect(page.locator('#connect-chat')).toBeVisible();
    await expect(page.locator('#connect-chat-start')).toHaveText(
      process.platform === 'win32' ? `cd -LiteralPath '${dir}'; claude` : `cd '${dir}' && claude`,
    );
    await expect(page.locator('#connect-chat-phrase')).toContainText(
      'call the third-wheel MCP tool wait_for_message',
    );
    // Started in another folder: connected, with a warning.
    agents.push(await start(elsewhere));
    await expect(status).toHaveAttribute('data-state', 'connected');
    await expect(page.locator('#connect-chat-warn')).toContainText(
      `not in the project folder “${basename(dir)}”`,
    );
    // Started in the project folder: connected, no warning; its first wait → listening.
    const agent = await start(dir);
    agents.push(agent);
    await expect(status).toHaveText(
      `Connected (started in “${basename(dir)}”) — now paste the start phrase (step 2).`,
    );
    await expect(page.locator('#connect-chat-warn')).toBeHidden();
    await agent.callTool({ name: 'wait_for_message', arguments: {} }); // new: answered at once
    await expect(status).toHaveAttribute('data-state', 'listening');

    // Ask fewer permission questions: the exact lines first, written only on the button.
    await page.locator('#connect-allow summary').click();
    const preview = page.locator('#connect-allow-preview');
    await expect(preview).toContainText(
      `Creates .claude/settings.local.json in “${basename(dir)}” with:`,
    );
    await expect(preview).toHaveAttribute('title', settings);
    await expect(preview).toContainText('"mcp__third-wheel"');
    await expect(preview).toContainText('"Bash(python *.py)"');
    expect(existsSync(settings)).toBe(false);
    await page.locator('#connect-allow-cad').fill('*');
    await expect(page.locator('#connect-allow-result')).toContainText('lone *');
    await expect(page.locator('#connect-allow-go')).toBeDisabled();
    await page.locator('#connect-allow-cad').fill('python *.py');
    await expect(page.locator('#connect-allow-go')).toBeEnabled();
    await page.screenshot({ path: 'test-results/connect-chat.png' });
    await page.locator('#connect-allow-go').click();
    await expect(page.locator('#connect-allow-result')).toContainText(`to ${settings} ✓`);
    const written = JSON.parse(readFileSync(settings, 'utf8')) as {
      permissions: { allow: string[] };
    };
    expect(written.permissions.allow).toEqual(
      expect.arrayContaining(['mcp__third-wheel', 'Bash(python *.py)']),
    );
    await expect(preview).toContainText('Already allowed in .claude/settings.local.json ✓');
    await expect(page.locator('#connect-allow-go')).toBeHidden();
  } finally {
    await Promise.all(agents.map((a) => a.close()));
    rmSync(join(dir, '.claude'), { recursive: true, force: true });
    rmSync(elsewhere, { recursive: true, force: true });
    await page.keyboard.press('Escape');
  }
});
