/**
 * e2e: GPU picking (vertex / edge / face), click, filter, box select, double-click; body folders;
 * dimensions in the view; the Info panel.
 */
import { readNotes } from './notes.js';
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  app,
  appDir,
  closeApp,
  dir,
  expect,
  type HookWindow,
  launchApp,
  loadedWindow,
  openStubbed,
  test,
  type TestHook,
} from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('picks a vertex, an edge and a face of the box; a click selects', async () => {
  const page = await loadedWindow();
  // The window is shown on 'ready-to-show' and may still resize: wait until it is visible and
  // the canvas keeps its size for a few frames, so projected positions stay valid for the click.
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
    .toBe(true);
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        const canvas = document.querySelector('#viewport canvas');
        let last = '';
        let stable = 0;
        const step = (): void => {
          const size = `${String(canvas?.clientWidth)}x${String(canvas?.clientHeight)}`;
          stable = size === last ? stable + 1 : 0;
          last = size;
          if (stable >= 5) done();
          else requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      }),
  );

  const picks = await page.evaluate(() => {
    const hook = (window as HookWindow).__thirdWheelTest;
    const model = hook?.model();
    if (!hook || !model) throw new Error('test hook missing');
    const at = (p: [number, number, number]): ReturnType<TestHook['viewport']['pick']> => {
      const s = hook.viewport.projectToCanvas(p);
      return hook.viewport.pick(s.x, s.y);
    };
    const xyz = (a: Float32Array, i: number): [number, number, number] => [
      a[i * 3] ?? 0,
      a[i * 3 + 1] ?? 0,
      a[i * 3 + 2] ?? 0,
    ];

    // Every vertex / edge / face aimed at directly; the visible ones must pick themselves.
    const vertexHits: number[] = [];
    for (let v = 0; v < model.vertexPositions.length / 3; v++) {
      const hit = at(xyz(model.vertexPositions, v));
      if (hit?.kind === 'vertex' && hit.id === v) vertexHits.push(v);
    }
    const edgeHits: number[] = [];
    for (let e = 0; e < model.edgeRanges.length / 2; e++) {
      const first = model.edgeRanges[e * 2] ?? 0;
      const n = model.edgeRanges[e * 2 + 1] ?? 0;
      const a = xyz(model.edgePoints, first);
      const b = xyz(model.edgePoints, first + n - 1);
      const hit = at([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]);
      if (hit?.kind === 'edge' && hit.id === e) edgeHits.push(e);
    }
    const faceHits: number[] = [];
    const faceCount = Math.max(...model.triangleFace) + 1;
    const faceCentres: [number, number, number][] = [];
    for (let f = 0; f < faceCount; f++) {
      let [x, y, z, n] = [0, 0, 0, 0];
      model.triangleFace.forEach((tf, t) => {
        if (tf !== f) return;
        for (let k = 0; k < 3; k++) {
          const p = xyz(model.positions, model.indices[t * 3 + k] ?? 0);
          x += p[0];
          y += p[1];
          z += p[2];
          n++;
        }
      });
      const centre: [number, number, number] = [x / n, y / n, z / n];
      faceCentres.push(centre);
      const hit = at(centre);
      if (hit?.kind === 'face' && hit.id === f) faceHits.push(f);
    }
    const firstFace = faceHits[0];
    const centre = firstFace === undefined ? undefined : faceCentres[firstFace];
    const click =
      firstFace === undefined || !centre
        ? undefined
        : { face: firstFace, ...hook.viewport.projectToCanvas(centre) };
    return { vertexHits, edgeHits, faceHits, click };
  });

  // From a corner view of a box: 7 vertices, 9 edges and 3 faces are visible.
  expect(picks.vertexHits.length).toBeGreaterThanOrEqual(1);
  expect(picks.edgeHits.length).toBeGreaterThanOrEqual(1);
  expect(picks.faceHits.length).toBeGreaterThanOrEqual(1);

  // A real mouse click on a face selects it; clicking it again removes it.
  const click = picks.click;
  expect(click).toBeDefined();
  if (!click) return;
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas box');
  const pickAt = (p: { x: number; y: number }) =>
    page.evaluate((q) => (window as HookWindow).__thirdWheelTest?.viewport.pick(q.x, q.y), p);
  const selectedList = (): Promise<{ kind: string; id: number }[] | undefined> =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.selection.list());
  // This test failed now and then on a selection check after a click. Record what the
  // view received (pointer events, canvas resizes) so a failure says why.
  await page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { __t121: string[] }).__t121 = log;
    const canvas = document.querySelector('#viewport canvas');
    const t0 = performance.now();
    const at = (): string => `${(performance.now() - t0).toFixed(0)}ms`;
    for (const type of ['pointerdown', 'pointerup', 'dblclick'] as const)
      window.addEventListener(
        type,
        (e) => {
          const el = e.target as Element;
          log.push(
            `${at()} ${type} target=${el.tagName.toLowerCase()}#${el.id}.${el.className} ` +
              `xy=${String(e.clientX)},${String(e.clientY)} detail=${String(e.detail)}`,
          );
        },
        { capture: true },
      );
    if (canvas)
      new ResizeObserver(() => {
        log.push(`${at()} canvas ${String(canvas.clientWidth)}x${String(canvas.clientHeight)}`);
      }).observe(canvas);
  });
  const expectSelection = async (want: { kind: string; id: number }[]): Promise<void> => {
    const got = await selectedList();
    const why =
      JSON.stringify(got) === JSON.stringify(want)
        ? ''
        : await page.evaluate(
            (q) =>
              [
                `pick at click point now: ${JSON.stringify((window as HookWindow).__thirdWheelTest?.viewport.pick(q.x, q.y))}`,
                ...(window as unknown as { __t121: string[] }).__t121.slice(-12),
              ].join('\n'),
            click,
          );
    expect(got, `selection after click (pick log):\n${why}`).toEqual(want);
  };
  expect(await pickAt(click), 'pick under the click point just before clicking').toMatchObject({
    kind: 'face',
    id: click.face,
  });
  await canvas.click({ position: { x: click.x, y: click.y } });
  await expectSelection([{ kind: 'face', id: click.face }]);
  await page.waitForTimeout(800); // longer than a double click: two separate clicks
  await canvas.click({ position: { x: click.x, y: click.y } });
  await expectSelection([]);

  // A click on empty space does nothing; a double click there clears.
  const empty = { x: 8, y: box.height - 8 };
  expect(await pickAt(empty), 'canvas corner is empty').toBeUndefined();
  await canvas.click({ position: { x: click.x, y: click.y } });
  await page.waitForTimeout(800);
  await canvas.click({ position: empty });
  await expectSelection([{ kind: 'face', id: click.face }]);
  await page.waitForTimeout(800);
  await canvas.dblclick({ position: empty });
  await expectSelection([]);

  // Double click = the whole body, with the default filter; again = removed.
  await canvas.dblclick({ position: { x: click.x, y: click.y } });
  await expectSelection([{ kind: 'body', id: 0 }]);
  await page.waitForTimeout(800);
  await canvas.dblclick({ position: { x: click.x, y: click.y } });
  await expectSelection([]);

  // Filter: Face off + Body on → the same spot picks the body.
  const filterButton = (name: string) =>
    page.locator('#selection-filter button', { hasText: name });
  await filterButton('Body').click();
  await filterButton('Face').click();
  await expect(filterButton('Face')).toHaveAttribute('aria-pressed', 'false');
  expect(await pickAt(click)).toMatchObject({ kind: 'body', id: 0 });
  await filterButton('Body').click(); // Face and Body off: a face picks nothing
  expect(await pickAt(click)).toBeUndefined();

  // Double click adds the body even with Face and Body off; modifiers change nothing.
  await canvas.dblclick({ position: { x: click.x, y: click.y }, modifiers: ['Shift'] });
  await expectSelection([{ kind: 'body', id: 0 }]);

  // A double click on the view cube never selects, even right after a model click (review fix).
  await page.keyboard.press('Escape');
  await expectSelection([]);
  await filterButton('Face').click(); // back on
  await canvas.click({ position: { x: click.x, y: click.y } });
  await expectSelection([{ kind: 'face', id: click.face }]);
  await canvas.dblclick({ position: { x: box.width - 60, y: 60 } }); // view cube centre
  await expectSelection([{ kind: 'face', id: click.face }]);

  // Box select: in the Select tool (Fusion style) a left drag draws a box.
  // Left→right over the whole view adds exactly the visible faces (back faces never) plus
  // visible edges and vertices. The cube double-click turned the camera: back to Iso first.
  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await page.waitForTimeout(600); // 250 ms camera move
  const seen = await page.evaluate(() => {
    const hook = (window as HookWindow).__thirdWheelTest;
    const model = hook?.model();
    if (!hook || !model) throw new Error('test hook missing');
    const faces: number[] = [];
    let at: { x: number; y: number; face: number } | undefined;
    const faceCount = Math.max(...model.triangleFace) + 1;
    for (let f = 0; f < faceCount; f++) {
      const c = [0, 0, 0];
      let n = 0;
      model.triangleFace.forEach((tf, t) => {
        if (tf !== f) return;
        for (let k = 0; k < 3; k++) {
          const v = model.indices[t * 3 + k] ?? 0;
          for (let a = 0; a < 3; a++) c[a] = (c[a] ?? 0) + (model.positions[v * 3 + a] ?? 0);
          n++;
        }
      });
      const s = hook.viewport.projectToCanvas([(c[0] ?? 0) / n, (c[1] ?? 0) / n, (c[2] ?? 0) / n]);
      const hit = hook.viewport.pick(s.x, s.y);
      if (hit?.kind !== 'face' || hit.id !== f) continue;
      faces.push(f);
      at ??= { ...s, face: f };
    }
    return { faces, at };
  });
  expect(seen.faces.length).toBeGreaterThanOrEqual(2);
  const target = seen.at;
  if (!target) throw new Error('no visible face');
  /** Left drag; `held` keys are down from the press, `atEnd` keys only just before the release. */
  const drag = async (
    from: { x: number; y: number },
    to: { x: number; y: number },
    { held = [], atEnd = [] }: { held?: string[]; atEnd?: string[] } = {},
  ): Promise<void> => {
    for (const m of held) await page.keyboard.down(m);
    await page.mouse.move(box.x + from.x, box.y + from.y);
    await page.mouse.down();
    await page.mouse.move(box.x + (from.x + to.x) / 2, box.y + (from.y + to.y) / 2, { steps: 3 });
    await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 3 });
    for (const m of atEnd) await page.keyboard.down(m);
    await page.mouse.up();
    for (const m of [...atEnd, ...held]) await page.keyboard.up(m);
  };
  const faceIds = (list: { kind: string; id: number }[] | undefined): number[] =>
    (list ?? [])
      .filter((i) => i.kind === 'face')
      .map((i) => i.id)
      .sort((a, b) => a - b);
  const whole = { left: { x: 5, y: box.height - 5 }, right: { x: box.width - 5, y: 5 } };
  await drag(whole.left, whole.right);
  const all = (await selectedList()) ?? [];
  expect(faceIds(all)).toEqual(seen.faces);
  expect(all.some((i) => i.kind === 'edge')).toBe(true);
  expect(all.some((i) => i.kind === 'vertex')).toBe(true);
  // Right→left over the whole view removes everything visible again.
  await drag(whole.right, whole.left);
  await expectSelection([]);

  // A small box inside one face: inside (no Alt) adds nothing; crossing (Alt pressed during the
  // drag) adds just that face; right→left crossing removes it and leaves the rest.
  const small = {
    left: { x: target.x - 3, y: target.y - 3 },
    right: { x: target.x + 3, y: target.y + 3 },
  };
  await drag(small.left, small.right);
  await expectSelection([]);
  await canvas.dblclick({ position: { x: target.x, y: target.y } });
  await expectSelection([{ kind: 'body', id: 0 }]);
  await drag(small.left, small.right, { atEnd: ['Alt'] });
  expect(await selectedList()).toEqual([
    { kind: 'body', id: 0 },
    { kind: 'face', id: target.face },
  ]);
  await drag(small.right, small.left, { atEnd: ['Alt'] });
  await expectSelection([{ kind: 'body', id: 0 }]);

  // Slicer style: Shift + left drag from empty space draws a box instead of panning.
  await page.keyboard.press('Escape');
  await page.locator('#nav-style').selectOption('slicer');
  await drag(whole.left, whole.right, { held: ['Shift'] });
  expect(faceIds(await selectedList())).toEqual(seen.faces);
  expect(await pickAt(target), 'camera did not move').toMatchObject({ id: target.face });
  await page.locator('#nav-style').selectOption('fusion');
});

