/**
 * e2e: the Markers palette, undo / redo, markers holding selections.
 */

import { app, closeApp, expect, type HookWindow, launchApp, test } from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Markers: starts with Marker 1, add / rename / recolour / hide / delete, circle colour', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const section = page.locator('#markers');
  const rows = section.locator('li[data-marker]');
  const names = () => rows.locator('.marker-name').allTextContents();
  const cursorColor = async () =>
    (
      await page.evaluate(() =>
        (window as HookWindow).__thirdWheelTest?.viewport.brushCursorState(),
      )
    )?.color;

  await expect(rows).toHaveCount(1);
  expect(await names()).toEqual(['Marker 1']);
  await expect(rows.first()).toHaveClass(/active/);

  // Brush circle in the active marker's colour (Marker 1 = orange).
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const top = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
  );
  if (!top) throw new Error('no projection');
  await page.keyboard.press('b');
  await page.mouse.move(box.x + top.x + 2, box.y + top.y); // must be a real move
  await expect.poll(cursorColor).toBe(0xff8a1f);

  // + Add: Marker 2, green, active; the circle follows.
  await section.locator('#marker-add').click();
  expect(await names()).toEqual(['Marker 1', 'Marker 2']);
  await expect(rows.nth(1)).toHaveClass(/active/);
  await page.mouse.move(box.x + top.x + 1, box.y + top.y);
  await expect.poll(cursorColor).toBe(0x2fbf71);

  // Click a row = active.
  await rows.first().locator('.marker-name').click();
  await expect(rows.first()).toHaveClass(/active/);

  // Double-click renames; Enter commits, Esc cancels (and keeps the selection logic out of it).
  await rows.first().locator('.marker-name').dblclick();
  const input = section.locator('.marker-name-input');
  await expect(input).toBeFocused();
  await input.fill('Too thin');
  await input.press('Enter');
  expect(await names()).toEqual(['Too thin', 'Marker 2']);
  await rows.first().locator('.marker-name').dblclick();
  await section.locator('.marker-name-input').fill('nope');
  await section.locator('.marker-name-input').press('Escape');
  expect(await names()).toEqual(['Too thin', 'Marker 2']);
  // Clicking another row while renaming keeps the name and activates that row in one click.
  await rows.first().locator('.marker-name').dblclick();
  await section.locator('.marker-name-input').fill('Too thin!');
  await rows.nth(1).locator('.marker-name').click();
  expect(await names()).toEqual(['Too thin!', 'Marker 2']);
  await expect(rows.nth(1)).toHaveClass(/active/);
  await rows.first().locator('.marker-name').dblclick();
  await section.locator('.marker-name-input').fill('Too thin');
  await section.locator('.marker-name-input').press('Enter');

  // A name another marker uses (case ignored) is refused: the field stays open with the reason;
  // Esc keeps the old name; leaving the field keeps it too and says why.
  await rows.nth(1).locator('.marker-name').dblclick();
  await section.locator('.marker-name-input').fill('too THIN');
  await section.locator('.marker-name-input').press('Enter');
  await expect(section.locator('.marker-name-input')).toHaveAttribute('aria-invalid', 'true');
  await expect(section.locator('.marker-name-error')).toHaveText(
    'There\'s already a marker called "Too thin" — pick another name.',
  );
  await section.locator('.marker-name-input').press('Escape');
  await expect(section.locator('.marker-name-error')).toHaveCount(0);
  expect(await names()).toEqual(['Too thin', 'Marker 2']);
  await rows.nth(1).locator('.marker-name').dblclick();
  await section.locator('.marker-name-input').fill('Too thin');
  await rows.first().locator('.marker-name').click();
  expect(await names()).toEqual(['Too thin', 'Marker 2']);
  await expect(page.locator('#notice-text')).toContainText(
    'Name not changed. There\'s already a marker called "Too thin"',
  );

  // Swatch → menu with 8 colours + Custom…; pick Purple.
  await rows.first().locator('.marker-swatch').click();
  const menu = section.locator('.color-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.color-choice')).toHaveCount(8);
  await expect(menu.locator('.color-custom')).toBeVisible();
  await menu.locator('.color-choice[title="Purple"]').click();
  await expect(menu).toBeHidden();
  await page.mouse.move(box.x + top.x, box.y + top.y);
  await expect.poll(cursorColor).toBe(0x8b5cf6);

  // Eye hides (row greyed, pressed=false).
  const eye = rows.first().locator('.marker-eye');
  await eye.click();
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await expect(rows.first()).toHaveClass(/marker-hidden/);

  // Delete key on a focused row removes it (Backspace doesn't); focus moves to the next row.
  await rows.first().focus();
  await page.keyboard.press('Backspace');
  expect(await names()).toEqual(['Too thin', 'Marker 2']);
  await page.keyboard.press('Delete');
  expect(await names()).toEqual(['Marker 2']);
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await names()).toEqual(['Too thin', 'Marker 2']);

  // Delete the active marker → the other becomes active; delete the last → empty hint, grey circle.
  await rows.first().hover();
  await rows.first().locator('.marker-delete').click();
  expect(await names()).toEqual(['Marker 2']);
  await expect(rows.first()).toHaveClass(/active/);
  await rows.first().locator('.marker-delete').click();
  await expect(rows).toHaveCount(0);
  await expect(section.locator('.empty')).toBeVisible();
  await page.mouse.move(box.x + top.x + 1, box.y + top.y);
  await expect.poll(cursorColor).toBe(0x8d939d);
  await section.locator('#marker-add').click();
  expect(await names()).toEqual(['Marker 1']);
  await page.keyboard.press('v');
});

