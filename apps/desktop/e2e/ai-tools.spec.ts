/**
 * e2e: what the AI side uses: region pictures, the app bridge, the MCP tools, the Connect pop-up,
 * the AI status.
 */
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { connectBridge } from '@third-wheel/mcp-server';
import { join, resolve, basename } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { _electron as electron } from '@playwright/test';
import {
  app,
  appDir,
  bridgeFile,
  claudeLog,
  closeApp,
  codexHome,
  dir,
  expect,
  copilotLog,
  fakeClaude,
  fakeCopilot,
  fakeGemini,
  geminiLog,
  type HookWindow,
  launchApp,
  loadedWindow,
  scaleArgs,
  test,
} from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Region render: paint and held faces, camera along the normal, view untouched', async () => {
  const page = await app.firstWindow();
  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const project = () =>
    page.evaluate(() =>
      (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
    );
  const viewBefore = await project();
  const result = await page.evaluate(async () => {
    const t = (window as HookWindow).__thirdWheelTest as unknown as {
      model(): { positions: Float32Array; indices: Uint32Array; triangleFace: Uint32Array };
      markers: {
        add(e: { kind: string; id: number }[]): { id: string; color: string };
      };
      paint(): { paint(tris: number[], id: string, locked: ReadonlySet<string>): number };
      viewport: { paintChanged(): void };
      renderRegion(
        ids: string[],
        size?: number,
      ): Promise<
        | {
            png: Uint8Array;
            size: number;
            viewDir: number[];
            up: number[];
            mmPerPx: number;
            ghosted: unknown[];
            renderMs: number;
            encodeMs: number;
          }
        | undefined
      >;
    };
    const m = t.model();
    // Triangles of the +X side (x = 10) and the top face (z = 30).
    const side: number[] = [];
    let topFace = -1;
    for (let tri = 0; tri < m.triangleFace.length; tri++) {
      const c = (k: number, d: number) => m.positions[(m.indices[tri * 3 + k] ?? 0) * 3 + d];
      if ([0, 1, 2].every((k) => c(k, 0) === 10)) side.push(tri);
      if ([0, 1, 2].every((k) => c(k, 2) === 30)) topFace = m.triangleFace[tri] ?? -1;
    }
    const painted = t.markers.add([]);
    t.paint().paint(side, painted.id, new Set());
    t.viewport.paintChanged();
    const held = t.markers.add([{ kind: 'face', id: topFace }]);

    const pixels = async (png: Uint8Array, size: number) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(png)], { type: 'image/png' }),
      );
      const c = new OffscreenCanvas(size, size);
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('no 2d');
      ctx.drawImage(bitmap, 0, 0);
      const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
      return { w: bitmap.width, centre: at(size / 2, size / 2), corner: at(1, 1) };
    };
    const first = await t.renderRegion([painted.id]);
    const a = await t.renderRegion([painted.id]); // warm
    const b = await t.renderRegion([held.id], 200);
    const none = await t.renderRegion(['nope']);
    if (!a || !b) throw new Error('no picture');
    return {
      colors: [painted.color, held.color],
      a: { ...a, png: undefined, px: await pixels(a.png, a.size) },
      b: { ...b, png: undefined, px: await pixels(b.png, b.size) },
      none: none === undefined,
      firstMs: (first?.renderMs ?? 0) + (first?.encodeMs ?? 0),
    };
  });
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const dominant = (c: number[]) => c.indexOf(Math.max(...c));

  // Paint on the +X side (20 × 30 mm): seen from +X, Z up, 30 mm fill 60 % of 384 px.
  expect(result.a.size).toBe(384);
  expect(result.a.px.w).toBe(384);
  expect(result.a.viewDir.map((v) => Math.round(v * 1000) / 1000)).toEqual([1, 0, 0]);
  expect(result.a.up.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 1]);
  expect(result.a.mmPerPx).toBeCloseTo(30 / 0.6 / 384, 4);
  // < 100 ms once warm; the first picture also compiles its shaders (slower on a busy machine).
  expect(result.a.renderMs + result.a.encodeMs).toBeLessThan(100);
  expect(result.b.renderMs + result.b.encodeMs).toBeLessThan(100);
  expect(result.firstMs).toBeLessThan(2000);
  expect(result.a.px.corner).toEqual([255, 255, 255]); // white background
  const centre = result.a.px.centre;
  expect(Math.max(...centre) - Math.min(...centre)).toBeGreaterThan(40); // coloured, not grey
  expect(dominant(centre)).toBe(dominant(rgb(result.colors[0] ?? '')));

  // A held face (top): seen from above, its marker's tint at the centre; size as asked.
  expect(result.b.size).toBe(200);
  expect(result.b.viewDir.map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 1]);
  expect(result.b.ghosted).toEqual([]); // one body: nothing in front
  expect(dominant(result.b.px.centre)).toBe(dominant(rgb(result.colors[1] ?? '')));
  expect(result.none).toBe(true);

  // The user's view did not move.
  const viewAfter = await project();
  expect(viewAfter?.x).toBeCloseTo(viewBefore?.x ?? -1, 6);
  expect(viewAfter?.y).toBeCloseTo(viewBefore?.y ?? -1, 6);
});

