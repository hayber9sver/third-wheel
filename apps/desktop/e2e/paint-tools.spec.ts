/**
 * e2e: Brush and Smart fill tools (cursors, painting, erasing, sizes) and the toolbar's second row.
 */

import { app, closeApp, expect, type HookWindow, launchApp, test } from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Brush tools: circle cursor on the surface, crosshair for Smart fill, no selecting', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const hookEval = <T>(fn: () => T): Promise<T> => page.evaluate(fn);
  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.waitForTimeout(600); // 250 ms camera move
  // Canvas point over the centre of the +Z face (top, visible in Iso).
  const top = await hookEval(() => {
    const hook = (window as HookWindow).__thirdWheelTest;
    if (!hook) throw new Error('test hook missing');
    return hook.viewport.projectToCanvas([5, 10, 30]);
  });
  const cursorState = () =>
    hookEval(() => (window as HookWindow).__thirdWheelTest?.viewport.brushCursorState());
  const cssCursor = () => canvas.evaluate((c) => (c as HTMLCanvasElement).style.cursor);
  const tool = (name: string) => page.locator('#tools button', { hasText: name });

  // Select: no circle.
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await page.waitForTimeout(100);
  expect(await cursorState()).toBeUndefined();

  // B: a 3 mm brush circle lying on the top face, crosshair pointer; clicks don't select.
  await page.keyboard.press('b');
  await expect(tool('Brush')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(box.x + top.x + 1, box.y + top.y);
  await expect.poll(cursorState).toMatchObject({ radius: 3, style: 'brush' });
  const state = await cursorState();
  expect(state?.center[2]).toBeCloseTo(30, 3);
  expect(state?.normal[2]).toBeCloseTo(1, 5);
  expect(await cssCursor()).toBe('crosshair');
  await canvas.click({ position: top });
  expect(await hookEval(() => (window as HookWindow).__thirdWheelTest?.selection.list())).toEqual(
    [],
  );

  // Off the model: circle hidden, normal pointer.
  await page.mouse.move(box.x + 8, box.y + box.height - 8);
  await expect.poll(cursorState).toBeUndefined();
  expect(await cssCursor()).toBe('');

  // Shift in Brush: dashed red erase circle. E is no tool (removed). F: crosshair only.
  await page.keyboard.press('b');
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await expect.poll(cursorState).toMatchObject({ style: 'erase' });
  await page.keyboard.up('Shift');
  await page.mouse.move(box.x + top.x + 2, box.y + top.y);
  await expect.poll(cursorState).toMatchObject({ style: 'brush' });
  await page.keyboard.press('e');
  await expect(tool('Brush')).toHaveAttribute('aria-pressed', 'true');
  await expect(tool('Erase')).toHaveCount(0);
  await tool('Smart fill').click();
  await page.mouse.move(box.x + top.x + 1, box.y + top.y);
  await expect.poll(cssCursor).toBe('crosshair');
  expect(await cursorState()).toBeUndefined();

  // Slicer style: a left drag starting on the model is the tool's (camera stays), not an orbit.
  await page.keyboard.press('b');
  await page.locator('#nav-style').selectOption('slicer');
  const corner = () =>
    hookEval(() => (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([0, 0, 0]));
  const before = await corner();
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await page.mouse.down();
  await page.mouse.move(box.x + top.x + 40, box.y + top.y + 10, { steps: 5 });
  await expect.poll(cursorState, 'circle follows the drag').toBeDefined();
  await page.mouse.up();
  const after = await corner();
  expect(after?.x).toBeCloseTo(before?.x ?? NaN, 3);
  expect(after?.y).toBeCloseTo(before?.y ?? NaN, 3);
  await page.locator('#nav-style').selectOption('fusion');

  await page.keyboard.press('v');
  await expect(tool('Select')).toHaveAttribute('aria-pressed', 'true');
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await expect.poll(cursorState).toBeUndefined();
  expect(await cssCursor()).toBe('');
});