test('Undo / redo: a paint stroke, keys and buttons, marker delete brings its paint back', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const section = page.locator('#markers');
  const rows = section.locator('li[data-marker]');
  const undo = page.locator('#undo');
  const redo = page.locator('#redo');
  const activeId = await page.evaluate(
    () => (window as HookWindow).__thirdWheelTest?.markers.active()?.id ?? '',
  );
  expect(activeId).not.toBe('');
  const painted = () =>
    page.evaluate(
      (id) => (window as HookWindow).__thirdWheelTest?.paint()?.count(id) ?? -1,
      activeId,
    );

  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const top = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
  );
  if (!top) throw new Error('no projection');
  await page.keyboard.press('b');
  await page.mouse.move(box.x + top.x - 10, box.y + top.y);
  await page.mouse.down();
  await page.mouse.move(box.x + top.x + 10, box.y + top.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(painted).toBeGreaterThan(0);
  const strokeCount = await painted();
  await expect(undo).toBeEnabled();
  await expect(undo).toHaveAttribute('title', /^Undo Brush stroke \(/);
  await expect(redo).toBeDisabled();

  // Keys: Cmd/Ctrl+Z undoes the whole stroke, Cmd/Ctrl+Shift+Z redoes it.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(painted).toBe(0);
  await expect(redo).toBeEnabled();
  await expect(redo).toHaveAttribute('title', /^Redo Brush stroke \(/);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(painted).toBe(strokeCount);
  await expect(redo).toBeDisabled();

  // Delete doesn't ask; the undo button brings the marker and its paint back, redo drops them.
  const before = await rows.count();
  await rows.first().hover();
  await rows.first().locator('.marker-delete').click();
  await expect(rows).toHaveCount(before - 1);
  await expect(undo).toHaveAttribute('title', /^Undo Delete marker \(/);
  await undo.click();
  await expect(rows).toHaveCount(before);
  await expect.poll(painted).toBe(strokeCount);
  await redo.click();
  await expect(rows).toHaveCount(before - 1);
  await expect.poll(painted).toBe(0);
  await undo.click();
  await expect.poll(painted).toBe(strokeCount);

  // Undo the stroke, so later tests start from no paint.
  await undo.click();
  await expect.poll(painted).toBe(0);
  await page.keyboard.press('v');
});

test('Markers hold selections: right-click menu, + Selection, list, hide, undo', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const section = page.locator('#markers');
  const rows = section.locator('li[data-marker]');
  const menu = page.locator('.context-menu:not([hidden])');
  const undo = page.locator('#undo');
  const redo = page.locator('#redo');
  const stats = () =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.markerEntityStats());
  const selected = () =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.selection.list() ?? []);
  const clearSelection = () =>
    page.evaluate(() => {
      (window as HookWindow).__thirdWheelTest?.selection.clear();
    });

  await page.keyboard.press('v');
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  await clearSelection();
  const top = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
  );
  if (!top) throw new Error('no projection');
  const rowCount = await rows.count();

  // Right-click on the unselected top face selects it and opens the menu (like Fusion).
  await page.mouse.click(box.x + top.x, box.y + top.y, { button: 'right' });
  await expect(menu).toHaveCount(1);
  expect(await selected()).toEqual([expect.objectContaining({ kind: 'face' })]);
  await menu.locator('[data-action="add-to-marker"]').hover();
  await menu.locator('[data-action="new-marker"]').click();
  await expect(menu).toHaveCount(0);
  await expect(rows).toHaveCount(rowCount + 1);
  const newRow = rows.last();
  await expect(newRow).toHaveClass(/active/);
  await expect(newRow.locator('.marker-count')).toHaveText(/^1 item/);
  expect(await selected()).toEqual([]); // used up
  // Face = see-through tint (the 2 triangles of the box face) + its 4-sided outline.
  expect(await stats()).toEqual({ tris: 2, lines: 4, bodyLines: 0, dots: 0 });
  await expect(undo).toHaveAttribute('title', /^Undo New marker from selection \(/);

  // Undo / redo the new marker with its entity.
  await undo.click();
  await expect(rows).toHaveCount(rowCount);
  expect((await stats())?.tris).toBe(0);
  await redo.click();
  await expect(rows).toHaveCount(rowCount + 1);
  expect((await stats())?.tris).toBe(2);

  // Hiding the marker hides its entities.
  await newRow.locator('.marker-eye').click();
  expect((await stats())?.tris).toBe(0);
  await newRow.locator('.marker-eye').click();
  expect((await stats())?.tris).toBe(2);

  // "+ Selection" on the active row: greyed out with nothing selected, adds an edge.
  await clearSelection();
  const addSel = newRow.locator('.marker-add-selection');
  await expect(addSel).toBeDisabled();
  await page.evaluate(() => {
    (window as HookWindow).__thirdWheelTest?.selection.addAll([{ kind: 'edge', id: 0 }]);
  });
  await expect(addSel).toBeEnabled();
  await addSel.click();
  await expect(newRow.locator('.marker-count')).toHaveText(/^2 items/);
  expect(await selected()).toEqual([]);
  await expect(addSel).toBeDisabled();
  expect((await stats())?.lines).toBeGreaterThan(4);
  await expect(undo).toHaveAttribute('title', /^Undo Add to marker \(/);

  // The list under the row: closed by default; click selects, × removes.
  const list = section.locator('.marker-entities');
  await expect(list).toHaveCount(0);
  await newRow.locator('.marker-count').click();
  await expect(list.locator('.marker-entity')).toHaveCount(2);
  await expect(list.locator('.marker-entity').first()).toContainText('Face');
  await clearSelection();
  await list.locator('.marker-entity').first().locator('.marker-entity-label').click();
  expect(await selected()).toEqual([expect.objectContaining({ kind: 'face' })]);
  await list.locator('.marker-entity').nth(1).hover();
  await list.locator('.marker-entity').nth(1).locator('.marker-entity-remove').click();
  await expect(list.locator('.marker-entity')).toHaveCount(1);
  expect(await stats()).toEqual({ tris: 2, lines: 4, bodyLines: 0, dots: 0 });

  // Right-click on the background with nothing selected: everything greyed out; Esc closes.
  await clearSelection();
  await page.mouse.click(box.x + 8, box.y + box.height - 8, { button: 'right' });
  await expect(menu).toHaveCount(1);
  await expect(menu).toContainText('Select something first');
  await expect(menu.locator('[data-action="add-to-marker"]')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // Right-click the face again → "Remove from marker ▸" lists only markers holding it.
  await page.mouse.click(box.x + top.x, box.y + top.y, { button: 'right' });
  await menu.locator('[data-action="remove-from-marker"]').hover();
  const removeItems = page.locator('.context-menu [data-action^="remove-from:"]');
  await expect(removeItems).toHaveCount(1);
  await removeItems.click();
  await expect(newRow.locator('.marker-count')).toHaveCount(0);
  expect((await stats())?.tris).toBe(0);

  // Leave the app as found: drop the marker, clear the selection.
  await newRow.hover();
  await newRow.locator('.marker-delete').click();
  await expect(rows).toHaveCount(rowCount);
  await clearSelection();
});
