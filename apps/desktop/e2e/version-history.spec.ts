/**
 * e2e: the version list: import, compare, open, remove and add back versions.
 */
import { resolve, join } from 'node:path';
import { mkdirSync, copyFileSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { mustReadNotes, projectFolderOf, readNotes, readProjectOf } from './notes.js';
import {
  addAsVersion,
  app,
  appDir,
  closeApp,
  dir,
  expect,
  type HookWindow,
  launchApp,
  openStubbed,
  reloadFromDisk,
  test,
  versionFolder,
} from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Version history: import, list, compare and open versions (version chain)', async () => {
  const page = await app.firstWindow();
  const revisions = resolve(appDir, '../../packages/geometry/test-data/revisions');
  const folder = join(dir, 'history');
  mkdirSync(folder);
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
  const comments = () =>
    page.evaluate(() =>
      (
        (window as HookWindow).__thirdWheelTest as unknown as {
          comments: { list(): { text: string }[] };
        }
      ).comments
        .list()
        .map((c) => c.text),
    );
  copyFileSync(join(revisions, 'base.step'), join(folder, 'hist.step'));
  await pick('hist.step');
  await openStubbed();
  // Earlier tests leave files with the same body names in this session: a question may come.
  const question = page.locator('#version-dialog');
  await expect
    .poll(
      async () =>
        (await question.isVisible()) ||
        /^hist\.step · /.test(await page.locator('#model-info').innerText()),
      { timeout: 60_000 },
    )
    .toBe(true);
  if (await question.isVisible()) await page.locator('#version-separate').click();
  await loadedName('hist.step');
  await page.evaluate(() => {
    const h = (window as HookWindow).__thirdWheelTest as unknown as {
      markers: { add(e: { kind: string; id: number }[]): { id: string } };
      comments: { add(text: string, ids: string[]): unknown };
    };
    h.comments.add('Keep this', [h.markers.add([{ kind: 'face', id: 0 }]).id]);
  });
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());

  // Cmd/Ctrl+I: Add file… → New version: the notes come over (same path as a moved / changed file).
  copyFileSync(join(revisions, '01-fillet.step'), join(folder, 'hist_v2.step'));
  await pick('hist_v2.step');
  await addAsVersion(page);
  await loadedName('hist_v2.step');
  await expect(page.locator('#notice-text')).toContainText('hist_v2.step');
  expect(await comments()).toEqual(['Keep this']);

  // The list (the version chain): the earlier file under the shown one, ticked.
  const menu = page.locator('#versions-menu');
  await menu.click();
  const rows = page.locator('.context-menu-item[data-action="version-row"]');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('hist.step');
  await expect(page.locator('.context-menu-item[aria-checked="true"]')).toContainText(
    'hist_v2.step',
  );
  // A file with a versioned name but no link is not listed (no folder scan any more).
  await page.keyboard.press('Escape');
  copyFileSync(join(revisions, '05-rib.step'), join(folder, 'hist_v9.step'));
  await menu.click();
  await expect(rows).toHaveCount(1);
  // Compare with the file (read from disk, not the in-memory previous version).
  await rows.first().click();
  await page.locator('[data-action="compare-version"]').click();
  await expect(page.locator('#compare-legend')).toContainText('Comparing with hist.step', {
    timeout: 60_000,
  });
  await expect(page.locator('#compare-key-old')).toHaveText('Only in hist.step');
  await expect(page.locator('#compare-key-new')).toHaveText('Only in hist_v2.step (shown)');
  await expect(menu).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#compare-end').click();
  await expect(page.locator('#compare-legend')).toBeHidden();

  // Open the older version from the list: its own notes, nothing asked; it knows the newer one.
  await menu.click();
  await rows.first().click();
  await page.locator('[data-action="open-version"]').click();
  await loadedName('hist.step');
  await expect(question).toBeHidden();
  expect(await comments()).toEqual(['Keep this']);
  await expect(page.locator('#notice-text')).toContainText("There's a newer version: hist_v2.step");
  await menu.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('hist_v2.step');
  await page.keyboard.press('Escape');

  // Moved away: "not found" + Locate… (content hash checked: a wrong file is refused).
  mkdirSync(join(folder, 'moved'));
  renameSync(join(folder, 'hist_v2.step'), join(folder, 'moved', 'renamed.step'));
  await menu.click();
  await expect(rows.first()).toContainText('not found');
  await rows.first().click();
  await pick('hist_v9.step');
  await page.locator('[data-action="locate-version"]').click();
  await expect(page.locator('#notice-text')).toContainText('its contents are different');
  await menu.click();
  await rows.first().click();
  await pick(join('moved', 'renamed.step'));
  await page.locator('[data-action="locate-version"]').click();
  await expect(page.locator('#notice-text')).toContainText('Found hist_v2.step');
  await menu.click();
  await expect(rows.first()).toContainText('renamed.step');
  await expect(rows.first()).not.toContainText('not found');
  await page.keyboard.press('Escape');

  // Saved over in place (File ▸ Reload from disk with changes): one file name = one version — the same row, the
  // old contents are not listed.
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  copyFileSync(join(revisions, '05-rib.step'), join(folder, 'hist.step'));
  await reloadFromDisk();
  await expect(page.locator('#notice-text')).toContainText('hist.step', { timeout: 60_000 });
  await menu.click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator('.context-menu-item', { hasText: 'earlier contents' })).toHaveCount(0);
  await expect(rows.first()).toContainText('renamed.step'); // newer versions kept
  await page.keyboard.press('Escape');
});