test('Contact sheet: two regions side by side, numbered, each with its own camera', async () => {
  const page = await app.firstWindow();
  const result = await page.evaluate(async () => {
    const t = (window as HookWindow).__thirdWheelTest as unknown as {
      markers: { list(): { id: string; color: string }[] };
      renderContactSheet(regions: string[][]): Promise<
        | {
            png: Uint8Array;
            width: number;
            height: number;
            skipped: number[];
            renderMs: number;
            encodeMs: number;
            tiles: {
              number: number;
              region: number;
              x: number;
              y: number;
              size: number;
              viewDir: number[];
              mmPerPx: number;
            }[];
          }
        | undefined
      >;
    };
    // The two markers from the Region render test: paint on +X, held top face.
    const [painted, held] = t.markers.list().slice(-2);
    if (!painted || !held) throw new Error('no markers');
    const sheet = await t.renderContactSheet([[painted.id], ['nope'], [held.id]]);
    const none = await t.renderContactSheet([['nope']]);
    let tooMany = false;
    try {
      await t.renderContactSheet([[], [], [], [], []]);
    } catch {
      tooMany = true;
    }
    if (!sheet) throw new Error('no sheet');
    const bitmap = await createImageBitmap(
      new Blob([new Uint8Array(sheet.png)], { type: 'image/png' }),
    );
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no 2d');
    ctx.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
    // Label box: dark pixels inside the top-left corner of each tile.
    const darkIn = (x0: number, y0: number) => {
      const d = ctx.getImageData(x0, y0, 30, 30).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if ((d[i] ?? 255) < 80) n++;
      return n;
    };
    return {
      colors: [painted.color, held.color],
      w: bitmap.width,
      h: bitmap.height,
      sheet: { ...sheet, png: undefined },
      left: at(192, 192),
      right: at(576, 192),
      divider: at(384, 300),
      labels: [darkIn(0, 0), darkIn(384, 0)],
      none: none === undefined,
      tooMany,
    };
  });
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const dominant = (c: number[]) => c.indexOf(Math.max(...c));
  const round = (v: number[]) => v.map((x) => Math.round(x * 1000) / 1000);

  // Two regions shown (the unknown one skipped) → 768 × 384.
  expect([result.w, result.h]).toEqual([768, 384]);
  expect([result.sheet.width, result.sheet.height]).toEqual([768, 384]);
  expect(result.sheet.skipped).toEqual([1]);
  const [a, b] = result.sheet.tiles;
  expect([a?.number, a?.region, a?.x, a?.y, a?.size]).toEqual([1, 0, 0, 0, 384]);
  expect([b?.number, b?.region, b?.x, b?.y, b?.size]).toEqual([2, 2, 384, 0, 384]);
  // Each tile has its own camera, as in the single pictures.
  expect(round(a?.viewDir ?? [])).toEqual([1, 0, 0]);
  expect(round(b?.viewDir ?? [])).toEqual([0, 0, 1]);
  expect(a?.mmPerPx).toBeCloseTo(30 / 0.6 / 384, 4);
  expect(dominant(result.left)).toBe(dominant(rgb(result.colors[0] ?? '')));
  expect(dominant(result.right)).toBe(dominant(rgb(result.colors[1] ?? '')));
  expect(result.divider).toEqual([150, 155, 165]);
  for (const n of result.labels) expect(n).toBeGreaterThan(10); // number + box border
  expect(result.sheet.renderMs + result.sheet.encodeMs).toBeLessThan(1000);
  expect(result.none).toBe(true);
  expect(result.tooMany).toBe(true);
});

test('App bridge: a token-holding client asks the running app; the window answers status', async () => {
  const page = await app.firstWindow();
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.model() !== undefined);
  await expect.poll(() => existsSync(bridgeFile)).toBe(true);
  const client = await connectBridge({ filePath: bridgeFile });
  try {
    expect(await client.call('ping')).toMatchObject({ app: 'third-wheel', protocol: 1 });
    // Main → window → main: the window reports the open model.
    const status = (await client.call('status')) as {
      model: { path: string; name: string; contentHash: string } | null;
    };
    expect(status.model).toMatchObject({ path: join(dir, 'box.step'), name: 'box.step' });
    expect(status.model?.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(client.call('nope')).rejects.toMatchObject({ code: 'unknown_method' });
    // AI status: ping / status are no MCP tool calls → still grey "no agent yet".
    await expect(page.locator('#ai-status')).toHaveAttribute('data-dot', 'idle');
    await expect(page.locator('#ai-status')).toHaveText('AI: no agent yet');
  } finally {
    client.close();
  }
});

