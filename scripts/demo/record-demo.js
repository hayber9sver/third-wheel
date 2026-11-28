/* global window, document */
// Records the README demo GIF's frames: drives the built app (`pnpm build` first) and plays the
// AI agent through the built MCP server, as Claude Code does when it listens to the Agent tab
// (wait_for_message in a loop). The story, on the Square Wheel test model: you ask for the cube
// in the chat, brush the antenna (#1) and select the pin's hole (#2), ask about both, the agent
// answers under each comment, you reply "do it" under #2, it opens the next version (only the
// pin changed: scripts/demo/square-wheel_v2.step, made with `square_wheel.py <folder> <name>
// --loose-pin`), you confirm, and the "round wheel" joke gets a no. A caption pill is drawn into the page; only the app's
// page is captured, never the screen.
//   node scripts/demo/record-demo.js <framesDir>
//   then: node scripts/demo/encode-gif.js <framesDir> docs/images/demo.gif <helpersDir>
import { createRequire } from 'node:module';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const outDir = resolve(process.argv[2] ?? join(repo, 'node_modules', '.cache', 'demo-frames'));
const appDir = resolve(repo, 'apps/desktop');
const req = createRequire(join(appDir, 'package.json'));
const { _electron: electron } = req('@playwright/test');
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(
  req.resolve('@modelcontextprotocol/sdk/client/stdio.js')
);