test('Body folders: move to new folder, rename, saved, drag out, undo, delete', async () => {
  const page = await app.firstWindow();
  const body = page.locator('li[data-row="b0"]');
  const depth = () => body.evaluate((li) => (li as HTMLElement).style.getPropertyValue('--depth'));
  const folder = page.locator('li[data-row="un1"]');

  // Right-click the body → "Move to new folder": the folder starts in rename mode.
  await body.locator('.body-row').click({ button: 'right' });
  await page.locator('[data-action="move-to-new-folder"]').click();
  const input = page.locator('input.folder-name-input');
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Folder 1');
  await input.fill('Brackets');
  await input.press('Enter');
  await expect(folder.locator('.body-name')).toHaveText('Brackets');
  expect(await depth()).toBe('1');

  // Saved in the project and back after reopening.
  await expect
    .poll(() => readNotes(join(dir, 'box.step'))?.bodyTree?.folders[0]?.name ?? false, {
      timeout: 5000,
    })
    .toBe('Brackets');
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen());
  await expect(folder.locator('.body-name')).toHaveText('Brackets');
  expect(await depth()).toBe('1');

  // Drag the body onto empty panel space = top level; undo puts it back.
  const panel = page.locator('.panel-left');
  const box = await panel.boundingBox();
  await body.dragTo(panel, { targetPosition: { x: 40, y: (box?.height ?? 400) - 30 } });
  expect(await depth()).toBe('0');
  await page.locator('#undo').click();
  expect(await depth()).toBe('1');

  // Double-click renames; right-click → Delete folder moves the body out.
  await folder.locator('.folder-row').dblclick();
  await page.locator('input.folder-name-input').fill('Parts');
  await page.locator('input.folder-name-input').press('Enter');
  await expect(folder.locator('.body-name')).toHaveText('Parts');
  await folder.locator('.folder-row').click({ button: 'right' });
  await page.locator('[data-action="delete-folder"]').click();
  await expect(folder).toHaveCount(0);
  expect(await depth()).toBe('0');
  await page.locator('#undo').click();
  await expect(folder.locator('.body-name')).toHaveText('Parts');
  await page.locator('#redo').click();
  await expect(folder).toHaveCount(0);

  // "+ Folder" in the heading: an empty folder at the top level, ready to name; undo removes it.
  await page.locator('[data-action="add-folder"]').click();
  await expect(page.locator('input.folder-name-input')).toBeFocused();
  await page.locator('input.folder-name-input').press('Enter');
  const added = page.locator('li[data-row^="u"]');
  await expect(added.locator('.body-name')).toHaveText('Folder 1');
  await expect(added.locator('.folder-count')).toHaveText('0');
  expect(await depth()).toBe('0');
  await page.locator('#undo').click();
  await expect(added).toHaveCount(0);
  await page.evaluate(() => {
    (window as HookWindow).__thirdWheelTest?.selection.clear();
  });
});

