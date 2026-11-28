/**
 * e2e: notes saved in the project, file dialogs, opening / creating projects.
 */
import { join, relative, dirname, resolve, basename } from 'node:path';
import { hasNotes, mustReadNotes, readProjectOf, readNotes, projectFolderOf } from './notes.js';
import {
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  realpathSync,
  mkdtempSync,
  copyFileSync,
  mkdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  addAsVersion,
  app,
  appDir,
  closeApp,
  dir,
  expect,
  type HookWindow,
  launchApp,
  loadedWindow,
  openStubbed,
  pressAddModel,
  test,
} from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Project: notes saved in .thirdwheel come back on reopen; newer fields kept; changed file → moved over', async () => {
  const page = await app.firstWindow();
  const model = join(dir, 'box.step');
  const twDir = join(dir, '.thirdwheel');
  const snapshot = () =>
    page.evaluate(() => {
      const hook = (window as HookWindow).__thirdWheelTest;
      const paint = hook?.paint();
      const markers = hook?.markers.list() ?? [];
      return {
        markers,
        comments: hook?.comments.list() ?? [],
        paint: markers.map((m) => [paint?.count(m.id), paint?.paintedArea(m.id)]),
        split: paint?.splitCount,
      };
    });
  // A marker with paint cut into pieces (a small brush stamp on the top face) and a comment.
  await page.evaluate(() => {
    type Setup = {
      markers: { add(): { id: string } };
      paint(): {
        paint(
          t: number[],
          id: string,
          locked: Set<string>,
          record: undefined,
          spheres: { center: number[]; radius: number }[],
        ): number;
      };
      comments: { add(text: string, markerIds: string[]): unknown };
      model(): { triangleFace: Uint32Array };
    };
    const hook = (window as unknown as { __thirdWheelTest: Setup }).__thirdWheelTest;
    const m = hook.markers.add();
    const all = [...hook.model().triangleFace.keys()];
    hook.paint().paint(all, m.id, new Set(), undefined, [{ center: [5, 10, 30], radius: 3 }]);
    hook.comments.add('Round this', [m.id]);
  });
  const before = await snapshot();
  expect(before.markers.length).toBeGreaterThan(1);
  expect(before.paint.at(-1)?.[0]).toBeGreaterThan(0);
  expect(before.comments.length).toBeGreaterThan(0);
  expect(before.split).toBeGreaterThan(0);
  await expect.poll(() => hasNotes(model), { timeout: 5000 }).toBe(true);
  expect(existsSync(`${model}.thirdwheel.json`)).toBe(false); // no sidecar any more
  const doc = mustReadNotes(model) as unknown as {
    schemaVersion: number;
    model: { fileName: string; contentHash: string };
    markers: {
      name: string;
      entities: { fingerprint?: { type?: string; point?: number[] } }[];
      paint: { faces: { samples?: number[]; fingerprint?: { type?: string } }[] };
    }[];
    comments: { text: string }[];
    bodies?: { name: string; size: number[] }[];
  };
  expect(doc.schemaVersion).toBe(1);
  expect(doc.model.fileName).toBe('box.step');
  // Fingerprints for revision matching: every body, every held entity.
  expect(doc.bodies?.length).toBeGreaterThan(0);
  expect(doc.bodies?.[0]?.size).toHaveLength(3);
  // Paint points and fingerprints per painted face.
  const painted = doc.markers.flatMap((m) => m.paint.faces);
  expect(painted.length).toBeGreaterThan(0);
  for (const f of painted) {
    expect(f.samples?.length).toBeGreaterThan(0);
    expect(f.fingerprint?.type).toBeTruthy();
  }
  for (const e of doc.markers.flatMap((m) => m.entities)) expect(e.fingerprint).toBeDefined();
  expect(doc.model.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  await expect(page.locator('#save-status')).toHaveText('Saved');
  await expect(page.locator('#save-status')).toHaveAttribute(
    'title',
    /saved to the project ".*" \(\.thirdwheel folder in /,
  );

  // Reopen: the same markers, paint and comments; nothing to undo.
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen());
  expect(await snapshot()).toEqual(before);
  expect(
    await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.history.canUndo()),
  ).toBe(false);
  expect(await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.notice())).toBe(
    undefined,
  );

  // A change not saved yet when the same file is opened again: saved before the sidecar is read.
  await page.evaluate(() => {
    const hook = (
      window as unknown as {
        __thirdWheelTest: { comments: { add(text: string, markerIds: string[]): unknown } };
      }
    ).__thirdWheelTest;
    hook.comments.add('Unsaved yet', []);
  });
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen(false));
  const after = await snapshot();
  expect(after.comments.at(-1)?.text).toBe('Unsaved yet');
  expect(after.paint).toEqual(before.paint);
  const saved = mustReadNotes(model) as unknown as typeof doc;

  // Fields a newer app wrote (project.json and the marks file): kept, no pop-up, no backup.
  const project = readProjectOf(model);
  const versionId = project?.models
    .flatMap((m) => m.versions)
    .find((v) => v.path === 'box.step')?.id;
  if (!project || !versionId) throw new Error('box.step is not in the project');
  const marksFile = join(twDir, 'marks', `${versionId}.json`);
  writeFileSync(
    join(twDir, 'project.json'),
    JSON.stringify({ ...project, futureField: 1 }, null, 2),
  );
  const marks = JSON.parse(readFileSync(marksFile, 'utf8')) as { markers: object[] };
  writeFileSync(
    marksFile,
    JSON.stringify({ ...marks, markers: marks.markers.map((m) => ({ ...m, tag: 'x' })) }),
  );
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen(false));
  await expect(page.locator('#alert-dialog')).toBeHidden();
  expect((await snapshot()).paint).toEqual(before.paint);
  await page.evaluate(() => {
    const hook = (
      window as unknown as {
        __thirdWheelTest: { comments: { add(text: string, markerIds: string[]): unknown } };
      }
    ).__thirdWheelTest;
    hook.comments.add('After newer fields', []);
  });
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  expect(readFileSync(join(twDir, 'project.json'), 'utf8')).toContain('"futureField": 1');
  expect(readFileSync(join(twDir, 'project.json'), 'utf8')).toContain('After newer fields');
  expect(readFileSync(marksFile, 'utf8')).toContain('"tag": "x"');
  expect(readdirSync(twDir).filter((f) => f.endsWith('.bak.json'))).toEqual([]);

  // The file changed since the notes were saved (no mesh hash, as in older files, so not known to be
  // the same geometry): the old contents stay a version with their own marks, the markers are
  // moved onto the model by geometry and saved at once; a notice says so.
  const zero = `sha256:${'0'.repeat(64)}`;
  const now = readProjectOf(model);
  if (!now) throw new Error('no project');
  const real = (
    now.models.flatMap((m) => m.versions).find((v) => v.id === versionId) ?? {
      contentHash: '',
    }
  ).contentHash;
  writeFileSync(
    join(twDir, 'project.json'),
    readFileSync(join(twDir, 'project.json'), 'utf8')
      .replaceAll(real, zero)
      .replace(/\n\s*"meshHash": "sha256:[0-9a-f]+",?/g, ''),
  );
  writeFileSync(
    marksFile,
    readFileSync(marksFile, 'utf8')
      .replaceAll(real, zero)
      .replace(/"meshHash":"sha256:[0-9a-f]+",?/g, ''),
  );
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen());
  await expect(page.locator('#notice-text')).toContainText(
    /box\.step changed on disk: \d+ markers? moved onto the new geometry, all found\. Its earlier geometry isn't kept\.$/,
  );
  await expect(page.locator('#alert-dialog')).toBeHidden();
  // One file name = one version: the same version (marks file) takes the moved paint, no backup.
  expect(readdirSync(join(twDir, 'marks')).filter((f) => f.endsWith('.bak.json'))).toHaveLength(0);
  expect(existsSync(marksFile)).toBe(true);
  const moved = await snapshot();
  expect(moved.markers).toHaveLength(saved.markers.length);
  expect(moved.comments.map((c) => c.text)).toEqual([
    ...saved.comments.map((c) => c.text),
    'After newer fields',
  ]);
  // Paint lands on the same faces (whole triangles: cut pieces become whole ones).
  expect(moved.paint.every(([n]) => (n ?? 0) > 0)).toBe(before.paint.every(([n]) => (n ?? 0) > 0));
  await expect // saved at once with this file's hash; the old contents are not listed
    .poll(() => {
      const doc = readNotes(model);
      return (
        doc !== undefined &&
        doc.model.contentHash !== zero &&
        (doc.versions?.earlier ?? []).length === 0
      );
    })
    .toBe(true);
  // Leave box.step without annotations (and the folder without a project) for the tests after
  // this one: the app reads the project again on the next open. (The link is listed before the
  // moved paint is saved: wait for that save first.)
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  rmSync(twDir, { recursive: true, force: true });
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.reopen());
  expect((await snapshot()).comments).toEqual([]);
});

