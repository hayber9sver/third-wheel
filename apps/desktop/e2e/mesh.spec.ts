/**
 * e2e: mesh-only mode (STL / 3MF) and moving mesh paint onto a STEP.
 */
import { connectBridge } from '@third-wheel/mcp-server';
import { join } from 'node:path';
import { mustReadNotes, hasNotes } from './notes.js';
import { mkdirSync, copyFileSync, renameSync, readdirSync } from 'node:fs';
import {
  app,
  bridgeFile,
  closeApp,
  dir,
  expect,
  type HookWindow,
  launchApp,
  openStubbed,
  test,
} from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Mesh-only mode: an STL opens with a banner, paints, saves its notes, no entity picks', async () => {
  const page = await app.firstWindow();
  const hook = <T>(fn: () => T) => page.evaluate(fn);
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.model() !== undefined);
  const client = await connectBridge({ filePath: bridgeFile });
  const stl = join(dir, 'box.stl');
  try {
    const loaded = (await client.call('load', { path: stl })) as { mesh?: string; bodies: number };
    expect(loaded).toMatchObject({ mesh: 'stl', bodies: 1 });
    await expect(page.locator('#mesh-banner')).toBeVisible();
    await expect(page.locator('#mesh-banner-text')).toContainText('Entity selection needs STEP');
    await expect(page.locator('#filter-buttons button').first()).toBeDisabled();
    // The active marker row has no "+ Selection" (a mesh has no entities).
    await expect(page.locator('#markers .marker-row.active')).toHaveCount(1);
    await expect(page.locator('.marker-add-selection')).toHaveCount(0);
    await expect(client.call('load', { path: stl, revisionOf: 'abcdef123456' })).rejects.toThrow(
      /needs a STEP file/,
    );

    await page.keyboard.press('Escape');
    await page.keyboard.press('0');
    await page.waitForTimeout(600);
    const top = await hook(() =>
      (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
    );
    if (!top) throw new Error('no projection');
    // Select tool: nothing is picked, a click selects nothing.
    expect(
      await page.evaluate(
        (q) => (window as HookWindow).__thirdWheelTest?.viewport.pick(q.x, q.y),
        top,
      ),
    ).toBeUndefined();
    const canvas = page.locator('#viewport canvas').first();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no canvas box');
    await canvas.click({ position: top });
    expect(await hook(() => (window as HookWindow).__thirdWheelTest?.selection.list())).toEqual([]);

    // Brush works.
    const active = await hook(() => (window as HookWindow).__thirdWheelTest?.markers.active()?.id);
    if (!active) throw new Error('no active marker');
    const painted = () =>
      page.evaluate(
        (id) => (window as HookWindow).__thirdWheelTest?.paint()?.count(id) ?? -1,
        active,
      );
    await page.keyboard.press('b');
    await page.mouse.move(box.x + top.x - 10, box.y + top.y);
    await page.mouse.down();
    await page.mouse.move(box.x + top.x + 10, box.y + top.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(painted).toBeGreaterThan(0);
    const before = await painted();

    // Notes next to the STL: format stl, no tessellation; reopening brings the paint back.
    await hook(() => (window as HookWindow).__thirdWheelTest?.flush());
    const doc = mustReadNotes(stl);
    expect(doc.model.format).toBe('stl');
    expect(doc.tessellation).toBeUndefined();
    await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen(true));
    await expect.poll(painted).toBe(before);
    await page.keyboard.press('Escape');

    // Back to STEP: banner gone, picking back.
    await client.call('load', { path: join(dir, 'box.step') });
    await expect(page.locator('#mesh-banner')).toBeHidden();
    await expect(page.locator('#filter-buttons button').first()).toBeEnabled();
    await expect(page.locator('.marker-add-selection')).toHaveCount(1);
  } finally {
    client.close();
  }
});