test('MCP tools: the built server drives the app (load, review, annotations, picture, status)', async () => {
  const page = await app.firstWindow();
  // The same file .mcp.json starts; relative paths start from its working folder.
  const client = new Client({ name: 'e2e', version: '1' });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js')],
      cwd: dir,
      env: { ...env, THIRD_WHEEL_BRIDGE_FILE: bridgeFile },
      stderr: 'ignore',
    }),
  );
  type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Content;
      isError?: boolean;
    };
    return { ...r, json: (): unknown => JSON.parse(r.content.at(-1)?.text ?? 'null') };
  };
  try {
    const loaded = (await tool('load_model', { path: 'box.step' })).json() as {
      modelId: string;
      name: string;
      bodies: number;
    };
    expect(loaded).toMatchObject({ name: 'box.step', bodies: 1 });
    expect(loaded.modelId).toMatch(/^[0-9a-f]{12}$/);
    // The project it belongs to, and a free path there for the AI's next export.
    expect(loaded).toMatchObject({
      project: { folder: dir },
      saveNextAs: join(dir, 'box_v2.step'),
    });
    const { modelId } = loaded;
    // AI status: green after a tool call; the pop-up names it and the server path.
    await expect(page.locator('#ai-status')).toHaveAttribute('data-dot', 'active');
    await expect(page.locator('#ai-status')).toHaveText('AI: last call just now');
    await page.locator('#ai-status').click();
    await expect(page.locator('#connect-dialog')).toBeVisible();
    await expect(page.locator('#connect-last')).toContainText('Last AI call: load_model');
    const serverPath = resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js');
    await expect(page.locator('#connect-command')).toHaveText(
      `claude mcp add third-wheel -- node "${serverPath}"`,
    );
    await expect(page.locator('#connect-missing')).toBeHidden();
    await page.locator('input[name="connect-scope"][value="user"]').check();
    await expect(page.locator('#connect-command')).toHaveText(
      `claude mcp add --scope user third-wheel -- node "${serverPath}"`,
    );
    expect(JSON.parse((await page.locator('#connect-json').textContent()) ?? '')).toEqual({
      mcpServers: { 'third-wheel': { command: 'node', args: [serverPath] } },
    });
    // Copy feedback on the button (a notice would sit behind the backdrop).
    // Folded until asked for: "Set it up yourself".
    await page.locator('#connect-manual-title').click();
    await page.locator('#connect-copy-command').click();
    await expect(page.locator('#connect-copy-command')).toHaveText('Copied ✓');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      `claude mcp add --scope user third-wheel -- node "${serverPath}"`,
    );
    await expect(page.locator('#connect-copy-command')).toHaveText('Copy', { timeout: 4000 });
    // One-click Connect: follows the switch, shows what it runs before it runs.
    const calls = (): string[] =>
      existsSync(claudeLog)
        ? readFileSync(claudeLog, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim().replaceAll('"', ''))
            .filter(Boolean)
        : [];
    const connect = page.locator('#connect-claude');
    const confirm = page.locator('#connect-confirm');
    const check = page.locator('#connect-check');
    await page.locator('input[name="connect-scope"][value="folder"]').check();
    // The shown model's folder: its name, the whole path on hover.
    await expect(page.locator('#connect-folder')).toHaveText(basename(dir));
    await expect(page.locator('#connect-folder')).toHaveAttribute('title', dir);
    await expect(check).toHaveText('Not set up yet');
    await expect(page.locator('#connect-why')).toBeHidden();
    await expect(connect).toHaveText('Add Third Wheel to Claude Code…');
    await connect.click();
    await expect(confirm).toBeVisible();
    await expect(page.locator('#connect-confirm-text')).toContainText(`Program: ${fakeClaude}`);
    await expect(page.locator('#connect-confirm-text')).toContainText(`In folder: ${dir}`);
    await expect(page.locator('#connect-steps')).toHaveText(
      `claude mcp add third-wheel -- node "${serverPath}"`,
    );
    await page.locator('#connect-cancel').click();
    await expect(confirm).toBeHidden();
    expect(calls()).toEqual([]); // nothing ran before the second click
    await connect.click();
    await page.locator('#connect-go').click();
    await expect(page.locator('#connect-result')).toContainText('Added ✓');
    await expect(check).toHaveAttribute('data-state', 'ok');
    await expect.poll(calls).toEqual([`${dir} | mcp add third-wheel -- node ${serverPath}`]);
    // Again: the box names the entry it replaces; it is removed only after "Replace and add".
    await connect.click();
    await expect(page.locator('#connect-replace')).toHaveText(
      'Replaces your existing Third Wheel entry.',
    );
    await expect(page.locator('#connect-confirm-text')).toContainText(serverPath); // under Details
    await expect(page.locator('#connect-go')).toHaveText('Replace and add');
    await page.locator('#connect-go').click();
    await expect(page.locator('#connect-result')).toContainText('Added ✓');
    await expect
      .poll(() => calls().slice(1))
      .toEqual([
        `${dir} | mcp remove third-wheel -s local`,
        `${dir} | mcp add third-wheel -- node ${serverPath}`,
      ]);
    // "All my folders" runs with --scope user; a broken folder .mcp.json turns the check amber.
    const mcpJson = join(dir, '.mcp.json');
    writeFileSync(
      mcpJson,
      JSON.stringify({
        mcpServers: { 'third-wheel': { command: 'node', args: [join(dir, 'gone.js')] } },
      }),
    );
    try {
      await page.locator('input[name="connect-scope"][value="user"]').check();
      await connect.click();
      await expect(page.locator('#connect-steps')).toHaveText(
        `claude mcp add --scope user third-wheel -- node "${serverPath}"`,
      );
      await page.locator('#connect-go').click();
      await expect(page.locator('#connect-result')).toHaveAttribute('data-ok', 'warn');
      await expect(page.locator('#connect-result')).toContainText('Why?');
      await expect(check).toHaveText('Won’t work yet');
      await page.locator('#connect-why summary').click();
      await expect(page.locator('#connect-check-text')).toContainText('gone.js');
      // The entry in the way can be removed from here: said first, done on Remove (.bak kept).
      const fix = page.locator('#connect-fixes button');
      await expect(fix).toHaveText(`Remove the entry in ${mcpJson}…`);
      await fix.click();
      await expect(page.locator('#connect-fix-text')).toHaveText(
        `Removes the "third-wheel" part of ${mcpJson} (a copy is kept as .mcp.json.bak).`,
      );
      await page.locator('#connect-fix-go').click();
      await expect(page.locator('#connect-fix-result')).toHaveText('Removed ✓');
      await expect(check).toHaveText('Set up ✓');
      expect(JSON.parse(readFileSync(mcpJson, 'utf8'))).toEqual({ mcpServers: {} });
      await expect
        .poll(() => calls().at(-1))
        .toMatch(/\| mcp add --scope user third-wheel -- node /);
    } finally {
      rmSync(mcpJson, { force: true });
      rmSync(`${mcpJson}.bak`, { force: true });
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('#connect-dialog')).toBeHidden();
    const wrongFile = await tool('load_model', { path: 'notes.txt' });
    expect(wrongFile.isError).toBe(true);

    // No comments yet: no "0" badge, and Send to AI copies nothing but says why.
    await expect(page.locator('#send-ai')).toBeEnabled();
    await expect(page.locator('#send-ai-count')).toBeHidden();
    await app.evaluate(({ clipboard }) => {
      void clipboard.writeText('untouched');
    });
    await page.locator('#send-ai').click();
    await expect(page.locator('#notice-text')).toHaveText(
      'Nothing to send yet: add a comment first.',
    );
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('untouched');
    // The AI asked: 0 comments is still an answer ("looks fine") and goes out.
    const empty = (await tool('request_review', { modelId })).json() as { reviewId: string };
    await expect(page.locator('#send-ai')).toHaveClass(/asking/);
    await expect(page.locator('#send-ai-count')).toBeHidden();
    await page.locator('#send-ai').click();
    expect(
      (await tool('wait_for_review', { reviewId: empty.reviewId, timeoutSec: 5 })).json(),
    ).toMatchObject({ state: 'sent', openComments: 0 });
    await expect(page.locator('#notice-text')).toHaveText('Sent: no open comments.');

    // The user marks the top face and comments on it.
    const { markerId, commentId } = await page.evaluate(() => {
      const t = (window as HookWindow).__thirdWheelTest as unknown as {
        model(): { faceGeometry: Float32Array };
        markers: { add(e: { kind: string; id: number }[]): { id: string } };
        comments: { add(text: string, ids: string[]): { id: string } | undefined };
      };
      const g = t.model().faceGeometry;
      let top = -1;
      for (let f = 0; f < g.length / 8; f++) if ((g[f * 8 + 2] ?? 0) > 0.5) top = f;
      const m = t.markers.add([{ kind: 'face', id: top }]);
      return { markerId: m.id, commentId: t.comments.add('Fillet this edge', [m.id])?.id ?? '' };
    });

    // No AI request yet: the toolbar's "Send to AI" copies a message naming the model's path.
    const openCount = Number(await page.locator('#send-ai-count').textContent());
    expect(openCount).toBeGreaterThan(0);
    await expect(page.locator('#send-ai')).not.toHaveClass(/asking/);
    await page.locator('#send-ai').click();
    await expect(page.locator('#notice-text')).toContainText('copied');
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain(`I reviewed box.step in Third Wheel (${String(openCount)} open`);
    // The Windows clipboard turns \n into \r\n.
    expect(copied).toMatch(/\r?\nPath: .*box\.step\r?\n/);

    // Review: the banner shows the AI's message and the toolbar button turns rainbow; a short
    // wait times out, "Send to AI" (banner or toolbar) ends it.
    const { reviewId } = (
      await tool('request_review', { modelId, message: 'Check the top' })
    ).json() as {
      reviewId: string;
    };
    await expect(page.locator('#ai-banner')).toBeVisible();
    await expect(page.locator('#ai-banner-text')).toHaveText('Check the top');
    await expect(page.locator('#send-ai')).toHaveClass(/asking/);
    expect((await tool('wait_for_review', { reviewId, timeoutSec: 1 })).json()).toMatchObject({
      state: 'waiting',
    });
    const waiting = tool('wait_for_review', { reviewId, timeoutSec: 30 });
    await page.waitForTimeout(300);
    // Typed but not posted: Send posts it first, so the AI sees it.
    await page.locator('#comment-add').click();
    await page.locator('.comment-input').fill('Typed but not posted');
    await page.locator('#ai-banner-send').click();
    expect((await waiting).json()).toMatchObject({
      state: 'sent',
      modelId,
      openComments: openCount + 1,
    });
    await expect(page.locator('#notice-text')).toHaveText('Posted your comment and sent.');
    await expect(page.locator('#ai-banner')).toBeHidden();
    await expect(page.locator('#send-ai')).not.toHaveClass(/asking/);
    // The toolbar button answers a request too; × tells the AI "cancelled".
    const second = (await tool('request_review', { modelId })).json() as { reviewId: string };
    await page.locator('#send-ai').click();
    expect(
      (await tool('wait_for_review', { reviewId: second.reviewId, timeoutSec: 5 })).json(),
    ).toMatchObject({ state: 'sent' });
    const third = (await tool('request_review', { modelId })).json() as { reviewId: string };
    await page.locator('#ai-banner-dismiss').click();
    expect(
      (await tool('wait_for_review', { reviewId: third.reviewId, timeoutSec: 5 })).json(),
    ).toMatchObject({ state: 'cancelled' });

    const payload = (await tool('get_annotations', { modelId })).json() as {
      comments: { id: string; text: string }[];
      markers: { id: string; entities?: { kind: string; type?: string }[] }[];
    };
    expect(payload.comments.map((c) => c.text)).toContain('Fillet this edge');
    expect(payload.comments.map((c) => c.text)).toContain('Typed but not posted');
    expect(payload.markers.find((m) => m.id === markerId)?.entities?.[0]).toMatchObject({
      kind: 'face',
      type: 'plane',
    });

    const picture = await tool('render_region', { modelId, markerIds: [markerId] });
    expect(picture.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(
      Buffer.from(picture.content[0]?.data ?? '', 'base64')
        .subarray(1, 4)
        .toString(),
    ).toBe('PNG');
    expect(picture.json()).toMatchObject({ width: 384, height: 384, view: { viewDir: [0, 0, 1] } });
    const sheet = await tool('render_region', { modelId, groups: [[markerId], [markerId]] });
    expect(sheet.json()).toMatchObject({
      width: 768,
      height: 384,
      tiles: [{ number: 1 }, { number: 2 }],
    });
    expect((await tool('render_region', { modelId, markerIds: ['nope'] })).isError).toBe(true);

    // The AI resolves the comment: the app shows it, default annotations leave it out.
    expect(
      (
        await tool('set_comment_status', {
          modelId,
          commentId,
          status: 'resolved',
          note: 'added 2 mm fillet',
        })
      ).json(),
    ).toMatchObject({ status: 'resolved', changed: true });
    type ThreadComment = {
      status: string;
      replies?: { author: string; text: string; status?: string }[];
    };
    const commentNow = (): Promise<ThreadComment | undefined> =>
      page.evaluate(
        (id) =>
          (
            (window as HookWindow).__thirdWheelTest as unknown as {
              comments: { get(id: string): ThreadComment | undefined };
            }
          ).comments.get(id),
        commentId,
      );
    // The note is the AI's reply in the thread, tagged with the status.
    expect(await commentNow()).toMatchObject({
      status: 'resolved',
      replies: [{ author: 'ai', text: 'added 2 mm fillet', status: 'resolved' }],
      awaitingConfirm: true,
    });
    // The AI's "resolved" stays in the list until the user confirms it.
    const aiClosed = page.locator(`li[data-comment="${commentId}"]`);
    await expect(aiClosed.locator('.comment-confirm-text')).toHaveText('AI says it’s fixed');
    // Not "Resolved" (nor counted under "Show resolved") until the user confirms.
    await expect(aiClosed.locator('.comment-head .comment-status').first()).toHaveText(
      'Waiting for you',
    );
    // Earlier tests may have left closed comments on this box: count only the user-closed ones.
    const userClosed = await page.evaluate(
      () =>
        (
          (window as HookWindow).__thirdWheelTest as unknown as {
            comments: { list(): { status: string; awaitingConfirm?: true }[] };
          }
        ).comments
          .list()
          .filter((c) => c.status !== 'open' && !c.awaitingConfirm).length,
    );
    if (userClosed === 0) await expect(page.locator('.comment-show-closed')).toBeHidden();
    else
      await expect(page.locator('.comment-show-closed')).toContainText(
        `Show resolved (${String(userClosed)})`,
      );
    // The AI's edits are not on the user's undo history — Cmd/Ctrl+Z after a brush stroke
    // undoes only the stroke, and the next step offered is the user's own.
    const activeId = await page.evaluate(
      () => (window as HookWindow).__thirdWheelTest?.markers.active()?.id ?? '',
    );
    const strokePaint = () =>
      page.evaluate(
        (id) => (window as HookWindow).__thirdWheelTest?.paint()?.count(id) ?? -1,
        activeId,
      );
    const canvasBox = await page.locator('#viewport canvas').first().boundingBox();
    if (!canvasBox) throw new Error('no canvas box');
    await page.keyboard.press('0');
    await page.waitForTimeout(600);
    const top = await page.evaluate(() =>
      (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
    );
    if (!top) throw new Error('no projection');
    const paintBefore = await strokePaint();
    await page.keyboard.press('b');
    await page.mouse.move(canvasBox.x + top.x - 10, canvasBox.y + top.y);
    await page.mouse.down();
    await page.mouse.move(canvasBox.x + top.x + 10, canvasBox.y + top.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(strokePaint).toBeGreaterThan(paintBefore);
    await expect(page.locator('#undo')).toHaveAttribute('title', /^Undo Brush stroke \(/);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(strokePaint).toBe(paintBefore);
    await expect(page.locator('#undo')).toHaveAttribute('title', /^Undo Add comment \(/);
    expect(await commentNow()).toMatchObject({
      status: 'resolved',
      replies: [{ author: 'ai', text: 'added 2 mm fillet' }],
      awaitingConfirm: true,
    });
    await page.keyboard.press('v');
    await aiClosed.locator('.comment-confirm').click();
    await expect(aiClosed).toHaveCount(0); // closed for good: hidden unless "Show resolved"
    expect(await commentNow()).not.toHaveProperty('awaitingConfirm');
    const open = (await tool('get_annotations', { modelId })).json() as {
      comments: { id: string }[];
    };
    expect(open.comments.map((c) => c.id)).not.toContain(commentId);
    const all = (
      await tool('get_annotations', { modelId, statuses: ['open', 'resolved', 'wontfix'] })
    ).json() as { comments: { id: string; replies?: unknown[] }[] };
    expect(all.comments.find((c) => c.id === commentId)?.replies).toEqual([
      { by: 'ai', text: 'added 2 mm fillet', status: 'resolved' },
    ]);

    // The AI replies without changing the status; the reply shows under the card.
    expect(
      (await tool('reply_to_comment', { modelId, commentId, text: 'Is 2 mm enough?' })).json(),
    ).toMatchObject({ commentId, replyId: 'r2', status: 'resolved' });
    expect((await commentNow())?.status).toBe('resolved');
    expect(
      (await tool('reply_to_comment', { modelId, commentId: 'nope', text: 'x' })).isError,
    ).toBe(true);
    // The user answers in the reply box of the highlighted card: the comment reopens.
    await page.locator('#comment-show-closed').check();
    const card = page.locator(`li[data-comment="${commentId}"]`);
    await card.locator('.comment-text').first().click();
    await expect(card.locator('.comment-reply')).toHaveCount(2);
    // The highlighted card stays shown; reopening hides the checkbox (no closed comments left).
    await page.locator('#comment-show-closed').uncheck();
    await card.locator('.reply-input').fill('Make it 3 mm');
    await card.locator('#reply-post').click();
    await expect(card.locator('.comment-reply')).toHaveCount(3);
    expect(await commentNow()).toMatchObject({
      status: 'open',
      replies: [{}, {}, { author: 'human', text: 'Make it 3 mm', status: 'open' }],
    });

    // Comment ids repeat across models: another model's id must not touch this one's comment.
    const wrongComment = await tool('set_comment_status', {
      modelId: 'ffffffffffff',
      commentId,
      status: 'open',
    });
    expect(wrongComment.isError).toBe(true);
    const wrongModel = await tool('get_annotations', { modelId: 'ffffffffffff' });
    expect(wrongModel.isError).toBe(true);
    expect(wrongModel.content[0]?.text).toContain('load_model');

    // One review of two models. The AI loads the lid, then the box, and asks about both.
    const lid = (await tool('load_model', { path: 'lid.step' })).json() as { modelId: string };
    await page.evaluate(() => {
      (
        (window as HookWindow).__thirdWheelTest as unknown as {
          comments: { add(t: string, ids: string[], by: string, linked: string[]): unknown };
        }
      ).comments.add('Lid must fit the box', [], 'human', ['box.step']);
    });
    expect((await tool('load_model', { path: 'box.step' })).json()).toMatchObject({ modelId });
    const both = (
      await tool('request_review', {
        modelId,
        alsoModelIds: [lid.modelId],
        message: 'Do they fit?',
      })
    ).json() as { reviewId: string };
    const models = page.locator('.ai-banner-model');
    await expect(models).toHaveCount(2);
    await expect(models.nth(0)).toHaveAttribute('aria-current', 'true');
    await expect(models.nth(1)).toHaveText('lid.step · 1');
    // The lid isn't shown, yet its comments (with the linked file) can be read.
    const lidPayload = (await tool('get_annotations', { modelId: lid.modelId })).json() as {
      comments: { text: string; linkedModels?: string[] }[];
    };
    expect(lidPayload.comments).toEqual([
      expect.objectContaining({ text: 'Lid must fit the box', linkedModels: ['box.step'] }),
    ]);
    // Switching to the lid keeps the request; the box is no longer shown.
    await models.nth(1).click();
    await expect(models.nth(1)).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('#ai-banner')).toBeVisible();
    const notShown = await tool('render_region', { modelId, markerIds: [markerId] });
    expect(notShown.content[0]?.text).toContain('get_annotations still reads it');
    expect((await tool('get_annotations', { modelId })).isError).toBeFalsy();
    await page.locator('#ai-banner-send').click();
    const sent = (
      await tool('wait_for_review', { reviewId: both.reviewId, timeoutSec: 5 })
    ).json() as { state: string; models: { modelId: string; openComments: number }[] };
    expect(sent.state).toBe('sent');
    expect(sent.models.map((m) => m.modelId)).toEqual([modelId, lid.modelId]);
    expect(sent.models[1]?.openComments).toBe(1);
    // The card's "↔ box.step" chip opens the box again.
    await page.locator('button.comment-chip.linked').click();
    await expect
      .poll(async () => (await tool('render_region', { modelId, markerIds: [markerId] })).isError)
      .toBeFalsy();

    // A newer version of the box: the box's kept review is not read any more (comments belong
    // to the part, so they may have changed since); another part's kept review still is.
    const boxText = readFileSync(join(dir, 'box.step'), 'utf8');
    const v2Text = boxText.replace("FILE_NAME('", "FILE_NAME('v2 ");
    expect(v2Text).not.toBe(boxText);
    writeFileSync(join(dir, 'box_v2.step'), v2Text);
    const v2 = await tool('load_model', { path: 'box_v2.step', revisionOf: modelId });
    expect(v2.isError).toBeFalsy();
    const earlier = await tool('get_annotations', { modelId });
    expect(earlier.isError).toBe(true);
    expect(earlier.content[0]?.text).toContain(
      'box.step is a version of the same part as the shown model box_v2.step',
    );
    expect((await tool('get_annotations', { modelId: lid.modelId })).isError).toBeFalsy();
    expect((await tool('load_model', { path: 'box.step' })).isError).toBeFalsy();
  } finally {
    await client.close();
  }
});

test('Connect pop-up: one tab per agent, one-click for Codex / Gemini / Copilot / Cursor / VS Code, remembered', async () => {
  const page = await loadedWindow();
  const serverPath = resolve(appDir, '../../packages/mcp-server/build/third-wheel-mcp.js');
  await app.evaluate(({ shell }) => {
    const g = globalThis as { opened?: string[] };
    g.opened = [];
    shell.openExternal = (url: string) => {
      g.opened?.push(url);
      return Promise.resolve();
    };
  });
  const tab = (id: string) => page.locator(`input[name="connect-agent"][value="${id}"]`);
  const button = page.locator('#connect-agent-button');
  const result = page.locator('#connect-agent-result');
  const text = page.locator('#connect-agent-text');
  await page.locator('#ai-status').click();
  await expect(page.locator('#connect-dialog')).toBeVisible();
  await expect(tab('claude')).toBeChecked();
  await expect(page.locator('#connect-panel-claude')).toBeVisible();
  await expect(page.locator('#connect-panel-agent')).toBeHidden();

  // Codex: writes config.toml (with the timeout `codex mcp add` can't set), keeps a backup.
  mkdirSync(codexHome, { recursive: true });
  const codexFile = join(codexHome, 'config.toml');
  writeFileSync(codexFile, 'model = "gpt-5"\n');
  await page.locator('#connect-agents label', { hasText: 'Codex' }).click();
  await expect(page.locator('#connect-panel-claude')).toBeHidden();
  await expect(text).toContainText('[mcp_servers.third-wheel]');
  await expect(text).toContainText('tool_timeout_sec = 1800');
  await expect(page.locator('#connect-agent-hint')).toContainText(codexFile);
  await expect(button).toHaveText('Add to Codex');
  await button.click();
  await expect(result).toContainText(`Added ✓ to ${codexFile}`);
  const toml = readFileSync(codexFile, 'utf8');
  expect(toml.startsWith('model = "gpt-5"')).toBe(true);
  // Windows paths go in TOML literal strings (single quotes, no escaping), like the app writes them.
  const tomlPath = process.platform === 'win32' ? `'${serverPath}'` : JSON.stringify(serverPath);
  expect(toml).toContain(`args = [${tomlPath}]`);
  expect(toml).toContain('tool_timeout_sec = 1800');
  expect(readFileSync(`${codexFile}.bak`, 'utf8')).toBe('model = "gpt-5"\n');
  // Copy gives exactly what is shown (the Windows clipboard turns \n into \r\n).
  await page.locator('#connect-agent-summary').click(); // folded while a button does it
  await page.locator('#connect-copy-agent').click();
  await expect(page.locator('#connect-copy-agent')).toHaveText('Copied ✓');
  const copiedAgent = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copiedAgent.replace(/\r\n/g, '\n')).toBe((await text.textContent()) ?? '');

  // Gemini CLI: the fake program gets `mcp remove` then `mcp add -s user`.
  await page.locator('#connect-agents label', { hasText: 'Gemini CLI' }).click();
  await expect(text).toHaveText(
    `gemini mcp add -s user --timeout 1800000 third-wheel node "${serverPath}"`,
  );
  await expect(button).toHaveText('Add to Gemini CLI');
  await button.click();
  // Shown first: program + command; nothing ran yet.
  await expect(page.locator('#connect-agent-confirm-text')).toContainText(`Program: ${fakeGemini}`);
  await expect(page.locator('#connect-agent-steps')).toHaveText(
    `gemini mcp add -s user --timeout 1800000 third-wheel node "${serverPath}"`,
  );
  expect(existsSync(geminiLog)).toBe(false);
  await page.locator('#connect-agent-go').click();
  await expect(result).toContainText('Added ✓');
  await expect
    .poll(() =>
      existsSync(geminiLog)
        ? readFileSync(geminiLog, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim().replaceAll('"', ''))
            .filter(Boolean)
        : [],
    )
    .toEqual([`mcp add -s user --timeout 1800000 third-wheel node ${serverPath}`]);

  // Copilot CLI: name first, -- before the command, 30-min timeout.
  const copilotCmd = `copilot mcp add third-wheel --timeout 1800000 -- node "${serverPath}"`;
  await page.locator('#connect-agents label', { hasText: 'Copilot CLI' }).click();
  await expect(text).toHaveText(copilotCmd);
  await expect(button).toHaveText('Add to Copilot CLI');
  await button.click();
  await expect(page.locator('#connect-agent-confirm-text')).toContainText(
    `Program: ${fakeCopilot}`,
  );
  await expect(page.locator('#connect-agent-steps')).toHaveText(copilotCmd);
  await page.locator('#connect-agent-go').click();
  await expect(result).toContainText('Added ✓');
  await expect
    .poll(() =>
      existsSync(copilotLog)
        ? readFileSync(copilotLog, 'utf8')
            .split(/\r?\n/)
            .map((l) => l.trim().replaceAll('"', ''))
            .filter(Boolean)
        : [],
    )
    .toEqual([`mcp add third-wheel --timeout 1800000 -- node ${serverPath}`]);

  // Cursor / VS Code: their install links (opened by main, stubbed here).
  await page.locator('#connect-agents label', { hasText: 'Cursor' }).click();
  expect(JSON.parse((await text.textContent()) ?? '')).toEqual({
    mcpServers: { 'third-wheel': { command: 'node', args: [serverPath] } },
  });
  await button.click();
  await expect(result).toContainText('Cursor should open');
  await page.locator('#connect-agents label', { hasText: 'VS Code' }).click();
  await expect(text).toContainText('"type": "stdio"');
  await expect(text).toContainText('"tools"');
  await button.click();
  await expect(result).toContainText('VS Code should open');
  const opened = await app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
  expect(opened).toHaveLength(2);
  expect(opened[0]).toMatch(
    /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=third-wheel&config=/,
  );
  expect(opened[1]).toMatch(/^vscode:mcp\/install\?/);

  // Other: copy only.
  await page.locator('#connect-agents label', { hasText: 'Other' }).click();
  await expect(button).toBeHidden();
  await expect(page.locator('#connect-agent-where')).toContainText('Cline');

  // The last choice is remembered.
  await page.keyboard.press('Escape');
  await page.locator('#ai-status').click();
  await expect(tab('other')).toBeChecked();
  await expect(page.locator('#connect-panel-agent')).toBeVisible();
  await expect(result).toBeHidden(); // results don't outlive the pop-up
  await page.locator('#connect-agents label', { hasText: 'Claude Code' }).click();
  await expect(page.locator('#connect-panel-claude')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#connect-dialog')).toBeHidden();
});

test('AI status: red when the bridge cannot start; start view links to the Connect pop-up; version line', async () => {
  // The bridge file path is a folder → writing it fails, as a real start failure would.
  const blocked = join(dir, 'bridge-blocked');
  mkdirSync(blocked, { recursive: true });
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  delete env['THIRD_WHEEL_OPEN'];
  const second = await electron.launch({
    args: [appDir, `--user-data-dir=${join(dir, 'profile-blocked')}`, ...scaleArgs],
    env: { ...env, THIRD_WHEEL_TEST: '1', THIRD_WHEEL_BRIDGE_FILE: blocked },
  });
  try {
    const page = await second.firstWindow();
    await expect(page.locator('#ai-status')).toHaveAttribute('data-dot', 'error');
    await expect(page.locator('#ai-status')).toHaveText("AI: off — couldn't start");
    await expect(page.locator('#empty-view')).toBeVisible();
    await page.locator('#empty-connect').click();
    await expect(page.locator('#connect-dialog')).toBeVisible();
    await expect(page.locator('#connect-last')).toContainText("AI agents can't reach the app");
    await expect(page.locator('#connect-command')).toContainText('claude mcp add third-wheel');
    await page.keyboard.press('Escape');
    await expect(page.locator('#connect-dialog')).toBeHidden();

    // Version line at the bottom of the start card; "Open source" opens the browser.
    // The app's own version from package.json, so a release bump doesn't need a test change.
    const pkgVersion = (
      JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string }
    ).version;
    const version = await second.evaluate(({ app: a }) => a.getVersion());
    expect(version).toBe(pkgVersion);
    const line = page.locator('#empty-version');
    await expect(line).toBeVisible();
    await expect(line).toHaveText(`v${pkgVersion} · Open source (Apache 2.0) · Send feedback`, {
      useInnerText: true,
    });
    await page.screenshot({ path: 'test-results/start-feedback-link.png' });
    await page.locator('#empty-feedback').click();
    await expect(page.locator('#feedback-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#feedback-dialog')).toBeHidden();
    await second.evaluate(({ shell }) => {
      const g = globalThis as { opened?: string[] };
      g.opened = [];
      shell.openExternal = (url: string) => {
        g.opened?.push(url);
        return Promise.resolve();
      };
    });
    await page.locator('#empty-version-link').click();
    await expect
      .poll(() => second.evaluate(() => (globalThis as { opened?: string[] }).opened))
      .toEqual(['https://github.com/XiLaoTr/third-wheel']);
    expect(second.windows()).toHaveLength(1); // not opened inside the app
  } finally {
    await second.close();
  }
});
