/**
 * e2e: the comment panel and 3D comment pins.
 */

import { app, closeApp, expect, type HookWindow, launchApp, test } from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Comments: write on a marker, focus, click geometry, on selection, resolve, edit, delete', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const section = page.locator('#comments');
  const cards = section.locator('li[data-comment]');
  const composer = section.locator('.comment-box');
  const input = composer.locator('textarea');
  const markerRows = page.locator('#markers li[data-marker]');
  const undo = page.locator('#undo');
  const redo = page.locator('#redo');
  const focusStats = () =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.commentFocusStats());
  const clearSelection = () =>
    page.evaluate(() => {
      (window as HookWindow).__thirdWheelTest?.selection.clear();
    });

  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const top = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
  );
  if (!top) throw new Error('no projection');

  // A fresh marker painted on the top face with Smart fill.
  await page.locator('#marker-add').click();
  const markerId = await page.evaluate(
    () => (window as HookWindow).__thirdWheelTest?.markers.active()?.id ?? '',
  );
  await page.keyboard.press('f');
  await page.mouse.click(box.x + top.x, box.y + top.y);
  await page.keyboard.press('v');
  const markerName = (await markerRows.last().locator('.marker-name').textContent()) ?? '';

  // "+ Comment": the active marker is ticked; Cmd/Ctrl+Enter posts.
  await expect(composer).toBeHidden();
  await section.locator('#comment-add').click();
  await expect(composer).toBeVisible();
  await expect(input).toBeFocused();
  await expect(composer.locator('.comment-chip')).toHaveText(markerName);
  await expect(page.locator('#comment-post')).toBeDisabled();
  await input.fill('Top face: add a 1 mm chamfer');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(composer).toBeHidden();
  await expect(cards).toHaveCount(1);
  const card = cards.first();
  await expect(card.locator('.comment-text')).toHaveText('Top face: add a 1 mm chamfer');
  await expect(card.locator('.comment-chip')).toHaveText(markerName);
  await expect(card.locator('.comment-author')).toHaveText('You');
  await expect(undo).toHaveAttribute('title', /^Undo Add comment \(/);
  expect(await focusStats()).toEqual({ items: 0, markers: 0, faded: 0 });

  // Clicking the card highlights it: its marker keeps its colour, the others fade; the camera
  // doesn't move. ⌖ zooms; a double-click edits and leaves it highlighted.
  const cameraProbe = () =>
    page.evaluate(() =>
      (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas([5, 10, 30]),
    );
  const before = await cameraProbe();
  await card.locator('.comment-text').click();
  await expect(card).toHaveClass(/focused/);
  const focused = await focusStats();
  expect(focused).toMatchObject({ items: 0, markers: 1 });
  expect(focused?.faded).toBeGreaterThan(0);
  await page.waitForTimeout(400);
  const after = await cameraProbe();
  expect(after?.x).toBeCloseTo(before?.x ?? NaN, 3);
  expect(after?.y).toBeCloseTo(before?.y ?? NaN, 3);
  await card.locator('.comment-text').click();
  await expect(card).not.toHaveClass(/focused/);
  expect((await focusStats())?.markers).toBe(0);
  await card.locator('[data-action="zoom"]').click();
  await expect(card).toHaveClass(/focused/);
  await page.waitForTimeout(600);
  const zoomed = await cameraProbe();
  expect(
    Math.hypot((zoomed?.x ?? 0) - (before?.x ?? 0), (zoomed?.y ?? 0) - (before?.y ?? 0)),
  ).toBeGreaterThan(5);
  await card.locator('.comment-text').click(); // unfocus
  await card.locator('.comment-text').dblclick();
  await expect(card).toHaveClass(/focused/);
  await expect(composer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(composer).toBeHidden();
  await card.locator('.comment-text').click(); // unfocus
  expect((await focusStats())?.markers).toBe(0);
  // Back to the whole box in the iso view for the clicks below.
  await clearSelection();
  await page.keyboard.press('z');
  await page.keyboard.press('0');
  await page.waitForTimeout(800);
  const topNow = await cameraProbe();
  if (!topNow) throw new Error('no projection');
  top.x = topNow.x;
  top.y = topNow.y;

  // Clicking the painted face in the view lists its comment; it still selects as before. Below
  // left of the face centre: the comment's 3D pin sits on the centre, reaching up-right.
  top.x -= 12;
  top.y += 8;
  await clearSelection();
  await page.mouse.click(box.x + top.x, box.y + top.y);
  await expect(card).toHaveClass(/here/);
  await expect(section.locator('.comment-here-bar')).toContainText('1 comment');
  expect(
    await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.selection.list().length),
  ).toBe(1);
  // A click on the background clears the list.
  await page.mouse.click(box.x + 8, box.y + box.height - 8);
  await expect(card).not.toHaveClass(/here/);

  // Comment on selection (right-click menu): a new marker "Comment 1" holding the selection,
  // made on post — one undo step together with the comment.
  const markerCount = await markerRows.count();
  await page.mouse.click(box.x + top.x, box.y + top.y, { button: 'right' });
  await page.locator('.context-menu [data-action="comment-on-selection"]').click();
  await expect(composer).toBeVisible();
  await expect(composer.locator('.comment-chip.pending')).toContainText('Comment 1');
  await expect(markerRows).toHaveCount(markerCount);
  await input.fill('Why is this face so thin?');
  await page.locator('#comment-post').click();
  await expect(cards).toHaveCount(2);
  await expect(markerRows).toHaveCount(markerCount + 1);
  await expect(markerRows.last().locator('.marker-name')).toHaveText('Comment 1');
  await expect(cards.nth(1).locator('.comment-chip')).toHaveText('Comment 1');
  await expect(undo).toHaveAttribute('title', /^Undo Comment on selection \(/);
  // Posting used the selection up: the next comment doesn't pick it up again.
  expect(
    await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.selection.list().length),
  ).toBe(0);
  await cards.nth(1).locator('.comment-text').click();
  expect((await focusStats())?.items).toBe(1);
  await undo.click();
  await expect(cards).toHaveCount(1);
  await expect(markerRows).toHaveCount(markerCount);
  expect(await focusStats()).toEqual({ items: 0, markers: 0, faded: 0 });
  await redo.click();
  await expect(cards).toHaveCount(2);
  await expect(markerRows).toHaveCount(markerCount + 1);
  await clearSelection();

  // Resolve hides the card; "Show resolved" brings it back dimmed; Reopen.
  const footer = section.locator('.comment-show-closed');
  await expect(footer).toBeHidden();
  await card.locator('[data-action="resolve"]').click();
  await expect(cards).toHaveCount(1);
  await expect(footer).toContainText('Show resolved (1)');
  await footer.locator('input').check();
  await expect(cards).toHaveCount(2);
  await expect(card).toHaveClass(/closed/);
  await expect(card.locator('.comment-status')).toHaveText('Resolved');
  await card.locator('[data-action="resolve"]').click(); // now "Reopen"
  await expect(card).not.toHaveClass(/closed/);
  await expect(footer).toBeHidden(); // nothing closed; "Show resolved" stays on (remembered)

  // ⋯ → Won't fix, then Edit (text + markers), then Delete; undo brings it back.
  const menu = page.locator('.context-menu:not([hidden])');
  await card.locator('[data-action="more"]').click();
  await menu.locator('[data-action="status:wontfix"]').click();
  await expect(cards).toHaveCount(2);
  await expect(card.locator('.comment-status')).toHaveText('Won’t fix');
  await card.locator('[data-action="more"]').click();
  await menu.locator('[data-action="edit"]').click();
  await expect(input).toHaveValue('Top face: add a 1 mm chamfer');
  await input.fill('Top face: 2 mm chamfer');
  await composer.locator('.comment-markers-btn').click();
  await menu.locator(`[data-action="attach:${markerId}"]`).click(); // untick
  await expect(composer.locator('.comment-chips-none')).toBeVisible();
  await page.locator('#comment-post').click();
  await expect(card.locator('.comment-text')).toHaveText('Top face: 2 mm chamfer');
  await expect(card.locator('.comment-chip')).toHaveCount(0);
  await card.locator('[data-action="more"]').click();
  await menu.locator('[data-action="delete"]').click();
  await expect(cards).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cards).toHaveCount(2);
  const texts = await page.evaluate(() =>
    (window as HookWindow).__thirdWheelTest?.comments.list().map((c) => c.text),
  );
  expect(texts).toEqual(['Top face: 2 mm chamfer', 'Why is this face so thin?']);

  // With a selection, "+ Comment" comments on it: a pending new marker, made on post;
  // Esc in the writing box cancels only (keeps the selection, no marker).
  await page.evaluate(() => {
    (window as HookWindow).__thirdWheelTest?.selection.addAll([{ kind: 'edge', id: 0 }]);
  });
  const markersBefore = await markerRows.count();
  await section.locator('#comment-add').click();
  await expect(composer.locator('.comment-chip.pending')).toContainText('Comment 2');
  await page.keyboard.press('Escape');
  await expect(composer).toBeHidden();
  await expect(markerRows).toHaveCount(markersBefore);
  expect(
    await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.selection.list().length),
  ).toBe(1);
  await footer.locator('input').uncheck();
  await clearSelection();
});