test('File dialogs: Add file starts in the project folder, Open folder in the OS default', async () => {
  const page = await app.firstWindow();
  await loadedWindow();
  // Stub: remember the options, answer "cancelled" or a file.
  const stub = (answer?: string) =>
    app.evaluate(({ dialog }, p) => {
      const g = globalThis as { dialogOptions?: unknown[] };
      g.dialogOptions = [];
      const record = (...args: unknown[]) => {
        g.dialogOptions?.push(args.at(-1));
        return Promise.resolve(
          p === undefined ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [p] },
        );
      };
      dialog.showOpenDialog = record;
    }, answer);
  const lastDefaultPath = async () => {
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as { dialogOptions?: unknown[] }).dialogOptions?.length),
      )
      .toBe(1);
    return app.evaluate(
      () =>
        ((globalThis as { dialogOptions?: { defaultPath?: string }[] }).dialogOptions?.[0] ?? {})
          .defaultPath ?? null,
    );
  };
  const shown = await page.evaluate(
    () =>
      (
        (window as HookWindow).__thirdWheelTest as unknown as { shownPath(): string | undefined }
      ).shownPath() ?? '',
  );
  expect(shown).not.toBe('');

  // Add file… (Cmd/Ctrl+I) starts in the project's folder (the shown model's folder or above).
  await stub();
  await pressAddModel(page);
  const start = await lastDefaultPath();
  expect(start).not.toBeNull();
  expect(relative(start ?? '', dirname(shown)).startsWith('..')).toBe(false);
  // Open folder… (toolbar): the OS default (usually the last folder used).
  await stub();
  await page.locator('#open-model').click();
  expect(await lastDefaultPath()).toBeNull();
  await loadedWindow();
});