test('Remove a version: unlinked in the notes, left out of guesses; one parent, no circles', async () => {
  const page = await app.firstWindow();
  const revisions = resolve(appDir, '../../packages/geometry/test-data/revisions');
  const folder = join(dir, 'remove-version');
  mkdirSync(folder);
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
  const notes = (name: string): { versions?: Record<string, unknown> } =>
    mustReadNotes(join(folder, name)) as unknown as {
      versions?: Record<string, unknown>;
    };
  const names = (list: unknown): string[] =>
    ((list as { name: string }[] | undefined) ?? []).map((l) => l.name);
  const flush = () => page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  const menu = page.locator('#versions-menu');
  const rows = page.locator('.context-menu-item[data-action="version-row"]');
  const question = page.locator('#version-dialog');
  const choice = page.locator('#choice-dialog');

  // A with a comment; B = a wrong file imported as its new version (highest version number).
  copyFileSync(join(revisions, 'base.step'), join(folder, 'rm.step'));
  await pick('rm.step');
  await openStubbed();
  await expect
    .poll(
      async () =>
        (await question.isVisible()) ||
        /^rm\.step · /.test(await page.locator('#model-info').innerText()),
      { timeout: 60_000 },
    )
    .toBe(true);
  if (await question.isVisible()) await page.locator('#version-separate').click();
  await loadedName('rm.step');
  await page.evaluate(() => {
    const h = (window as HookWindow).__thirdWheelTest as unknown as {
      markers: { add(e: { kind: string; id: number }[]): { id: string } };
      comments: { add(text: string, ids: string[]): unknown };
    };
    h.comments.add('Keep this', [h.markers.add([{ kind: 'face', id: 0 }]).id]);
  });
  await flush();
  copyFileSync(join(revisions, '01-fillet.step'), join(folder, 'rm_v9.step'));
  await pick('rm_v9.step');
  await addAsVersion(page);
  await loadedName('rm_v9.step');
  await flush();

  // Back on A: Remove B (confirm pop-up; the file stays).
  await menu.click();
  await rows.first().click();
  await page.locator('[data-action="open-version"]').click();
  await loadedName('rm.step');
  await menu.click();
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await page.locator('[data-action="remove-version"]').click();
  await expect(choice).toBeVisible();
  await expect(page.locator('#choice-title')).toHaveText('Remove rm_v9.step from the versions?');
  await page.locator('#choice-first').click();
  await expect(page.locator('#notice-text')).toContainText('Removed rm_v9.step');
  await flush();
  await menu.click();
  await expect(rows).toHaveCount(0);
  await expect(
    page.locator('.context-menu-item', { hasText: 'No other versions linked yet' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  expect(notes('rm.step').versions).toBeUndefined();
  expect(Object.keys(notes('rm_v9.step').versions ?? {})).toEqual(['unlinked']);
  expect(existsSync(join(folder, 'rm_v9.step'))).toBe(true);

  // The version guess (by file name) leaves B out: a new file asks about A, not B (higher number).
  copyFileSync(join(revisions, '05-rib.step'), join(folder, 'rm_v10.step'));
  await pick('rm_v10.step');
  await openStubbed();
  await expect(question).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#version-title')).toHaveText(
    'Is rm_v10.step a new version of rm.step?',
  );
  await page.locator('#version-bring').click();
  await loadedName('rm_v10.step');
  await flush();

  // No circle: A is an earlier version of the shown file, so it can't be imported as newer.
  await pick('rm.step');
  await addAsVersion(page);
  await expect(page.locator('#alert-dialog')).toContainText('is an earlier version of rm_v10.step');
  await page.locator('#alert-ok').click();
  await loadedName('rm_v10.step');

  // One parent: importing rm_v10 (parent A) onto B asks; "keep" leaves the link as it was.
  await pick('rm_v9.step');
  await openStubbed();
  await loadedName('rm_v9.step');
  await pick('rm_v10.step');
  await addAsVersion(page);
  await expect(choice).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#choice-title')).toHaveText(
    'Which file is rm_v10.step a newer version of?',
  );
  await page.locator('#choice-second').click();
  await loadedName('rm_v10.step');
  await flush();
  expect(names(notes('rm_v10.step').versions?.earlier)).toEqual(['rm.step']);
  // … and picking B moves it: A's signpost goes, B's "unlinked" mark goes (linked again).
  await pick('rm_v9.step');
  await openStubbed();
  await loadedName('rm_v9.step');
  await pick('rm_v10.step');
  await addAsVersion(page);
  await expect(choice).toBeVisible({ timeout: 60_000 });
  await page.locator('#choice-first').click();
  // rm_v10 has markers of its own, rm_v9 too → whose markers to use (Esc = its own).
  await expect(page.locator('#choice-dialog[open] #choice-title')).toHaveText(
    'Which markers should rm_v10.step use?',
  );
  await page.keyboard.press('Escape');
  await loadedName('rm_v10.step');
  await expect(page.locator('#notice-text')).toContainText('rm_v10.step uses its own markers');
  await flush();
  expect(names(notes('rm_v10.step').versions?.earlier)).toEqual(['rm_v9.step']);
  expect(names(notes('rm.step').versions?.newer)).toEqual([]);
  expect(notes('rm_v9.step').versions?.unlinked).toBeUndefined();
  expect(names(notes('rm_v9.step').versions?.newer)).toEqual(['rm_v10.step']);
  await menu.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('rm_v9.step');
  await page.keyboard.press('Escape');
});

test("Removed version: gone from every version's list at once, also when its file was moved", async () => {
  const { page, folder, notes, open, importNew, flush, copy } =
    await versionFolder('removed-moved');
  const names = (list: { name: string }[] | undefined) => (list ?? []).map((l) => l.name);
  const menu = page.locator('#versions-menu');
  const rows = page.locator('.context-menu-item[data-action="version-row"]');
  copy('base.step', 'ch.step');
  await open('ch.step');
  copy('01-fillet.step', 'ch_v2.step');
  await importNew('ch_v2.step');
  copy('05-rib.step', 'ch_v3.step');
  await importNew('ch_v3.step');
  expect(names(notes('ch_v3.step').versions?.earlier)[0]).toBe('ch_v2.step');
  // B is moved away; from A, all versions of the part are listed (C through B too).
  mkdirSync(join(folder, 'elsewhere'));
  renameSync(join(folder, 'ch_v2.step'), join(folder, 'elsewhere', 'ch_v2.step'));
  await open('ch.step');
  await menu.click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('ch_v3.step');
  const b = rows.filter({ hasText: 'ch_v2.step' });
  await expect(b).toContainText('not found');
  await b.click();
  await page.locator('[data-action="remove-version"]').click();
  await page.locator('#choice-first').click();
  await expect(page.locator('#notice-text')).toContainText(
    'Removed ch_v2.step from the versions of ch.step',
  );
  await flush();
  // C is made from A now, seen from C as well (one list for the part).
  expect(names(notes('ch_v3.step').versions?.earlier)).toEqual(['ch.step']);
  await open('ch_v3.step');
  await menu.click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('ch.step');
  await page.keyboard.press('Escape');
});

test('Remove a version, add it back, remove it again: one list, comments kept once', async () => {
  const { page, folder, notes, open, importNew, flush, copy, comment, pick, loadedName } =
    await versionFolder('remove-add-back');
  const names = (list: { name: string }[] | undefined) => (list ?? []).map((l) => l.name);
  const texts = (file: string) => (notes(file).comments ?? []).map((c) => c.text);
  const menu = page.locator('#versions-menu');
  const rows = page.locator('.context-menu-item[data-action="version-row"]');
  const listed = async () => {
    await menu.click();
    const shown = await page.locator('.context-menu-item[aria-checked="true"]').innerText();
    const others = await rows.allInnerTexts();
    await page.keyboard.press('Escape');
    return { shown: shown.split('\n')[0], others: others.map((t) => t.split('\n')[0]) };
  };
  /** This folder's parts in the project (it may be a subfolder of a bigger one), file names only. */
  const project = () => {
    const all = JSON.parse(
      readFileSync(
        join(projectFolderOf(join(folder, 'ab.step')) ?? '', '.thirdwheel', 'project.json'),
        'utf8',
      ),
    ) as { models: { versions: { path: string; unlinked?: string }[] }[] };
    const mine = all.models.filter((m) =>
      m.versions.some((v) => /(^|\/)ab(_v\d)?\.step$/.test(v.path)),
    );
    return {
      models: mine.map((m) => ({
        versions: m.versions.map((v) => ({ ...v, path: v.path.split('/').at(-1) ?? '' })),
      })),
    };
  };
  copy('base.step', 'ab.step');
  await open('ab.step');
  await comment('Keep this');
  await flush();
  copy('01-fillet.step', 'ab_v2.step');
  await importNew('ab_v2.step');
  copy('05-rib.step', 'ab_v3.step');
  await importNew('ab_v3.step');
  expect(await listed()).toEqual({ shown: 'ab_v3.step', others: ['ab_v2.step', 'ab.step'] });

  // Remove the middle one: v3 is made from v1 now, v2 is a part of its own with the mark.
  await menu.click();
  await rows.filter({ hasText: 'ab_v2.step' }).click();
  await page.locator('[data-action="remove-version"]').click();
  await page.locator('#choice-first').click();
  await expect(page.locator('#notice-text')).toContainText('Removed ab_v2.step');
  await flush();
  expect(await listed()).toEqual({ shown: 'ab_v3.step', others: ['ab.step'] });
  expect(names(notes('ab_v3.step').versions?.earlier)).toEqual(['ab.step']);
  expect(project().models.map((m) => m.versions.map((v) => v.path))).toEqual([
    ['ab.step', 'ab_v3.step'],
    ['ab_v2.step'],
  ]);
  expect(project().models[1]?.versions[0]?.unlinked).toBeDefined();
  // The window's next save doesn't put the old link back.
  await comment('After remove');
  await flush();
  expect(names(notes('ab_v3.step').versions?.earlier)).toEqual(['ab.step']);
  expect(project().models).toHaveLength(2);

  // Add it back: toolbar Add file → ab_v2 → New version of … (it has paint of its own: keep).
  await pick('ab_v2.step');
  await addAsVersion(page, 'button');
  const choice = page.locator('#choice-dialog[open]');
  await expect
    .poll(
      async () =>
        (await choice.isVisible()) ||
        /^ab_v2\.step · /.test(await page.locator('#model-info').innerText()),
      { timeout: 60_000 },
    )
    .toBe(true);
  if (await choice.isVisible()) await page.keyboard.press('Escape');
  await loadedName('ab_v2.step');
  await flush();
  expect(await listed()).toEqual({ shown: 'ab_v2.step', others: ['ab_v3.step', 'ab.step'] });
  expect(project().models).toHaveLength(1);
  expect(project().models[0]?.versions.every((v) => v.unlinked === undefined)).toBe(true);
  expect(texts('ab_v2.step').sort()).toEqual(['After remove', 'Keep this']);
  expect(texts('ab.step').sort()).toEqual(['After remove', 'Keep this']);
  // The window shows them at once (not only after reopening the file).
  const shownTexts = await page.evaluate(() =>
    (
      (window as HookWindow).__thirdWheelTest as unknown as {
        comments: { list(): { text: string }[] };
      }
    ).comments
      .list()
      .map((c) => c.text),
  );
  expect(shownTexts.sort()).toEqual(['After remove', 'Keep this']);

  // … and removed again, from another version's menu.
  await open('ab.step');
  await menu.click();
  await rows.filter({ hasText: 'ab_v2.step' }).click();
  await page.locator('[data-action="remove-version"]').click();
  await page.locator('#choice-first').click();
  await expect(page.locator('#notice-text')).toContainText('Removed ab_v2.step');
  await flush();
  expect(await listed()).toEqual({ shown: 'ab.step', others: ['ab_v3.step'] });
  expect(project().models).toHaveLength(2);
  expect(texts('ab.step').sort()).toEqual(['After remove', 'Keep this']);
});

test('A "new version" that looks like another part asks: Separate part takes it out, New version keeps it', async () => {
  const { page, folder, pick, loadedName, flush, open, comment, copy } =
    await versionFolder('different-part');
  const wheels = resolve(appDir, '../../test-models/square-wheel');
  const choice = page.locator('#choice-dialog[open]');
  const shownComments = () =>
    page.evaluate(
      () =>
        (
          (window as HookWindow).__thirdWheelTest as unknown as {
            comments: { list(): unknown[] };
          }
        ).comments.list().length,
    );
  copy('base.step', 'part.step');
  await open('part.step');
  await comment('Make this wall thicker');
  await flush();

  // Separate part: out of the versions again, open on its own, nothing moved saved.
  copyFileSync(join(wheels, 'square-wheel.step'), join(folder, 'wheel.step'));
  await pick('wheel.step');
  await addAsVersion(page); // names differ: also "Add as new version"
  await expect(choice.locator('#choice-title')).toHaveText('The files look very different', {
    timeout: 60_000,
  });
  await expect(choice.locator('#choice-text')).toContainText(
    'Is wheel.step really a new version of part.step? Size ',
  );
  await page.locator('#choice-second').click();
  await expect(page.locator('#notice-text')).toContainText(
    'wheel.step is a separate part now, without the markers of part.step.',
    { timeout: 60_000 },
  );
  await loadedName('wheel.step');
  await flush();
  expect(await shownComments()).toBe(0);
  const parts = readProjectOf(join(folder, 'part.step'))?.models ?? [];
  expect(parts.map((m) => m.versions.length)).toEqual([1, 1]);
  expect(readNotes(join(folder, 'wheel.step'))?.markers ?? []).toHaveLength(0);
  expect(mustReadNotes(join(folder, 'part.step')).comments).toHaveLength(1);

  // New version: kept as asked, the moved marker and the comment saved with it.
  await open('part.step');
  copyFileSync(join(wheels, 'square-wheel_v2.step'), join(folder, 'part_v2.step'));
  await pick('part_v2.step');
  await addAsVersion(page);
  await expect(choice.locator('#choice-title')).toHaveText('The files look very different', {
    timeout: 60_000,
  });
  await page.locator('#choice-first').click();
  await loadedName('part_v2.step');
  await flush();
  const v2 = mustReadNotes(join(folder, 'part_v2.step'));
  expect(v2.markers).toHaveLength(1);
  expect(v2.comments).toHaveLength(1);
  expect(v2.versions?.earlier?.map((v) => v.name)).toEqual(['part.step']);
});