test('Sphere brush: paint, Shift erases, [ ] and Alt + scroll, hidden markers locked', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const painted = () =>
    page.evaluate(() => {
      const t = (window as HookWindow).__thirdWheelTest; // the first marker ("Marker 1")
      return t?.paint()?.count(t.markers.list()[0]?.id ?? '') ?? -1;
    });
  const shown = () =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.paintShownTriangles());
  const radius = () => page.evaluate(() => (window as HookWindow).__thirdWheelTest?.brushRadius());
  const cursorStyle = () =>
    page.evaluate(
      () => (window as HookWindow).__thirdWheelTest?.viewport.brushCursorState()?.style,
    );
  const info = page.locator('#brush-info');

  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const top = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
  );
  if (!top) throw new Error('no projection');
  const strokeOnTop = async (held: string[] = []) => {
    for (const k of held) await page.keyboard.down(k);
    await page.mouse.move(box.x + top.x - 10, box.y + top.y);
    await page.mouse.down();
    await page.mouse.move(box.x + top.x + 10, box.y + top.y, { steps: 6 });
    await page.mouse.up();
    for (const k of held.reverse()) await page.keyboard.up(k);
  };

  // The earlier Brush test clicked the top face, so start from no paint.
  await page.keyboard.press('b');
  for (let i = 0; i < 25; i++) await page.keyboard.press(']');
  expect(await radius()).toBe(50);
  await expect(info).toHaveText(/^Brush 50 mm · \[ \] or Alt \+ scroll: size · Shift: erase \S/);
  await canvas.click({ position: top, modifiers: ['Shift'] });
  await expect.poll(painted).toBe(0);
  await expect.poll(shown).toBe(0);
  for (let i = 0; i < 12; i++) await page.keyboard.press('[');
  expect(await radius()).toBe(3);

  // Brush stroke on the top face paints its triangles with Marker 1, and they are drawn.
  await page.keyboard.press('b');
  await expect(info).toContainText('Brush 3 mm');
  await strokeOnTop();
  await expect.poll(painted).toBeGreaterThan(0);
  await expect.poll(shown).toBe(await painted());
  // The 10 × 20 top face is 2 triangles; the 3 mm stroke cuts them and paints only a part.
  const area = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest
      ?.paint()
      ?.paintedArea((window as HookWindow).__thirdWheelTest?.markers.list()[0]?.id ?? ''),
  );
  expect(area).toBeGreaterThan(10);
  expect(area).toBeLessThan(190);
  await expect
    .poll(() =>
      page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.paintShownPieces()),
    )
    .toBeGreaterThan(0);
  expect(
    await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.isStroking()),
  ).toBe(false);

  // Shift + drag erases in Brush; the circle turns into the erase circle while Shift is held.
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await page.keyboard.down('Shift');
  await expect.poll(cursorStyle).toBe('erase');
  await page.keyboard.up('Shift');
  await expect.poll(cursorStyle).toBe('brush');
  // Shift pressed / let go during a stroke changes nothing: the mode is fixed at the press
  // (pressing it with the button still down used to erase the fresh paint).
  await page.mouse.move(box.x + top.x - 10, box.y + top.y);
  await page.mouse.down();
  await page.mouse.move(box.x + top.x + 10, box.y + top.y, { steps: 6 });
  const fresh = await painted();
  expect(fresh).toBeGreaterThan(0);
  await page.keyboard.down('Shift');
  await page.waitForTimeout(100);
  expect(await painted()).toBe(fresh);
  expect(await cursorStyle()).toBe('brush');
  await page.keyboard.up('Shift');
  await page.mouse.up();
  await strokeOnTop(['Shift']);
  await expect.poll(painted).toBe(0);

  // Alt + scroll up = larger, down = smaller.
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Alt');
  await expect.poll(radius).toBe(5);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Alt');
  await expect.poll(radius).toBe(3);

  // Hidden markers are locked: Shift-erase leaves their paint alone; Hide hides the paint.
  await strokeOnTop();
  const before = await painted();
  expect(before).toBeGreaterThan(0);
  const eye = page.locator('#markers li[data-marker]').first().locator('.marker-eye');
  await eye.click();
  await expect.poll(shown).toBe(0);
  await strokeOnTop(['Shift']);
  expect(await painted()).toBe(before);
  await eye.click();
  await expect.poll(shown).toBe(before);

  // Shift-erase removes only the active marker's paint; the readout under
  // the view names it, and says "Erasing …" while Shift is held.
  const hint = info;
  await expect(hint).toHaveText(/Shift: erase Marker 1$/);
  await page.keyboard.down('Shift');
  await expect(hint).toHaveText('Erasing Marker 1 — release Shift to paint');
  await expect(hint).toHaveClass(/erasing/);
  await page.keyboard.up('Shift');
  await expect(hint).toHaveText(/Shift: erase Marker 1$/);
  const otherId = await page.evaluate(
    () => (window as HookWindow).__thirdWheelTest?.markers.add([], 'Other').id ?? '',
  );
  await page.evaluate((id) => {
    (window as HookWindow).__thirdWheelTest?.markers.setActive(id);
  }, otherId);
  await expect(hint).toHaveText(/Shift: erase Other$/);
  await strokeOnTop(['Shift']);
  expect(await painted()).toBe(before);
  await page.evaluate((id) => {
    const t = (window as HookWindow).__thirdWheelTest;
    t?.markers.remove(id);
    t?.markers.setActive(t.markers.list()[0]?.id ?? '');
  }, otherId);
  await expect(hint).toHaveText(/Shift: erase Marker 1$/);
  await strokeOnTop(['Shift']);
  await expect.poll(painted).toBe(0);
  await page.keyboard.press('v');
  await expect(info).toHaveText('');
});