test('Dimensions: 1–2 selected draw one, 3+ none; a highlighted comment draws its own', async () => {
  const page = await loadedWindow();
  const section = page.locator('#comments');
  // Earlier tests may leave comments: ours is found by its text.
  const cards = section.locator('li[data-comment]', { hasText: 'Make this wall 12 mm' });
  const ids = await page.evaluate(() => {
    const m = (window as HookWindow).__thirdWheelTest?.model();
    if (!m) throw new Error('no model');
    const normalX = (f: number): number => m.faceGeometry[f * 8] ?? 0;
    const range = Array.from({ length: m.faceGeometry.length / 8 }, (_, f) => f);
    return {
      left: range.find((f) => normalX(f) < -0.5) ?? -1,
      right: range.find((f) => normalX(f) > 0.5) ?? -1,
      edge30: m.edgeTypes.findIndex(
        (_, e) => Math.abs((m.edgeGeometry[e * 9 + 6] ?? 0) - 30) < 1e-6,
      ),
    };
  });
  const select = (items: { kind: string; id: number }[]): Promise<void> =>
    page.evaluate((list) => {
      const hook = (window as HookWindow).__thirdWheelTest;
      hook?.selection.clear();
      hook?.selection.addAll(list);
    }, items);
  const dims = () =>
    page.evaluate(() => (window as HookWindow).__thirdWheelTest?.viewport.dimensionStats());
  const labels = page.locator('#viewport .dimension-label:not([hidden])');

  await page.keyboard.press('Escape');
  await page.keyboard.press('0');
  await select([{ kind: 'face', id: ids.left }]);
  expect(await dims()).toEqual([]); // a plane has no single size
  await select([{ kind: 'edge', id: ids.edge30 }]);
  await expect(labels).toHaveText(['30 mm']);
  const left = { kind: 'face', id: ids.left };
  const right = { kind: 'face', id: ids.right };
  await select([left, right]);
  await expect(labels).toHaveText(['10 mm']);
  await expect(page.locator('#viewport .dimension-lines line')).toHaveCount(1);
  await page.screenshot({ path: 'test-results/dimension-two-faces.png' });
  await select([left, right, { kind: 'edge', id: ids.edge30 }]);
  expect(await dims()).toEqual([]);

  // Comment on the two faces: drawn while its card is highlighted, gone when it isn't.
  await select([left, right]);
  await section.locator('#comment-add').click();
  await section.locator('.comment-box textarea').fill('Make this wall 12 mm');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(cards).toHaveCount(1);
  expect(await dims()).toEqual([]); // posting cleared the selection
  await cards.first().locator('.comment-text').click();
  await expect(labels).toHaveText(['10 mm']);
  await cards.first().locator('.comment-text').click();
  expect(await dims()).toEqual([]);
  // Selection and highlighted comment on the same pair: drawn once.
  await cards.first().locator('.comment-text').click();
  await select([left, right]);
  await expect(labels).toHaveText(['10 mm']);
  await select([{ kind: 'edge', id: ids.edge30 }]);
  await expect(labels).toHaveText(['30 mm', '10 mm']);
  await cards.first().locator('.comment-text').click();
  await select([]);

  // Leave nothing behind for later tests: the comment and the marker it made.
  const made = await page.evaluate(
    () =>
      (window as HookWindow).__thirdWheelTest?.comments
        .list()
        .find((c) => c.text === 'Make this wall 12 mm')?.markerIds ?? [],
  );
  await cards.first().locator('[data-action="more"]').click();
  await page.locator('.context-menu:not([hidden]) [data-action="delete"]').click();
  await expect(cards).toHaveCount(0);
  await page.evaluate((list) => {
    for (const id of list) (window as HookWindow).__thirdWheelTest?.markers.remove(id);
  }, made);
});

