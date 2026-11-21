/**
 * Electron test of the Parts library: the toolbar button and panel, browsing and search, the 3D
 * preview, putting parts into a request (standard size, copies, markers, note), saving it as a comment
 * with `parts` in the sidecar, and getting it back after reopening the model.
 * Run with `pnpm test:e2e` (builds first).
 */
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OcctKernel } from 'occt-wasm';

interface TestHook {
  loaded(): boolean;
  flush(): Promise<void>;
  reopen(saveFirst?: boolean): Promise<void>;
  comments: { list(): { id: string; text: string; parts?: unknown[] }[] };
}
type HookWindow = Window & { __thirdWheelTest?: TestHook };

const appDir = resolve(import.meta.dirname, '..');
let dir: string;
let boxPath: string;
let app: ElectronApplication;
let bridgeFile: string;
let page: Page;

test.beforeAll(async () => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'third-wheel-e2e-lib-')));
  const kernel = await OcctKernel.init();
  boxPath = join(dir, 'box.step');
  bridgeFile = join(dir, 'bridge.json');
  writeFileSync(boxPath, kernel.exportStep(kernel.makeBox(10, 20, 30)));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  app = await electron.launch({
    args: [appDir, `--user-data-dir=${join(dir, 'profile')}`],
    env: {
      ...env,
      THIRD_WHEEL_OPEN: boxPath,
      THIRD_WHEEL_TEST: '1',
      THIRD_WHEEL_BRIDGE_FILE: bridgeFile,
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.loaded() === true, {
    timeout: 60_000,
  });
});

test.afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