test('Smart fill: preview, click fills a face, angle, Shift erases, whole CAD face', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const painted = () =>
    page.evaluate(() => {
      const t = (window as HookWindow).__thirdWheelTest; // the first marker ("Marker 1")
      return t?.paint()?.count(t.markers.list()[0]?.id ?? '') ?? -1;
    });
  const preview = () =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.fillPreviewTriangles());
  const angle = () => page.evaluate(() => (window as HookWindow).__thirdWheelTest?.fillAngle());
  const info = page.locator('#brush-info');
  const options = page.locator('#fill-options');

  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const top = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
  );
  if (!top) throw new Error('no projection');
  // Triangles of the top face (z = 30) and of the whole box.
  const { topTris, allTris } = await page.evaluate(() => {
    const m = (window as HookWindow).__thirdWheelTest?.model();
    if (!m) throw new Error('no model');
    const faces = new Set<number>();
    let all = 0;
    let onTop = 0;
    for (let t = 0; t < m.triangleFace.length; t++) {
      all++;
      const z = (k: number) => m.positions[(m.indices[t * 3 + k] ?? 0) * 3 + 2];
      if (z(0) === 30 && z(1) === 30 && z(2) === 30) {
        onTop++;
        faces.add(m.triangleFace[t] ?? -1);
      }
    }
    if (faces.size !== 1) throw new Error('top is not one face');
    return { topTris: onTop, allTris: all };
  });

  // Options appear only with Smart fill; hovering previews the face (90° edges stop the fill).
  await expect(options).toBeHidden();
  await page.keyboard.press('f');
  await expect(options).toBeVisible();
  for (let i = 0; i < 18; i++) await page.keyboard.press('['); // 0° whatever was saved
  for (let i = 0; i < 6; i++) await page.keyboard.press(']');
  await expect.poll(angle).toBe(30);
  await expect(info).toHaveText(
    /^Smart fill 30° · \[ \] or Alt \+ scroll: angle · Shift: erase \S/,
  );
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await expect.poll(preview).toBe(topTris);
  await canvas.click({ position: top });
  await expect.poll(painted).toBe(topTris);

  // 90° crosses the box edges: the whole box. Alt + scroll and the toolbar buttons change it.
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Alt');
  await expect.poll(angle).toBe(40);
  await page.locator('#fill-angle-down').click();
  await expect.poll(angle).toBe(35);
  for (let i = 0; i < 11; i++) await page.keyboard.press(']');
  await expect.poll(angle).toBe(90);
  await expect(page.locator('#fill-angle')).toHaveText('90°');
  await page.mouse.move(box.x + top.x + 1, box.y + top.y);
  await expect.poll(preview).toBe(allTris);
  await canvas.click({ position: top });
  await expect.poll(painted).toBe(allTris);

  // Shift + click erases the region.
  await page.keyboard.down('Shift');
  await canvas.click({ position: top });
  await page.keyboard.up('Shift');
  await expect.poll(painted).toBe(0);

  // Whole CAD face: exactly the clicked face, angle ignored (its buttons disabled).
  await page.locator('#fill-whole-face').check();
  await expect(info).toHaveText(/^Smart fill · whole CAD face · Shift: erase \S/);
  await expect(page.locator('#fill-angle-up')).toBeDisabled();
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await expect.poll(preview).toBe(topTris);
  await canvas.click({ position: top });
  await expect.poll(painted).toBe(topTris);

  // Clean up for later tests: no paint, default settings, Select.
  await page.keyboard.down('Shift');
  await canvas.click({ position: top });
  await page.keyboard.up('Shift');
  await expect.poll(painted).toBe(0);
  await page.locator('#fill-whole-face').uncheck();
  for (let i = 0; i < 12; i++) await page.keyboard.press('[');
  await expect.poll(angle).toBe(30);
  await page.keyboard.press('v');
  await expect(options).toBeHidden();
  await expect.poll(preview).toBe(0);
});