test('Info panel: one face, two opposite faces, an edge; sections collapse', async () => {
  const page = await app.firstWindow();
  const info = page.locator('#info');
  const ids = await page.evaluate(() => {
    const m = (window as HookWindow).__thirdWheelTest?.model();
    if (!m) throw new Error('no model');
    const normalX = (f: number): number => m.faceGeometry[f * 8] ?? 0;
    const faces = m.faceGeometry.length / 8;
    const range = Array.from({ length: faces }, (_, f) => f);
    return {
      left: range.find((f) => normalX(f) < -0.5) ?? -1,
      right: range.find((f) => normalX(f) > 0.5) ?? -1,
      edge30: m.edgeTypes.findIndex(
        (_, e) => Math.abs((m.edgeGeometry[e * 9 + 6] ?? 0) - 30) < 1e-6,
      ),
    };
  });
  const select = (items: { kind: string; id: number }[]): Promise<void> =>
    page.evaluate((list) => {
      const hook = (window as HookWindow).__thirdWheelTest;
      hook?.selection.clear();
      hook?.selection.addAll(list);
    }, items);

  await select([]);
  await expect(info).toContainText('Select something');
  await select([{ kind: 'face', id: ids.left }]);
  await expect(info).toContainText(`Face ${String(ids.left)} · Plane`);
  await expect(info).toContainText('(-1, 0, 0)');
  await expect(info).toContainText('≈ 600 mm²');
  await select([
    { kind: 'face', id: ids.left },
    { kind: 'face', id: ids.right },
  ]);
  await expect(info.locator('.info-block')).toHaveCount(3);
  await expect(info).toContainText('Perpendicular to plane');
  await expect(info).toContainText('10 mm');
  await expect(info).toContainText('0°');
  await select([{ kind: 'edge', id: ids.edge30 }]);
  await expect(info).toContainText('30 mm');
  const exactButton = page.locator('#info-exact');
  await expect(exactButton).toHaveCount(0); // nothing "≈" for an edge

  // Exact values: the kernel was kept (small model), so the ≈ values are replaced.
  await select([
    { kind: 'face', id: ids.left },
    { kind: 'face', id: ids.right },
  ]);
  await expect(info).toContainText('≈');
  await exactButton.click();
  await expect(exactButton).toHaveCount(0);
  await expect(info).not.toContainText('≈');
  await expect(info).toContainText('600 mm²');
  await expect(info).toContainText(/Shortest distance\s*10 mm/);

  // Collapse: content hidden, remembered across a reload; expand again.
  const toggle = info.locator('.section-toggle');
  await toggle.click();
  await expect(info).toHaveClass(/collapsed/);
  await expect(page.locator('#info-body')).toBeHidden();
  await page.reload();
  await expect(page.locator('#info')).toHaveClass(/collapsed/);
  await page.locator('#info .section-toggle').click();
  await expect(page.locator('#info-body')).toBeVisible();
  await expect(page.locator('#markers .section-toggle')).toHaveAttribute('aria-expanded', 'true');
});