test('Mesh paint → STEP: revisionOf, Open asks (same size), Add file with a STEP', async () => {
  const page = await app.firstWindow();
  const hook = <T>(fn: () => T) => page.evaluate(fn);
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.model() !== undefined);
  const folder = join(dir, 'mesh-to-step');
  mkdirSync(folder);
  copyFileSync(join(dir, 'box.stl'), join(folder, 'cover.stl'));
  for (const n of ['cover-cad.step', 'cover-open.step', 'cover-import.step'])
    copyFileSync(join(dir, 'box.step'), join(folder, n));
  const stl = join(folder, 'cover.stl');
  const pick = async (name: string): Promise<void> => {
    const path = join(folder, name);
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
    }, path);
  };
  const loadedName = (name: string) =>
    expect(page.locator('#model-info')).toHaveText(
      new RegExp(`^${name.replace(/[.()]/g, '\\$&')} · `),
      { timeout: 60_000 },
    );
  const paintedCount = () =>
    page.evaluate(() => {
      const h = (window as HookWindow).__thirdWheelTest;
      const id = h?.markers.list()[0]?.id;
      return id ? (h.paint()?.count(id) ?? 0) : 0;
    });
  const client = await connectBridge({ filePath: bridgeFile });
  try {
    const mesh = (await client.call('load', { path: stl })) as { modelId: string; mesh?: string };
    expect(mesh.mesh).toBe('stl');
    // Paint the top (z = 30) with the brush.
    await page.keyboard.press('Escape');
    await page.keyboard.press('0');
    await page.waitForTimeout(600);
    const top = await hook(() =>
      (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
    );
    if (!top) throw new Error('no projection');
    const box = await page.locator('#viewport canvas').first().boundingBox();
    if (!box) throw new Error('no canvas box');
    await page.keyboard.press('b');
    await page.mouse.move(box.x + top.x - 10, box.y + top.y);
    await page.mouse.down();
    await page.mouse.move(box.x + top.x + 10, box.y + top.y, { steps: 6 });
    await page.mouse.up();
    await expect.poll(paintedCount).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await hook(() => (window as HookWindow).__thirdWheelTest?.flush());

    // 1. The AI: load_model revisionOf = the mesh. Paint lands on the STEP's faces, report given.
    const loaded = (await client.call('load', {
      path: join(folder, 'cover-cad.step'),
      revisionOf: mesh.modelId,
    })) as {
      modelId: string;
      markers: number;
      revision?: {
        annotations: string;
        transfer?: { found: number; fromMesh?: { points: number; matched: number } };
      };
    };
    expect(loaded.markers).toBe(1);
    expect(loaded.revision?.annotations).toBe('moved');
    expect(loaded.revision?.transfer?.found).toBe(1);
    const cov = loaded.revision?.transfer?.fromMesh;
    expect(cov?.points).toBeGreaterThan(0);
    expect(cov?.matched).toBe(cov?.points);
    await expect.poll(paintedCount).toBeGreaterThan(0);
    await expect(page.locator('#notice-text')).toContainText(
      'Notes from cover.stl moved onto cover-cad.step: 1 marker, 100 % of the paint matched',
    );
    // Painted triangles of the STEP are on its top (z = 30), not anywhere else.
    const zs = await hook(() => {
      const h = (window as HookWindow).__thirdWheelTest;
      const m = h?.model();
      const id = h?.markers.list()[0]?.id;
      if (!m || !id) return [];
      const out: number[] = [];
      for (let t = 0; t < m.triangleFace.length; t++)
        if (
          (h.paint() as unknown as { markersAt(t: number): string[] } | undefined)
            ?.markersAt(t)
            .includes(id)
        )
          for (let k = 0; k < 3; k++)
            out.push(m.positions[(m.indices[t * 3 + k] ?? 0) * 3 + 2] ?? 0);
      return out;
    });
    expect(zs.length).toBeGreaterThan(0);
    for (const z of zs) expect(z).toBeCloseTo(30, 3);
    await hook(() => (window as HookWindow).__thirdWheelTest?.flush());
    const stepDoc = mustReadNotes(join(folder, 'cover-cad.step'));
    expect(stepDoc.model.format).toBe('step');
    expect(stepDoc.markers).toHaveLength(1);
    expect(stepDoc.versions?.earlier?.[0]?.name).toBe('cover.stl');
    const stlDoc = mustReadNotes(stl);
    expect(stlDoc.model.format).toBe('stl');
    expect(stlDoc.versions?.newer?.[0]?.name).toBe('cover-cad.step');
    // Never onto a mesh.
    await expect(client.call('load', { path: stl, revisionOf: loaded.modelId })).rejects.toThrow(
      /needs a STEP file/,
    );

    // 2. Reopening the STL names the newer STEP; opening a same-size STEP asks.
    await pick('cover.stl');
    await openStubbed();
    await loadedName('cover.stl');
    await expect(page.locator('#notice-text')).toContainText(
      "There's a newer version: cover-cad.step",
    );
    await pick('cover-open.step');
    await openStubbed();
    await expect(page.locator('#version-title')).toHaveText(
      'Is cover-open.step the same part as cover.stl?',
      { timeout: 60_000 },
    );
    await page.locator('#version-bring').click();
    await loadedName('cover-open.step');
    await expect(page.locator('#notice-text')).toContainText(
      'Notes from cover.stl moved onto cover-open.step',
    );
    await expect.poll(paintedCount).toBeGreaterThan(0);

    // 3. Toolbar Add file → New version of … while the mesh is shown (it always asks).
    await pick('cover.stl');
    await openStubbed();
    await loadedName('cover.stl');
    await pick('cover-import.step');
    await page.locator('#add-file').click();
    // The question says where the paint goes; no "name looks like" hint (the names differ).
    const question = page.locator('#choice-dialog[open] #choice-text');
    await expect(question).toContainText(
      'paint and comments move onto the faces of cover-import.step',
    );
    await expect(question).not.toContainText('looks like');
    await page.locator('#choice-first').click();
    await loadedName('cover-import.step');
    await expect(page.locator('#notice-text')).toContainText(
      'Notes from cover.stl moved onto cover-import.step',
    );
    await expect.poll(paintedCount).toBeGreaterThan(0);

    // 4. The STL in Versions ▾ is found (not "not found"); Compare greyed; Locate… works.
    const menu = page.locator('#versions-menu');
    const rows = page.locator('.context-menu-item[data-action="version-row"]');
    // Every version of the part: the three STEP files made from the STL, and the STL.
    const stlRow = rows.filter({ hasText: /cover(-moved)?\.stl/ });
    await menu.click();
    await expect(rows).toHaveCount(3);
    await expect(stlRow).toContainText('cover.stl');
    await expect(stlRow).not.toContainText('not found');
    await stlRow.click();
    await expect(page.locator('[data-action="compare-version"]')).toBeDisabled();
    await expect(page.locator('[data-action="open-version"]')).toBeEnabled();
    await page.keyboard.press('Escape'); // the submenu
    await page.keyboard.press('Escape'); // the menu
    await expect(rows).toHaveCount(0);
    mkdirSync(join(folder, 'moved'));
    renameSync(stl, join(folder, 'moved', 'cover-moved.stl'));
    await menu.click();
    await expect(stlRow).toContainText('not found');
    await stlRow.click();
    await pick(join('moved', 'cover-moved.stl'));
    await page.locator('[data-action="locate-version"]').click();
    await expect(page.locator('#notice-text')).toContainText('Found cover.stl');
    await menu.click();
    await expect(stlRow).toContainText('cover-moved.stl');
    await expect(stlRow).not.toContainText('not found');
    await page.keyboard.press('Escape');
  } finally {
    client.close();
  }
});