test('Comment pins: numbered on the marker, fade behind, hide with it, click = card click', async () => {
  const page = await app.firstWindow();
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const section = page.locator('#comments');
  const pins = () =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.pinStats() ?? []);
  const project = (p: [number, number, number]) =>
    page.evaluate((q) => (window as HookWindow).__thirdWheelTest?.viewport.projectToCanvas(q), p);

  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const top = await project([5, 10, 30]);
  if (!top) throw new Error('no projection');

  // A new marker on the top face (Smart fill) + a comment on it → a pin numbered like its card.
  // (Below left of the centre: an earlier comment's pin sits on the centre.)
  await page.locator('#marker-add').click();
  await page.keyboard.press('f');
  await page.mouse.click(box.x + top.x - 12, box.y + top.y + 8);
  await page.keyboard.press('v');
  const markerRow = page.locator('#markers li[data-marker]').last();
  await section.locator('#comment-add').click();
  await section.locator('.comment-box textarea').fill('Pin me');
  await page.keyboard.press('ControlOrMeta+Enter');
  const id = await page.evaluate(
    () => (window as HookWindow).__thirdWheelTest?.comments.list().at(-1)?.id ?? '',
  );
  const card = section.locator(`li[data-comment="${id}"]`);
  const number = Number(((await card.locator('.comment-num').textContent()) ?? '').slice(1));
  await expect.poll(async () => (await pins()).find((p) => p.id === id)?.number).toBe(number);
  let pin = (await pins()).find((p) => p.id === id);
  // Anchored on the top face (z = 30): the pin's tip is where that face's centre projects.
  expect(pin?.behind).toBe(false);
  expect(Math.hypot((pin?.x ?? 0) - top.x, (pin?.y ?? 0) - top.y)).toBeLessThan(40);

  // From below the top face is behind the box: the pin fades but stays.
  await page.keyboard.press('5');
  await page.waitForTimeout(600);
  await expect.poll(async () => (await pins()).find((p) => p.id === id)?.behind).toBe(true);
  await page.keyboard.press('0');
  await page.waitForTimeout(600);

  // Hiding its only marker hides the pin.
  await markerRow.locator('.marker-eye').click();
  await expect.poll(async () => (await pins()).some((p) => p.id === id)).toBe(false);
  await markerRow.locator('.marker-eye').click();
  await expect.poll(async () => (await pins()).some((p) => p.id === id)).toBe(true);

  // Clicking the pin = clicking the card (highlight, again = off); double click edits.
  const pinEl = page.locator(`.comment-pin[data-pin="${id}"]`);
  await pinEl.click();
  await expect(card).toHaveClass(/focused/);
  await expect(pinEl).toHaveClass(/focused/);
  pin = (await pins()).find((p) => p.id === id);
  expect(pin?.focused).toBe(true);
  await pinEl.click();
  await expect(card).not.toHaveClass(/focused/);
  await pinEl.dblclick();
  await expect(card).toHaveClass(/focused/);
  await expect(section.locator('.comment-box')).toBeVisible();
  await page.keyboard.press('Escape');
  await pinEl.click(); // unfocus

  // Resolved → no pin (unless "Show resolved"); deleting the comment removes it too.
  await card.locator('[data-action="resolve"]').click();
  await expect.poll(async () => (await pins()).some((p) => p.id === id)).toBe(false);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(async () => (await pins()).some((p) => p.id === id)).toBe(true);
  await card.locator('[data-action="more"]').click();
  await page.locator('.context-menu:not([hidden]) [data-action="delete"]').click();
  await expect.poll(async () => (await pins()).some((p) => p.id === id)).toBe(false);
  // A marker on the top and the bottom face: after the camera comes to rest the pin sits on the
  // face the camera can see, not faded on the hidden one.
  const pickFace = async (p: [number, number, number]) => {
    const q = await project(p);
    return page.evaluate(
      (pt) => (window as HookWindow).__thirdWheelTest?.viewport.pick(pt.x, pt.y),
      q ?? { x: 0, y: 0 },
    );
  };
  const topFace = await pickFace([5, 10, 30]);
  await page.keyboard.press('5');
  await page.waitForTimeout(600);
  const bottomFace = await pickFace([5, 10, 0]);
  expect(topFace?.kind).toBe('face');
  expect(bottomFace?.kind).toBe('face');
  const two = await page.evaluate(
    (faces) => {
      const t = (window as HookWindow).__thirdWheelTest as unknown as {
        markers: { add(e: { kind: string; id: number }[]): { id: string } };
        comments: { add(text: string, ids: string[]): { id: string } | undefined };
      };
      const marker = t.markers.add(faces.map((id) => ({ kind: 'face', id })));
      return t.comments.add('Top and bottom', [marker.id])?.id ?? '';
    },
    [topFace?.id ?? -1, bottomFace?.id ?? -1],
  );
  const bottom = await project([5, 10, 0]);
  await expect
    .poll(async () => {
      const p = (await pins()).find((q) => q.id === two);
      return p && !p.behind && Math.hypot(p.x - (bottom?.x ?? 0), p.y - (bottom?.y ?? 0)) < 40;
    })
    .toBe(true);
  await page.keyboard.press('0');
  await page.waitForTimeout(600);
  const topIso = await project([5, 10, 30]);
  await expect
    .poll(async () => {
      const p = (await pins()).find((q) => q.id === two);
      return p && !p.behind && Math.hypot(p.x - (topIso?.x ?? 0), p.y - (topIso?.y ?? 0)) < 40;
    })
    .toBe(true);
  await page.evaluate((cid) => {
    (
      (window as HookWindow).__thirdWheelTest as unknown as {
        comments: { remove(id: string): void };
      }
    ).comments.remove(cid);
  }, two);
});