test('Fit with the left panel open: orbiting turns the model in place; folding slides it', async () => {
  // Earlier tests may leave the start view up: open the box again.
  const page = await app.firstWindow();
  const box = join(dir, 'box.step');
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
  }, box);
  await openStubbed();
  await expect(page.locator('#model-info')).toHaveText(/^box\.step · /, { timeout: 60_000 });
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.loaded() === true);
  if (await page.locator('#left-panel.folded').count()) await page.locator('#tab-bodies').click();
  await expect(page.locator('#left-panel')).not.toHaveClass(/folded/);

  type Cam = { fitAll(): void; setView(dir: [number, number, number]): void };
  /** Box centre on the canvas, the view's size, the panel's cover, and picks beside the box's right edge. */
  const probe = (): Promise<{
    c: { x: number; y: number };
    edge: { x: number; y: number };
    w: number;
    h: number;
    cover: number;
    inside: string | undefined;
    outside: string | undefined;
  }> =>
    page.evaluate(() => {
      const hook = (window as HookWindow).__thirdWheelTest;
      const model = hook?.model();
      if (!hook || !model) throw new Error('test hook missing');
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      model.positions.forEach((v, i) => {
        lo[i % 3] = Math.min(lo[i % 3] ?? 0, v);
        hi[i % 3] = Math.max(hi[i % 3] ?? 0, v);
      });
      const mid = (a: number): number => ((lo[a] ?? 0) + (hi[a] ?? 0)) / 2;
      const c = hook.viewport.projectToCanvas([mid(0), mid(1), mid(2)]);
      // Front view: the box's right edge at mid height, on its front face (−Y).
      const edge = hook.viewport.projectToCanvas([hi[0] ?? 0, lo[1] ?? 0, mid(2)]);
      const canvas = document.querySelector<HTMLCanvasElement>('#viewport canvas');
      const cover = parseFloat(
        getComputedStyle(document.querySelector('.app') ?? document.body).getPropertyValue(
          '--left-cover',
        ),
      );
      return {
        c,
        edge,
        w: canvas?.clientWidth ?? 0,
        h: canvas?.clientHeight ?? 0,
        cover,
        inside: hook.viewport.pick(edge.x - 20, edge.y)?.kind,
        outside: hook.viewport.pick(edge.x + 20, edge.y)?.kind,
      };
    });
  /** Turn to look along `dir` (keeps the orbit target, like the view cube); `fit` zooms to fit after. */
  const look = async (dir: [number, number, number], fit = false): Promise<void> => {
    await page.evaluate(
      ([d, f]) => {
        const v = (window as HookWindow).__thirdWheelTest?.viewport as unknown as Cam;
        v.setView(d);
        if (f) v.fitAll();
      },
      [dir, fit] as const,
    );
  };
  /**
   * Wait until the box centre sits at (x, y) on the canvas and the picture stopped moving (camera
   * moves are animated; the centre alone stays put while turning around it).
   */
  let p = await probe();
  const settledAt = async (x: () => number, y: () => number): Promise<void> => {
    let last = { x: NaN, y: NaN };
    await expect
      .poll(async () => {
        p = await probe();
        const still = Math.hypot(p.edge.x - last.x, p.edge.y - last.y) < 0.01;
        last = p.edge;
        return still && Math.hypot(p.c.x - x(), p.c.y - y()) < 1.5;
      })
      .toBe(true);
  };
  const free = (): number => p.cover + (p.w - p.cover) / 2;
  const middle = (): number => p.h / 2;

  expect(p.cover).toBeGreaterThan(200);
  // Fit: the box centre in the middle of the free part (right of the panel).
  await look([0, -1, 0], true);
  await settledAt(free, middle);
  // Picking follows the shifted picture: inside the right edge is the box, outside is nothing.
  expect(p.inside).toBe('face');
  expect(p.outside).toBeUndefined();

  // Orbit (view cube / keys keep the target): the box centre stays put.
  await look([1, 0, 0]);
  await settledAt(free, middle);
  await look([Math.SQRT1_2, -Math.SQRT1_2, 0]);
  await settledAt(free, middle);

  // Fold: the picture slides, the box centre goes to the middle of the whole view.
  await page.locator('#left-fold').click();
  await settledAt(() => p.w / 2, middle);
  expect(p.cover).toBe(0);
  await look([0, -1, 0]);
  await settledAt(() => p.w / 2, middle);
  expect(p.inside).toBe('face');
  expect(p.outside).toBeUndefined();
  await page.locator('#tab-bodies').click(); // open again for the tests after this one
});