test('Projects: beta notes move in; Open Folder; New project in this folder; another computer → read-only; Save project as', async () => {
  const page = await app.firstWindow();
  // A folder outside the test folder (that one is a project already).
  const folder = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-project-')));
  const bracket = join(folder, 'bracket.step');
  copyFileSync(resolve(appDir, '../../test-models/bracket.step'), bracket);
  const hash = `sha256:${createHash('sha256').update(readFileSync(bracket)).digest('hex')}`;
  // An old (beta) notes file next to it.
  const beta = JSON.stringify({
    schemaVersion: 1,
    model: { fileName: 'bracket.step', format: 'step', contentHash: hash },
    tessellation: { linearDeflection: 0.1, angularDeflection: 0.5 },
    markers: [
      {
        id: 'm1',
        name: 'Hole',
        color: '#e5484d',
        visible: true,
        entities: [{ kind: 'face', id: 0, seq: 1 }],
        paint: { faces: [] },
      },
    ],
    comments: [
      {
        id: 'c1',
        text: 'From the beta',
        markerIds: ['m1'],
        status: 'open',
        author: 'human',
        createdAt: '2026-11-01T10:00:00.000Z',
        updatedAt: '2026-11-01T10:00:00.000Z',
      },
    ],
  });
  writeFileSync(`${bracket}.thirdwheel.json`, beta);
  const pickFile = (p: string) =>
    app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, p);
  const answer = (response: number) =>
    app.evaluate(({ dialog }, r) => {
      dialog.showMessageBox = () => Promise.resolve({ response: r, checkboxChecked: false });
    }, response);
  const click = (id: string) =>
    app.evaluate(({ Menu }, menuId) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(menuId);
      if (!item) throw new Error(`no menu item ${menuId}`);
      (item.click as (this: typeof item) => void).call(item);
    }, id);
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
  const addComment = (text: string) =>
    page.evaluate((t) => {
      (
        (window as HookWindow).__thirdWheelTest as unknown as {
          comments: { add(text: string, ids: string[]): unknown };
        }
      ).comments.add(t, []);
    }, text);

  // 1. Opening the model moves the beta notes into a new project; the old file stays as it was.
  await pickFile(bracket);
  await openStubbed();
  await loadedName('bracket.step');
  await expect(page.locator('#notice-text')).toContainText('Your notes moved into the project');
  expect(await comments()).toEqual(['From the beta']);
  expect(existsSync(join(folder, '.thirdwheel', 'project.json'))).toBe(true);
  expect(readFileSync(`${bracket}.thirdwheel.json`, 'utf8')).toBe(beta);
  await expect(page).toHaveTitle(`${basename(folder)} — bracket.step`);

  // 2. Open Folder… shows the model seen there last.
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  await pickFile(join(dir, 'box.step'));
  await openStubbed();
  await loadedName('box.step');
  await pickFile(folder);
  await click('menu-open-folder');
  await loadedName('bracket.step');
  const recent = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.getMenuItemById('menu-open-recent')?.submenu?.items ?? []).map(
      (i) => i.label,
    ),
  );
  expect(recent[0]).toContain(basename(folder));

  // 3. A model in a subfolder joins the folder's project; New project in this folder… moves it out.
  mkdirSync(join(folder, 'lid'));
  const lid = join(folder, 'lid', 'lid.step');
  copyFileSync(join(dir, 'lid.step'), lid);
  await pickFile(lid);
  await openStubbed();
  await loadedName('lid.step');
  await expect(page).toHaveTitle(`${basename(folder)} — lid.step`);
  await addComment('Lid gap');
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  expect(projectFolderOf(lid)).toBe(folder);
  await answer(0); // "New project"
  await click('menu-make-own-project');
  await expect(page.locator('#notice-text')).toContainText('lid is now its own project');
  await expect(page).toHaveTitle('lid — lid.step');
  expect(projectFolderOf(lid)).toBe(join(folder, 'lid'));
  expect(readProjectOf(lid)?.comments.map((c) => c.text)).toEqual(['Lid gap']);
  expect(readProjectOf(bracket)?.comments.map((c) => c.text)).toEqual(['From the beta']);

  // 4. Another computer holds the lid project (shared folder): "Open read-only" → nothing saved.
  writeFileSync(
    join(folder, 'lid', '.thirdwheel', 'lock'),
    JSON.stringify({ host: 'OTHER-PC', pid: 1, started: '2026-11-22T08:00:00.000Z' }),
  );
  await answer(0); // "Open read-only"
  await pickFile(lid);
  await openStubbed();
  await loadedName('lid.step');
  await expect(page.locator('#notice-text')).toContainText('open on OTHER-PC');
  // Said at once (before any change): status bar with the red dot, and the window title.
  await expect(page.locator('#save-status')).toHaveText('Read-only — not saved');
  await expect(page.locator('#save-status')).toHaveAttribute('data-dot', 'readonly');
  await expect(page).toHaveTitle('lid — lid.step (read-only)');
  await addComment('Only in memory');
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  await expect(page.locator('#save-status')).toHaveText('Read-only — not saved');
  expect(readProjectOf(lid)?.comments.map((c) => c.text)).toEqual(['Lid gap']);

  // 5. Save project as… keeps the changes in a copy elsewhere; it is saved there from now on.
  const copy = join(folder, 'copy');
  mkdirSync(copy);
  await pickFile(copy);
  await click('menu-save-project-as');
  await expect(page.locator('#notice-text')).toContainText(`Project saved to ${copy}`);
  await expect(page).toHaveTitle('copy — lid.step');
  const saved = JSON.parse(readFileSync(join(copy, '.thirdwheel', 'project.json'), 'utf8')) as {
    comments: { text: string }[];
    models: { versions: { path: string }[] }[];
  };
  expect(saved.comments.map((c) => c.text)).toEqual(['Lid gap', 'Only in memory']);
  expect(saved.models[0]?.versions[0]?.path).toBe('../lid/lid.step');
  rmSync(folder, { recursive: true, force: true });
});