test('Library: button opens the panel; 92 parts with thumbnails; search; 3D preview; Esc closes', async () => {
  const button = page.locator('#library-btn');
  const panel = page.locator('#library-panel');
  await expect(button).toBeVisible();
  await expect(panel).toBeHidden();

  await button.click();
  await expect(panel).toBeVisible();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.library-sub')).toContainText('bd_warehouse');
  await expect(page.locator('.library-sub')).toContainText('92 parts');
  await expect(page.locator('.library-module')).toHaveCount(12);
  // The first module is open; every row gets a picture of the part.
  const rows = page.locator('.library-row');
  await expect(rows.first()).toBeVisible();
  const count = await rows.count();
  expect(count).toBeGreaterThan(10);
  await expect(page.locator('.library-thumb img')).toHaveCount(count);

  // Search in English and in Chinese; an unknown word says so.
  await page.fill('.library-search', 'seal');
  await expect(page.locator('.library-row-name')).toContainText(['O Ring']);
  await page.fill('.library-search', '螺絲');
  await expect(page.locator('.library-row').first()).toBeVisible();
  await page.fill('.library-search', 'zzzz');
  await expect(page.locator('.library-empty')).toContainText('No part matches');
  await page.fill('.library-search', '');

  // A part: 3D preview, size and what it was built with.
  await page.locator('.library-row[data-class="SocketHeadCapScrew"]').click();
  await expect(page.locator('.library-preview canvas')).toBeVisible();
  await expect(page.locator('.library-detail-title')).toHaveText('Socket Head Cap Screw');
  await expect(page.locator('.library-facts')).toContainText('mm');

  // Typing in the search box must not trigger tool shortcuts (B = Brush).
  await page.locator('.library-search').pressSequentially('b');
  await expect(page.getByRole('button', { name: /^Select/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.fill('.library-search', '');

  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(button).toHaveAttribute('aria-pressed', 'false');
});

test('Request: standard size and length, copies, marker, note → a comment with parts that survives reopening', async () => {
  await page.locator('#library-btn').click();
  await page.locator('.library-row[data-class="SocketHeadCapScrew"]').click();
  const add = page.locator('.library-add');
  await expect(add).toBeVisible();
  await add.click();
  await expect(add).toContainText('Added');
  const requestTab = page.locator('.library-tab').nth(1);
  await expect(requestTab).toHaveText('Request (1)');

  await requestTab.click();
  await expect(page.locator('.library-item')).toHaveCount(1);

  // Standard type and size come from the library's tables; the size list follows the type.
  const options = page.locator('.library-option');
  const typeSelect = options.nth(0).locator('select');
  const sizeSelect = options.nth(1).locator('select');
  await expect(typeSelect.locator('option')).toContainText(['AI decides', 'iso4762']);
  // bd_warehouse lists ASME #0, #1 and #2 screws but cannot build them (KeyError): not offered.
  await typeSelect.selectOption('asme_b18.3');
  await expect(sizeSelect.locator('option[value="#3-48"]')).toHaveCount(1);
  for (const size of ['#0-80', '#1-64', '#1-72', '#2-56', '#2-64']) {
    await expect(sizeSelect.locator(`option[value="${size}"]`)).toHaveCount(0);
  }
  await typeSelect.selectOption('iso4762');
  await expect(sizeSelect.locator('option[value="M5-0.8"]')).toHaveCount(1);
  await page.locator('.library-option').nth(1).locator('select').selectOption('M5-0.8');
  // Screws default to no thread in bd_warehouse: the request can ask for a real one.
  const thread = page.locator('.library-option').filter({ hasText: 'Thread' }).locator('select');
  await expect(thread.locator('option')).toHaveText([
    'AI decides',
    'No thread (simple)',
    'With thread',
  ]);
  await thread.selectOption('false');
  const length = page.locator('.library-option').filter({ hasText: 'length' }).locator('input');
  await length.fill('16');
  await length.dispatchEvent('change');

  // Copies, set after the choices above, must not undo them.
  const copies = page.locator('.library-item .library-copies').last();
  await copies.fill('2');
  await copies.dispatchEvent('change');

  await page.locator('.library-item .library-check input').first().check();
  // "Spread over the marked area" only appears with several copies or markers.
  const spread = page.locator('.library-item select[aria-label="How the copies are placed"]');
  await expect(spread).toBeVisible(); // 2 copies
  await copies.fill('1');
  await copies.dispatchEvent('change');
  await expect(spread).toBeHidden(); // one part at one marker
  await copies.fill('2');
  await copies.dispatchEvent('change');
  await expect(spread).toBeVisible();
  await page.locator('.library-note').fill('countersunk flush');
  await page.locator('.library-instruction').fill('Fasten the plate here');
  await page.locator('.library-create').click();
  await expect(page.locator('.library-notice')).toContainText('Saved as comment #1');
  await expect(requestTab).toHaveText('Request');

  // The comment card lists the part.
  await expect(page.locator('.comment-parts li')).toHaveText('Socket Head Cap Screw ×2 → Marker 1');

  // The sidecar holds it, with the choices and the note kept apart.
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  const sidecar = JSON.parse(readFileSync(`${boxPath}.thirdwheel.json`, 'utf8')) as {
    comments: { text: string; markerIds: string[]; parts: unknown[] }[];
  };
  const comment = sidecar.comments.at(-1);
  expect(comment?.text).toBe('Fasten the plate here');
  expect(comment?.parts).toEqual([
    {
      id: 'p1',
      source: {
        kind: 'library',
        library: 'bd_warehouse',
        version: expect.any(String) as unknown,
        cls: 'SocketHeadCapScrew',
        params: { fastener_type: 'iso4762', size: 'M5-0.8', simple: false, length: 16 },
      },
      copies: 2,
      scope: 'whole',
      target: { markerIds: comment?.markerIds },
      note: 'countersunk flush',
    },
  ]);

  // Reopening the model reads it back from the sidecar.
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen(true));
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.loaded() === true, {
    timeout: 60_000,
  });
  await expect(page.locator('.comment-parts li')).toHaveText('Socket Head Cap Screw ×2 → Marker 1');
});

test('AI side: the MCP tools read the request and write the result of each part back', async () => {
  const client = new Client({ name: 'e2e-library', version: '1' });
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
  type Content = { type: string; text?: string }[];
  const tool = async (name: string, args: Record<string, unknown>) => {
    const r = (await client.callTool({ name, arguments: args })) as {
      content: Content;
      isError?: boolean;
    };
    const text = r.content.map((c) => c.text ?? '').join(' ');
    return {
      isError: r.isError === true,
      json: (): unknown => JSON.parse(r.content.at(-1)?.text ?? 'null'),
      text,
    };
  };
  const readSidecar = () =>
    JSON.parse(readFileSync(`${boxPath}.thirdwheel.json`, 'utf8')) as {
      comments: { id: string; parts: { id: string; result?: Record<string, unknown> }[] }[];
    };
  try {
    // A fresh session asks what is open (no path needed) and sees what is waiting.
    const open = (await tool('get_open_model', {})).json() as {
      model: { modelId: string; name: string; path: string } | null;
      summary?: { comments: { open: number }; markers: number };
    };
    expect(open.model).toMatchObject({ name: 'box.step', path: boxPath });
    expect(open.summary?.comments.open).toBeGreaterThanOrEqual(1);
    expect(open.summary?.markers).toBeGreaterThanOrEqual(1);

    const { modelId } = (await tool('load_model', { path: boxPath })).json() as { modelId: string };
    expect(modelId).toBe(open.model?.modelId); // the id it gave is the one load_model returns

    // The AI reads the request: instruction, the choices, the target marker.
    const review = (await tool('get_annotations', { modelId })).json() as {
      path: string;
      comments: {
        id: string;
        text: string;
        markers: string[];
        parts: {
          id: string;
          source: { cls: string; params: unknown };
          copies: number;
          note: string;
        }[];
      }[];
    };
    // The AI is told where the file is, to edit it or write the next version beside it.
    expect(review.path).toBe(boxPath);
    const comment = review.comments.find((c) => c.parts.length > 0);
    expect(comment?.text).toBe('Fasten the plate here');
    expect(comment?.parts[0]).toMatchObject({
      id: 'p1',
      copies: 2,
      note: 'countersunk flush',
      source: {
        cls: 'SocketHeadCapScrew',
        params: { size: 'M5-0.8', simple: false, length: 16 },
      },
    });

    // An unknown part id is refused and nothing changes.
    const bad = await tool('set_comment_status', {
      modelId,
      commentId: 'c1',
      status: 'resolved',
      partResults: [{ partId: 'p9', status: 'placed' }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('no part "p9"');
    expect(readSidecar().comments[0]?.parts[0]).not.toHaveProperty('result');

    // A question about the part: the status stays open, the part shows it needs info.
    const asked = (
      await tool('reply_to_comment', {
        modelId,
        commentId: 'c1',
        text: 'Which thread length?',
        partResults: [{ partId: 'p1', status: 'needs-info', note: 'Length unclear' }],
      })
    ).json();
    expect(asked).toMatchObject({ commentId: 'c1', status: 'open', partsUpdated: 1 });
    await expect(page.locator('.comment-parts li')).toContainText('needs-info');
    await expect(page.locator('.comment-part-note')).toHaveText('Length unclear');

    // Done: the result names the bodies; the card and the sidecar show it.
    const done = (
      await tool('set_comment_status', {
        modelId,
        commentId: 'c1',
        status: 'resolved',
        note: 'two screws placed',
        partResults: [
          { partId: 'p1', status: 'placed', bodies: ['Screw M5-0.8x16 (Marker 1) [1]'] },
        ],
      })
    ).json();
    expect(done).toMatchObject({ commentId: 'c1', status: 'resolved', partsUpdated: 1 });
    await expect(page.locator('.comment-parts li')).toContainText('placed (Screw M5-0.8x16');
    await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
    expect(readSidecar().comments[0]?.parts[0]?.result).toMatchObject({
      status: 'placed',
      bodies: ['Screw M5-0.8x16 (Marker 1) [1]'],
    });
  } finally {
    await client.close();
  }
});

test('search_parts: the AI searches the shipped catalogue (English, Chinese, one class in full)', async () => {
  const client = new Client({ name: 'e2e-search', version: '1' });
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
  const ask = async (args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: 'search_parts', arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    const text = r.content.map((c) => c.text ?? '').join(' ');
    return { isError: r.isError === true, text, json: () => JSON.parse(text) as unknown };
  };
  type Hit = {
    cls: string;
    options: { name: string; kind: string; count?: number; sizes?: unknown }[];
  };
  type Result = { library: string; version: string; total: number; hits: Hit[]; note?: string };
  try {
    const seal = (await ask({ query: 'seal' })).json() as Result;
    expect(seal.library).toBe('bd_warehouse');
    expect(seal.hits.map((h) => h.cls)).toContain('ORing');

    const screws = (await ask({ query: '螺絲', limit: 3 })).json() as Result;
    expect(screws.hits).toHaveLength(3);
    expect(screws.total).toBeGreaterThan(3);

    // A class in full: every buildable size by standard, none the library cannot build.
    const full = (await ask({ cls: 'SocketHeadCapScrew' })).json() as Result;
    const size = full.hits[0]?.options.find((o) => o.kind === 'size');
    const bySize = size?.sizes as Record<string, string[]>;
    expect(bySize['asme_b18.3']).toContain('#3-48');
    expect(bySize['asme_b18.3']).not.toContain('#1-64');

    // Mistakes come back readable.
    const unknown = await ask({ cls: 'NoSuchThing' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain('No class "NoSuchThing"');
    const both = await ask({ query: 'x', cls: 'HexNut' });
    expect(both.isError).toBe(true);
  } finally {
    await client.close();
  }
});