test('Toolbar second row follows the tool: Pick + Add to marker, marker + size / angle; fits 960 px', async () => {
  const page = await app.firstWindow();
  const rows = page.locator('#markers li[data-marker]');
  const menu = page.locator('.context-menu:not([hidden])');
  const filterRow = page.locator('#selection-filter');
  const addTo = page.locator('#add-to-marker');
  const paintMarker = page.locator('#paint-marker');
  const brushOptions = page.locator('#brush-options');
  const fillOptions = page.locator('#fill-options');
  const hint = page.locator('#brush-info'); // names the marker Shift erases
  const setSelection = (items: { kind: 'edge'; id: number }[]) =>
    page.evaluate((list) => {
      const sel = (window as HookWindow).__thirdWheelTest?.selection;
      sel?.clear();
      sel?.addAll(list);
    }, items);

  // Select: Pick filter + "Add to marker ▾" (greyed out with nothing selected).
  await page.keyboard.press('v');
  await setSelection([]);
  await expect(filterRow).toBeVisible();
  await expect(paintMarker).toBeHidden();
  await expect(brushOptions).toBeHidden();
  await expect(hint).toHaveText('');
  await expect(addTo).toBeDisabled();
  await setSelection([{ kind: 'edge', id: 0 }]);
  await expect(addTo).toBeEnabled();
  const rowCount = await rows.count();
  await addTo.click();
  await expect(menu).toHaveCount(1);
  await expect(menu.locator('[data-action^="add-to:"]')).toHaveCount(rowCount);
  await addTo.click(); // the button toggles the dropdown
  await expect(menu).toHaveCount(0);
  await addTo.click();
  await menu.locator('[data-action="new-marker"]').click();
  await expect(rows).toHaveCount(rowCount + 1);
  await expect(rows.last().locator('.marker-count')).toHaveText(/^1 item/);

  // Brush: the marker it paints with (the new one is active), size, Shift hint; no Pick.
  await page.keyboard.press('b');
  await expect(filterRow).toBeHidden();
  await expect(paintMarker).toBeVisible();
  await expect(brushOptions).toBeVisible();
  await expect(fillOptions).toBeHidden();
  const lastName = (await rows.last().locator('.marker-name').textContent()) ?? '';
  await expect(hint).toHaveText(new RegExp(`Shift: erase ${lastName}$`));
  await expect(page.locator('#active-marker-name')).toHaveText(lastName);
  const size = page.locator('#brush-size');
  const before = await size.textContent();
  await page.locator('#brush-size-up').click();
  await expect(size).not.toHaveText(before ?? '');
  await page.locator('#brush-size-down').click();
  await expect(size).toHaveText(before ?? '');
  // The dropdown switches the active marker (ticked) — same as clicking its row.
  await page.locator('#active-marker').click();
  const firstChoice = menu.locator('[data-action^="paint-with:"]').first();
  await expect(menu.locator('[aria-checked="true"]')).toHaveCount(1);
  await firstChoice.click();
  await expect(rows.first()).toHaveClass(/active/);
  const firstName = (await rows.first().locator('.marker-name').textContent()) ?? '';
  await expect(page.locator('#active-marker-name')).toHaveText(firstName);

  // Smart fill: marker + angle options; no brush size.
  await page.keyboard.press('f');
  await expect(paintMarker).toBeVisible();
  await expect(brushOptions).toBeHidden();
  await expect(fillOptions).toBeVisible();
  await expect(hint).toContainText('Shift: erase');

  // Leave the app as found.
  await page.keyboard.press('v');
  await rows.last().hover();
  await rows.last().locator('.marker-delete').click();
  await expect(rows).toHaveCount(rowCount);
  await setSelection([]);

  // One row from the 960 px minimum window up — nothing cut off, no wrap, and the tool
  // options start at the same place for every tool (no jump on tool switch).
  const setWidth = (w: number) =>
    app.evaluate(({ BrowserWindow }, width) => {
      const win = BrowserWindow.getAllWindows()[0];
      const [, h] = win?.getContentSize() ?? [0, 800];
      win?.setContentSize(width, h ?? 800);
    }, w);
  const original = await page.evaluate(() => window.innerWidth);
  for (const width of [960, 1100, 1366, 1440]) {
    await setWidth(width);
    // At 175 % display scaling Windows rounds the content size: 960 → innerWidth 961.
    await expect
      .poll(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - width))
      .toBeLessThanOrEqual(1);
    const inner = await page.evaluate(() => window.innerWidth);
    // The toolbar refits on its ResizeObserver: let two frames pass before measuring.
    await page.evaluate(
      () =>
        new Promise<void>((done) => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              done();
            });
          });
        }),
    );
    const starts: number[] = [];
    for (const key of ['v', 'b', 'f']) {
      await page.keyboard.press(key);
      const m = await page.evaluate(() => {
        const tb = document.querySelector<HTMLElement>('.toolbar');
        const opts = [...document.querySelectorAll<HTMLElement>('#selection-filter, #paint-marker')]
          .filter((e) => !e.hidden)
          .map((e) => e.getBoundingClientRect().left);
        return {
          over: (tb?.scrollWidth ?? 0) - (tb?.clientWidth ?? 0),
          h: tb?.getBoundingClientRect().height ?? 0,
          sendRight: document.getElementById('send-ai')?.getBoundingClientRect().right ?? 0,
          start: opts[0] ?? -1,
        };
      });
      expect(m.over, `toolbar overflows at ${String(width)} px (${key})`).toBeLessThanOrEqual(0);
      // Fractional display scaling (Windows 175 %) leaves float noise: 44.0000038.
      expect(m.h).toBeCloseTo(44, 2);
      expect(m.sendRight).toBeLessThanOrEqual(inner + 0.01);
      starts.push(Math.round(m.start * 100) / 100);
    }
    expect(new Set(starts).size, `tool options move at ${String(width)} px`).toBe(1);
    // Maximised at 175 % on Windows (≈ 1440 px) the tools go icon-only first; the file
    // buttons keep their labels.
    if (width >= 1440)
      for (const id of ['open-model', 'add-file', 'parts-menu', 'versions-menu'])
        await expect(
          page.locator(`#${id} .tb-label`),
          `${id} label at ${String(width)} px`,
        ).toBeVisible();
  }
  await setWidth(original);
  await page.keyboard.press('v');
});