test('Projects: New project folder → start page → Add file asks version / part; outside opens its own; Open folder on an empty folder', async () => {
  const page = await app.firstWindow();
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-newproj-')));
  const pickFile = (p: string) =>
    app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, p);
  const click = (id: string) =>
    app.evaluate(({ Menu }, menuId) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(menuId);
      if (!item) throw new Error(`no menu item ${menuId}`);
      (item.click as (this: typeof item) => void).call(item);
    }, id);
  const loadedName = (name: string) =>
    expect(page.locator('#model-info')).toHaveText(
      new RegExp(`^${name.replace(/[.()]/g, '\\$&')} · `),
      { timeout: 60_000 },
    );
  const wheel = join(root, 'wheel');
  mkdirSync(wheel);
  await loadedWindow();

  // 1. New project folder…: made at once; the window starts again on the empty project.
  await pickFile(wheel);
  await click('menu-new-project-folder');
  await expect(page.locator('#empty-add-model')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#empty-title')).toHaveText('wheel');
  await expect(page).toHaveTitle('wheel');
  expect(existsSync(join(wheel, '.thirdwheel', 'project.json'))).toBe(true);
  // The empty project's page: its name and folder, no app icon, no recent list (File ▸ Open
  // Recent has them), "Open another folder…".
  await expect(page.locator('#empty-folder')).toHaveText(wheel);
  await expect(page.locator('.empty-logo')).toBeHidden();
  await expect(page.locator('#empty-recent')).toBeHidden();
  await expect(page.locator('#empty-new-project')).toBeHidden();
  await expect(page.locator('#empty-open')).toHaveText('Open another folder…');

  // 2. Add file… on the empty project: the first model, no question.
  copyFileSync(resolve(appDir, '../../test-models/bracket.step'), join(wheel, 'wheel.step'));
  await pickFile(join(wheel, 'wheel.step'));
  await page.locator('#empty-add-model').click();
  await loadedName('wheel.step');
  await expect(page).toHaveTitle('wheel — wheel.step');

  // 3. Add file… asks; Esc adds nothing; "New version" links it.
  copyFileSync(resolve(appDir, '../../test-models/bracket_v2.step'), join(wheel, 'wheel_v2.step'));
  await pickFile(join(wheel, 'wheel_v2.step'));
  await pressAddModel(page);
  await expect(page.locator('#choice-dialog[open] #choice-title')).toHaveText('Add wheel_v2.step');
  await expect(page.locator('#choice-text')).toContainText('looks like a version of wheel.step');
  await page.keyboard.press('Escape');
  await expect(page.locator('#choice-dialog')).toBeHidden();
  await loadedName('wheel.step');
  await addAsVersion(page);
  await loadedName('wheel_v2.step');

  // 4. "Separate part" with a name that doesn't look like a version: no check, shown as its own.
  copyFileSync(resolve(appDir, '../../test-models/bracket.step'), join(wheel, 'lid.step'));
  await pickFile(join(wheel, 'lid.step'));
  await pressAddModel(page);
  await expect(page.locator('#choice-text')).not.toContainText('looks like a version');
  await page.locator('#choice-second').click();
  await loadedName('lid.step');
  // Listed in the project at once (no marker yet), as a part of its own.
  const parts = () =>
    (
      JSON.parse(readFileSync(join(wheel, '.thirdwheel', 'project.json'), 'utf8')) as {
        models: { versions: { path: string }[] }[];
      }
    ).models.map((m) => m.versions.map((v) => v.path));
  await expect.poll(parts).toContainEqual(['lid.step']);
  expect(parts()).toContainEqual(['wheel.step', 'wheel_v2.step']);
  // Parts ▾ lists both parts (the shown one ticked, each at its newest version) and opens one.
  const partRows = page.locator('.context-menu-item[data-action="part-row"]');
  await page.locator('#parts-menu').click();
  await expect(partRows).toHaveCount(2);
  await expect(partRows.nth(0)).toContainText('wheel_v2.step');
  await expect(partRows.nth(0)).not.toHaveAttribute('aria-checked', 'true');
  await expect(partRows.nth(1)).toContainText('lid.step');
  await expect(partRows.nth(1)).toHaveAttribute('aria-checked', 'true');
  await partRows.nth(0).click();
  await loadedName('wheel_v2.step');
  await page.locator('#parts-menu').click();
  await expect(partRows.nth(0)).toHaveAttribute('aria-checked', 'true');
  await partRows.nth(1).click();
  await loadedName('lid.step');
  // "New version" with such a name checks once more (Cancel = nothing added).
  await pickFile(join(wheel, 'wheel.step'));
  await pressAddModel(page);
  await page.locator('#choice-first').click();
  await expect(page.locator('#choice-title')).toHaveText('Add as a new version?');
  await page.locator('#choice-second').click();
  await loadedName('lid.step');

  // 5. A file outside the project folder: offered as its own project.
  const outside = join(root, 'outside.step');
  copyFileSync(resolve(appDir, '../../test-models/bracket.step'), outside);
  await pickFile(outside);
  await pressAddModel(page);
  await expect(page.locator('#choice-dialog[open] #choice-title')).toHaveText(
    'Outside this project',
  );
  await page.locator('#choice-first').click();
  await loadedName('outside.step');
  await expect(page).toHaveTitle(`${basename(root)} — outside.step`);

  // 6. Open folder… on a folder without models: its project, empty (nothing written).
  const empty = join(root, 'empty');
  mkdirSync(empty);
  await pickFile(empty);
  await click('menu-open-folder');
  await expect(page.locator('#empty-title')).toHaveText('empty', { timeout: 30_000 });
  expect(existsSync(join(empty, '.thirdwheel'))).toBe(false);

  // 7. New project folder… on a folder that already has a project: a box (never a second
  // project); Open it = like Open folder… (the model shown there last).
  const boxes: string[] = [];
  const answerBox = (response: number) =>
    app.evaluate(({ dialog }, r) => {
      const g = globalThis as { __boxes?: string[] };
      g.__boxes = [];
      dialog.showMessageBox = (...args: unknown[]) => {
        const o = args.find((x) => typeof x === 'object' && x && 'message' in x) as {
          message: string;
          detail?: string;
        };
        g.__boxes?.push(`${o.message} | ${o.detail ?? ''}`);
        return Promise.resolve({ response: r, checkboxChecked: false });
      };
    }, response);
  const boxTexts = () => app.evaluate(() => (globalThis as { __boxes?: string[] }).__boxes ?? []);
  await answerBox(0);
  await pickFile(wheel);
  await click('menu-new-project-folder');
  await expect.poll(boxTexts).toHaveLength(1);
  boxes.push(...(await boxTexts()));
  expect(boxes[0]).toMatch(/^wheel already has a project \| "wheel" has 2 models and 0 comments/);
  await loadedName('lid.step');
  // The project shown already: nothing reloads, a notice says so.
  await answerBox(0);
  await click('menu-new-project-folder');
  await expect(page.locator('#notice-text')).toContainText('wheel is already open.');
  expect(await boxTexts()).toEqual([]);
  await loadedName('lid.step');

  // 8. Add file… with no model shown: a part whose name matches asks "New version of …".
  await page.reload(); // the window without a model; main keeps the project (dev only)
  await expect(page.locator('#empty-title')).toBeVisible({ timeout: 30_000 });
  copyFileSync(resolve(appDir, '../../test-models/bracket_v2.step'), join(wheel, 'wheel_v3.step'));
  await pickFile(join(wheel, 'wheel_v3.step'));
  await click('menu-add-model');
  await expect(page.locator('#choice-dialog[open] #choice-title')).toHaveText('Add wheel_v3.step');
  await expect(page.locator('#choice-first')).toHaveText('New version of wheel_v2.step');
  await page.locator('#choice-first').click();
  await loadedName('wheel_v3.step');
  await expect.poll(parts).toContainEqual(['wheel.step', 'wheel_v2.step', 'wheel_v3.step']);

  // Back to the box for the next tests.
  await pickFile(join(dir, 'box.step'));
  await openStubbed();
  await loadedName('box.step');
  rmSync(root, { recursive: true, force: true });
});