test('Double click on an edge selects its tangent chain; again removes it', async () => {
  // Earlier tests may leave the start view up: this one opens its own file.
  const page = await app.firstWindow();
  const path = join(dir, 'square-wheel.step');
  copyFileSync(join(appDir, '..', '..', 'test-models', 'square-wheel', 'square-wheel.step'), path);
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
  }, path);
  await openStubbed();
  await expect(page.locator('#model-info')).toHaveText(/^square-wheel\.step · /, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.loaded() === true);
  await page.waitForTimeout(500); // let the canvas settle before projecting positions

  // A fillet edge on screen whose chain has several edges, aimed at its middle point.
  const target = await page.evaluate(() => {
    const h = (window as HookWindow).__thirdWheelTest as TestHook;
    const m = h.model();
    if (!m) return undefined;
    for (let e = 0; e < m.edgeChain.length; e++) {
      const chain = m.edgeChain.reduce<number[]>(
        (out, c, i) => (c === m.edgeChain[e] ? [...out, i] : out),
        [],
      );
      if (chain.length < 3) continue;
      const first = m.edgeRanges[e * 2] ?? 0;
      const n = m.edgeRanges[e * 2 + 1] ?? 0;
      if (n < 2) continue;
      const k = (first + Math.floor(n / 2)) * 3;
      const s = h.viewport.projectToCanvas([
        m.edgePoints[k] ?? 0,
        m.edgePoints[k + 1] ?? 0,
        m.edgePoints[k + 2] ?? 0,
      ]);
      // A dblclick event has whole-pixel coordinates: the edge must win on every pixel around
      // the point, not only at its exact projection (a vertex may sit a pixel away).
      const p = { x: Math.round(s.x), y: Math.round(s.y) };
      const around = [-1, 0, 1].flatMap((dx) =>
        [-1, 0, 1].map((dy) => h.viewport.pick(p.x + dx, p.y + dy)),
      );
      if (around.every((hit) => hit?.kind === 'edge' && hit.id === e))
        return { ...p, edge: e, chain };
    }
    return undefined;
  });
  expect(target, 'a visible edge with a tangent chain').toBeDefined();
  if (!target) return;
  const canvas = page.locator('#viewport canvas').first();
  const selected = () =>
    page.evaluate(() =>
      ((window as HookWindow).__thirdWheelTest as TestHook).selection
        .list()
        .map((i) => `${i.kind}:${String(i.id)}`)
        .sort(),
    );
  await page.keyboard.press('Escape');
  await canvas.dblclick({ position: { x: target.x, y: target.y } });
  await expect.poll(selected).toEqual(target.chain.map((id) => `edge:${String(id)}`).sort());
  await page.waitForTimeout(800); // a second double click, not a triple click
  await canvas.dblclick({ position: { x: target.x, y: target.y } });
  await expect.poll(selected).toEqual([]);

  // Part of the chain already selected: a double click completes it rather than removing.
  await page.evaluate(
    (id) => {
      ((window as HookWindow).__thirdWheelTest as TestHook).selection.addAll([
        { kind: 'edge', id },
      ]);
    },
    target.chain.find((id) => id !== target.edge) ?? target.edge,
  );
  await page.waitForTimeout(800);
  await canvas.dblclick({ position: { x: target.x, y: target.y } });
  await expect.poll(selected).toEqual(target.chain.map((id) => `edge:${String(id)}`).sort());
  await page.screenshot({});
});