test('STL without notes → newer STEP: reopening the STL gives no warning, no .bak', async () => {
  const page = await app.firstWindow();
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.model() !== undefined);
  const folder = join(dir, 'mesh-no-notes');
  mkdirSync(folder);
  const stl = join(folder, 'plain.stl');
  copyFileSync(join(dir, 'box.stl'), stl);
  copyFileSync(join(dir, 'box.step'), join(folder, 'plain-cad.step'));
  const client = await connectBridge({ filePath: bridgeFile });
  try {
    const mesh = (await client.call('load', { path: stl })) as { modelId: string };
    expect(hasNotes(stl), 'no notes yet').toBe(false);
    await client.call('load', { path: join(folder, 'plain-cad.step'), revisionOf: mesh.modelId });
    // The STL is in the project as the STEP's earlier version (no paint) — in its own format.
    const doc = mustReadNotes(stl);
    expect(doc.model.format).toBe('stl');
    expect(doc.tessellation).toBeUndefined();
    expect(doc.versions?.newer?.[0]?.name).toBe('plain-cad.step');

    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
    }, stl);
    await openStubbed();
    await expect(page.locator('#model-info')).toHaveText(/^plain\.stl · /, { timeout: 60_000 });
    await expect(page.locator('#notice-text')).toContainText(
      "There's a newer version: plain-cad.step",
    );
    await expect(page.locator('#alert-dialog')).not.toBeVisible();
    expect(readdirSync(folder).filter((n) => n.includes('.bak'))).toEqual([]);
  } finally {
    client.close();
  }
});