test('Comment links: Separate part lists the shown file too; ↔ Part ▾ offers the other parts only; joined parts lose their links', async () => {
  const page = await app.firstWindow();
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-links-')));
  const kit = join(root, 'kit');
  mkdirSync(kit);
  copyFileSync(resolve(appDir, '../../test-models/bracket.step'), join(kit, 'base.step'));
  copyFileSync(resolve(appDir, '../../test-models/bracket_v2.step'), join(kit, 'lid.step'));
  const pickFile = (p: string) =>
    app.evaluate(({ dialog }, f) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [f] });
    }, p);
  const loadedName = (name: string) =>
    expect(page.locator('#model-info')).toHaveText(new RegExp(`^${name.replace('.', '\\.')} · `), {
      timeout: 60_000,
    });
  type Saved = {
    models: unknown[];
    comments: { text: string; linkedModels?: string[]; linkedParts?: string[] }[];
  };
  const projectFile = join(kit, '.thirdwheel', 'project.json');
  const saved = (): Saved =>
    existsSync(projectFile)
      ? (JSON.parse(readFileSync(projectFile, 'utf8')) as Saved)
      : { models: [], comments: [] };
  const composer = page.locator('#comments .comment-box');
  const linkBtn = composer.locator('.comment-link-btn');
  const linkRows = page.locator('.context-menu-item[data-action^="link:"]');
  await loadedWindow();

  // Two parts: base and lid (shown).
  await pickFile(join(kit, 'base.step'));
  await openStubbed();
  await loadedName('base.step');
  // Only looked at: nothing written yet. Adding a separate part lists both.
  expect(existsSync(projectFile)).toBe(false);
  await pickFile(join(kit, 'lid.step'));
  await pressAddModel(page);
  await expect(page.locator('#choice-dialog[open] #choice-title')).toHaveText('Add lid.step');
  await page.locator('#choice-second').click(); // Separate part
  await loadedName('lid.step');
  await expect.poll(() => saved().models.length).toBe(2);

  // The comment box links to the other part (by its newest file), never to its own.
  await page.locator('#comment-add').click();
  await expect(linkBtn).toHaveText('↔ Part ▾');
  await linkBtn.click();
  await expect(linkRows).toHaveCount(1);
  await expect(linkRows.first()).toContainText('base');
  await expect(linkRows.first()).toContainText('base.step');
  await linkRows.first().click();
  await expect(composer.locator('.comment-chip.linked')).toHaveText('↔ base.step');
  await composer.locator('textarea').fill('The lid must fit the base');
  await page.keyboard.press('ControlOrMeta+Enter');
  const card = page.locator('#comments li[data-comment]');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.comment-chip.linked')).toHaveText('↔ base.step');
  await expect
    .poll(() => saved().comments.map((c) => [c.linkedModels, c.linkedParts?.length]))
    .toEqual([[['base.step'], 1]]);

  // base.step becomes a newer version of the lid: one part, the link between them goes.
  await pickFile(join(kit, 'base.step'));
  await addAsVersion(page);
  await loadedName('base.step');
  await expect(page.locator('#notice-text')).toContainText(
    'Removed 1 link between versions of lid.',
  );
  await expect.poll(() => saved().models.length).toBe(1);
  expect(saved().comments.map((c) => [c.text, c.linkedModels, c.linkedParts])).toEqual([
    ['The lid must fit the base', undefined, undefined],
  ]);
  await expect(card).toHaveCount(1);
  await expect(card.locator('.comment-chip.linked')).toHaveCount(0);
  // No other part left: the box has no link button.
  await page.locator('#comment-add').click();
  await expect(composer).toBeVisible();
  await expect(linkBtn).toBeHidden();
  await page.keyboard.press('Escape');

  // Back to the box for the next tests.
  await pickFile(join(dir, 'box.step'));
  await openStubbed();
  await loadedName('box.step');
  rmSync(root, { recursive: true, force: true });
});