// Points on the model (mm): the front antenna's rod (x, y; it runs up from z 29 to the ball at
// z 36.5), and the inside of the cube's middle side hole (Ø5.1; the wheel's pin sits in it, so
// it shows while the wheel is hidden).
const ANTENNA = [0.5, -12.6];
const HOLE_POINT = [13.5, -1.6, 13.0];

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-demo-')));
// The project folder's name shows in the app, so it is the model's name. It starts empty: the
// "agent" puts each STEP file in when it has "built" it.
const dir = join(tmp, 'square-wheel');
mkdirSync(dir);
const v1File = join(repo, 'test-models/square-wheel/square-wheel.step');
const v2File = join(here, 'square-wheel_v2.step');
const bridgeFile = join(tmp, 'bridge.json');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_RENDERER_URL;
const app = await electron.launch({
  args: [appDir, `--user-data-dir=${join(tmp, 'profile')}`, '--force-device-scale-factor=1'],
  env: { ...env, THIRD_WHEEL_TEST: '1', THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
});
const page = await app.firstWindow();
await app.evaluate(({ BrowserWindow }) => {
  const w = BrowserWindow.getAllWindows()[0];
  w.setContentSize(1120, 720);
  w.center();
});
await page.emulateMedia({ colorScheme: 'light' });
await page.waitForTimeout(1500);

// Caption pill, drawn into the page for the recording only; centred over the free part of the
// 3D view (between the left panel and the right one).
await page.addStyleTag({
  content: `#demo-cap{position:fixed;left:584px;bottom:64px;transform:translateX(-50%);z-index:99999;
  font:600 16px/1.3 system-ui,-apple-system,sans-serif;padding:8px 16px;border-radius:999px;
  background:rgba(20,22,28,.88);color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.25);white-space:nowrap;pointer-events:none}
  #demo-cap b{display:inline-block;margin-right:9px;padding:1px 9px;border-radius:999px;font-size:13px}
  #demo-cap b.ai{background:#8b5cf6}#demo-cap b.you{background:#2f7cf6}`,
});
const caption = (who, text) =>
  page.evaluate(
    ([w, t]) => {
      let el = document.getElementById('demo-cap');
      if (!el) {
        el = document.createElement('div');
        el.id = 'demo-cap';
        document.body.append(el);
      }
      el.innerHTML = `<b class="${w === 'AI' ? 'ai' : 'you'}">${w === 'AI' ? 'AI agent' : 'You'}</b>`;
      el.append(t);
    },
    [who, text],
  );

let n = 0;
const frames = [];
const snap = async (holdMs) => {
  const file = join(outDir, `f${String(n++).padStart(4, '0')}.png`);
  await page.screenshot({ path: file });
  frames.push({ file, delay: holdMs });
};
const loaded = () =>
  page.waitForFunction(() => window.__thirdWheelTest?.loaded() === true, null, { timeout: 60000 });
const canvasBox = () => page.locator('#viewport canvas').first().boundingBox();
const at = (p) => page.evaluate((q) => window.__thirdWheelTest.viewport.projectToCanvas(q), p);
const moveAway = async () => {
  const box = await canvasBox();
  await page.mouse.move(box.x + box.width - 40, box.y + box.height - 40);
};
/** Types into a text box a few characters per frame, as a person would. */
const typeInto = async (input, text) => {
  for (let i = 4; i <= text.length; i += 4) {
    await input.fill(text.slice(0, i));
    if (i % 12 === 0) await snap(80);
  }
  await input.fill(text);
  await snap(700);
};

// 1. An empty project folder, the Agent tab open, the agent ("claude-code") listening.
await app.evaluate(({ dialog }, f) => {
  dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
}, dir);
await page.locator('#empty-new-project').click();
await page.waitForTimeout(800);
// The project page names its folder: a short, usual-looking one instead of the temp folder.
await page.evaluate(() => {
  const folder = document.getElementById('empty-folder');
  if (folder) folder.textContent = '~/cad/square-wheel';
});
await page.locator('#tab-chat').click();

const client = new Client({ name: 'claude-code', version: '1' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(repo, 'packages/mcp-server/build/third-wheel-mcp.js')],
    cwd: dir,
    env: { ...env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
    stderr: 'ignore',
  }),
);
/** A tool call; returns its answer (the last text part, parsed when it is JSON). */
const tool = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content.at(-1)?.text ?? 'null';
  if (r.isError) throw new Error(`${name}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text; // a plain answer, e.g. "Shown."
  }
};
/** The agent's listen loop: resolves with the user's next message(s). */
const nextMessage = async () => {
  for (;;) {
    const r = await client.callTool({ name: 'wait_for_message', arguments: {} });
    const body = JSON.parse(r.content[0]?.text ?? 'null');
    if (body?.state === 'message' && body.messages.length > 0) return body.messages;
  }
};
const progress = async (text, holdMs = 1100) => {
  await tool('post_progress', { text });
  await page.waitForTimeout(250);
  await snap(holdMs);
};
/** The agent's open wait: like Claude Code, it listens again as soon as it has answered. */
let pending;
const listen = () => {
  pending = nextMessage();
};
/** Types a chat message and sends it; resolves when the agent has it. */
const say = async (text) => {
  const input = page.locator('#chat-input');
  await input.click();
  await typeInto(input, text);
  await input.press('ControlOrMeta+Enter');
  await page.waitForTimeout(300);
  await snap(600);
  return pending;
};

// The first wait answers at once with the catch-up (no message yet): the tab shows it listening.
await client.callTool({ name: 'wait_for_message', arguments: {} });
listen();
await page.waitForTimeout(1200);
await caption('You', 'Talk to your AI agent in the Agent tab');
await snap(1800);

// 2. "Make the cube": the agent builds it and opens it here.
await say('Make the Square Wheel cube from the logo and open it here.');
await caption('AI', 'Builds it in your CAD, exports STEP');
await progress('Modelling the cube in CAD');
await progress('Exporting square-wheel.step', 900);
copyFileSync(v1File, join(dir, 'square-wheel.step'));
const { modelId } = await tool('load_model', { path: 'square-wheel.step' });
await loaded();
await tool('send_chat_message', {
  text: 'Here it is: a 30 mm cube, with the third wheel pinned into its side.',
});
listen();
await page.waitForTimeout(1000);
await moveAway();
await caption('AI', 'Opens it in Third Wheel');
await snap(2200);

// 3. Brush: paint the front antenna (a thin rod with a ball) and comment on it.
const box = await canvasBox();
await caption('You', 'Brush: paint the spot you mean');
// The toolbar button, not the B key: the chat's message box still has the focus.
const brush = page.locator('#tools button[aria-label="Brush"]');
await brush.hover();
await page.waitForTimeout(300);
await snap(700);
await brush.click();
const stroke = [];
for (let z = 29.6; z <= 36.6; z += 0.5) stroke.push(await at([ANTENNA[0], ANTENNA[1], z]));
await page.mouse.move(box.x + stroke[0].x, box.y + stroke[0].y, { steps: 6 });
await page.waitForTimeout(200);
await snap(900);
await page.mouse.down();
for (let i = 1; i < stroke.length; i++) {
  await page.mouse.move(box.x + stroke[i].x, box.y + stroke[i].y, { steps: 3 });
  if (i % 3 === 0) await snap(120);
}
await page.mouse.up();
await snap(1000);
await caption('You', 'Comment on it: #1');
await page.locator('#comment-add').click();
await typeInto(
  page.locator('#comments .comment-box textarea'),
  'These antennas look fragile. Will they print?',
);
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(300);
await moveAway();
await snap(900);

// 4. Select: hide the wheel, pick the hole its pin sits in (its Ø is drawn), a new marker, #2.
await page.locator('#tools button[aria-label="Select"]').click();
await page.locator('#tab-bodies').click();
await caption('You', 'Or select: the hole the pin sits in, #2');
await page.locator('button[data-body="1"]').click();
await page.waitForTimeout(500);
const hole = await at(HOLE_POINT);
await page.mouse.move(box.x + hole.x, box.y + hole.y, { steps: 6 });
await page.waitForTimeout(150);
await page.mouse.click(box.x + hole.x, box.y + hole.y);
await page.waitForTimeout(400);
await moveAway();
await snap(1600);
await page.locator('#add-to-marker').click();
await page.getByRole('menuitem', { name: 'New marker' }).click();
await page.waitForTimeout(300);
await page.locator('#comment-add').click();
await typeInto(
  page.locator('#comments .comment-box textarea'),
  'Will the pin fit in this hole when printed?',
);
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(300);
await page.locator('button[data-body="1"]').click();
await page.locator('#tab-chat').click();
await page.waitForTimeout(300);
await snap(900);

// 5. Ask about both in the chat: the agent answers under each comment. A question needs no
// new version (the small loop).
await caption('You', 'Ask about them');
await say('What do you think of #1 and #2?');
await caption('AI', 'Answers under #1 and #2');
await progress('Reading comments #1 and #2', 800);
const ann = await tool('get_annotations', { modelId });
const antennaComment = ann.comments.find((c) => c.n === 1);
const pinComment = ann.comments.find((c) => c.n === 2);
await tool('reply_to_comment', {
  modelId,
  commentId: antennaComment.id,
  text: 'They are Ø1.6 mm rods, 7.5 mm tall: they print with a 0.4 mm nozzle if you slow down for the top layers. Fine to keep.',
});
await tool('reply_to_comment', {
  modelId,
  commentId: pinComment.id,
  text: 'The pin is Ø5.0 in this Ø5.1 hole: only 0.1 mm of play. That is too tight for FDM printing; 0.25 mm is usual. Shall I make the pin Ø4.85?',
});
listen();
await page.waitForTimeout(600);
await snap(1600);
await page.locator('#chat-log').getByText('Replied under #2').click();
await page.waitForTimeout(500);
await snap(3400);

// 6. Reply under #2: it goes to the agent at once. It edits the CAD; the next version opens
// with the notes moved over (the big loop).
const card = page.locator(`#comments li[data-comment="${pinComment.id}"]`);
await caption('You', 'Reply under #2');
const reply = card.locator('.reply-input');
await reply.click();
await typeInto(reply, 'Yes, make it 0.25 mm.');
await card.locator('#reply-post').click();
await page.waitForTimeout(300);
await snap(600);
await pending;
await caption('AI', 'Changes it in your CAD: v2 opens with your notes');
await progress('Changing the pin in CAD');
await progress('Exporting square-wheel_v2.step', 900);
copyFileSync(v2File, join(dir, 'square-wheel_v2.step'));
const v2 = await tool('load_model', { path: 'square-wheel_v2.step', revisionOf: modelId });
await loaded();
await tool('set_comment_status', {
  modelId: v2.modelId,
  commentId: pinComment.id,
  status: 'resolved',
  note: 'Done: the pin is Ø4.85 now, 0.25 mm of play.',
});
listen();
await page.waitForTimeout(1000);
await moveAway();
await snap(3000);

// 7. Review v2: confirm the fix.
await caption('You', 'Review v2: confirm the fix');
await page.locator('.comment-confirm').first().hover();
await snap(900);
await page.locator('.comment-confirm').first().click();
await page.waitForTimeout(800);
await snap(900);

// 8. One more question in the chat.
await caption('You', 'Anything else? Just ask');
await say("Square wheels don't roll. Make it round?");
await tool('send_chat_message', {
  text: "Won't fix: square wheels are the brand. It stays square.",
});
listen();
await page.waitForTimeout(800);
await caption('AI', 'Knows when to say no');
await snap(3600);

writeFileSync(join(outDir, 'frames.json'), JSON.stringify(frames));
pending.catch(() => {}); // the open wait ends with the connection
await client.close();
await app.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`${frames.length} frames`);
