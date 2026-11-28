/**
 * e2e: a new version of a model: Reload from disk, new file names, importing onto files with notes.
 */
import { resolve, join, basename } from 'node:path';
import {
  copyFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  realpathSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
} from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mustReadNotes, readNotes, readProjectOf, hasNotes, projectFolderOf } from './notes.js';
import { tmpdir } from 'node:os';
import {
  addAsVersion,
  app,
  appDir,
  bridgeFile,
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

test('Revision: Reload from disk carries same geometry over, moves changed; load_model revisionOf', async () => {
  const page = await app.firstWindow();
  const revisions = resolve(appDir, '../../packages/geometry/test-data/revisions');
  const bracket = join(dir, 'bracket.step');
  copyFileSync(join(revisions, 'base.step'), bracket);
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
  type Loaded = {
    modelId: string;
    name: string;
    comments: { open: number };
    revision?: { of: string; annotations: string; markers: number; comments: number };
  };
  const load = async (args: Record<string, unknown>) => {
    const r = (await client.callTool({ name: 'load_model', arguments: args })) as {
      content: { text?: string }[];
      isError?: boolean;
    };
    return { isError: r.isError, text: r.content.at(-1)?.text ?? '' };
  };
  const loadJson = async (args: Record<string, unknown>): Promise<Loaded> =>
    JSON.parse((await load(args)).text) as Loaded;
  const hook = () =>
    page.evaluate(() => {
      const t = (window as HookWindow).__thirdWheelTest as unknown as {
        markers: { list(): { id: string; entities: unknown[] }[] };
        comments: { list(): { text: string }[] };
        previousVersion(): Record<string, unknown> | undefined;
      };
      return {
        markers: t.markers.list().map((m) => m.entities.length),
        comments: t.comments.list().map((c) => c.text),
        previous: t.previousVersion(),
      };
    });
  const addComment = (text: string, faces = [0]) =>
    page.evaluate(
      ([t, ids]) => {
        const h = (window as HookWindow).__thirdWheelTest as unknown as {
          markers: { add(e: { kind: string; id: number }[]): { id: string } };
          comments: { add(text: string, ids: string[]): unknown };
        };
        h.comments.add(t, [h.markers.add(ids.map((id) => ({ kind: 'face', id }))).id]);
      },
      [text, faces] as const,
    );
  const flush = () => page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  const backups = (): string[] => {
    const marks = join(dir, '.thirdwheel', 'marks');
    return existsSync(marks) ? readdirSync(marks).filter((f) => f.endsWith('.bak.json')) : [];
  };
  try {
    const first = await loadJson({ path: bracket });
    expect(first.revision).toBeUndefined();
    await addComment('Thicker here');
    await flush();
    const saved = mustReadNotes(bracket);
    expect(saved.model.meshHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    const before = await hook();

    // Unchanged file: Reload says so and keeps everything.
    await reloadFromDisk();
    await expect(page.locator('#notice-text')).toHaveText("bracket.step hasn't changed on disk.");

    // Re-export with the same geometry (only ids inside the file differ): carried over exactly.
    copyFileSync(join(revisions, '00-unchanged.step'), bracket);
    await reloadFromDisk();
    await expect(page.locator('#notice-text')).toContainText(
      'bracket.step changed on disk, but its geometry is the same',
    );
    const carried = await hook();
    expect(carried.markers).toEqual(before.markers);
    expect(carried.comments).toEqual(['Thicker here']);
    expect(carried.previous).toMatchObject({ carried: true, comments: 1, inMemory: true });
    // Saved at once with the new file's hash; nothing lost, so no backup copy.
    await expect
      .poll(() => readNotes(bracket)?.model.contentHash !== saved.model.contentHash)
      .toBe(true);
    expect(backups()).toEqual([]);
    await expect(page.locator('#notice-text')).toContainText('carried over');
    // Same geometry: nothing to compare with the previous version.
    await page.locator('#versions-menu').click();
    // Adding a version is the toolbar's Add file (it asks), not a Versions ▾ item.
    await expect(
      page.locator('.context-menu-item', { hasText: 'Add a version with Add file' }),
    ).toBeVisible();
    await expect(page.locator('.context-menu-item', { hasText: 'Add new version' })).toHaveCount(0);
    await expect(page.locator('[data-action="compare-previous"]')).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Changed geometry (File ▸ Reload from disk): the bracket moved and got a rib. The transfer moves the
    // annotations over (the face is found on the moved body) and saves; one file name = one
    // version, so the same version takes the new contents (no backup: the paint moved).
    copyFileSync(join(revisions, '07-moved.step'), bracket);
    await reloadFromDisk();
    await expect(page.locator('#notice-text')).toContainText(
      /bracket\.step changed on disk: \d+ markers? moved onto the new geometry, all found\. Its earlier geometry isn't kept\.$/,
    );
    await expect(page.locator('#alert-dialog')).toBeHidden();
    const moved = await hook();
    expect(moved.comments).toEqual(['Thicker here']);
    expect(moved.markers).toEqual(before.markers);
    expect(moved.previous).toMatchObject({ carried: false, comments: 1, inMemory: true });
    expect(backups()).toHaveLength(0);
    await flush();
    expect(
      (readProjectOf(bracket)?.models ?? [])
        .flatMap((m) => m.versions)
        .filter((v) => basename(v.path) === 'bracket.step'),
    ).toHaveLength(1);
    await expect(page.locator('.marker-transfer')).toHaveCount(0);
    // Compare with the previous version (its mesh is still in memory).
    const revisionStats = () =>
      page.evaluate(() =>
        (
          (window as HookWindow).__thirdWheelTest as unknown as {
            viewport: { revisionStats(): { ghosts: number; comparing: boolean } };
          }
        ).viewport.revisionStats(),
      );
    const compare = page.locator('#versions-menu');
    await compare.click();
    await page.locator('[data-action="compare-previous"]').click();
    await expect(compare).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#compare-legend')).toContainText(
      'Comparing with bracket.step before reload',
    );
    await expect(page.locator('#compare-key-old')).toHaveText('Previous version');
    expect((await revisionStats()).comparing).toBe(true);
    await page.locator('#compare-end').click();
    await expect(page.locator('#compare-legend')).toBeHidden();
    expect(await revisionStats()).toEqual({ ghosts: 0, comparing: false });

    // load_model with another file name: revisionOf names the previous version.
    // Most of the bracket's faces (with the off-centre hole): enough to tell a mirror from a turn.
    await addComment(
      'On the moved part',
      Array.from({ length: 14 }, (_, i) => i),
    );
    await flush();
    const shown = await loadJson({ path: bracket });
    expect(shown.revision).toBeUndefined(); // its own sidecar fits: a plain reopen
    // A mirrored bracket: its markers are not moved ("? Check"), comments kept.
    copyFileSync(join(revisions, '09-mirrored.step'), join(dir, 'bracket-v2.step'));
    const v2 = await loadJson({ path: 'bracket-v2.step', revisionOf: shown.modelId });
    expect(v2.revision).toMatchObject({ of: 'bracket.step', annotations: 'moved', comments: 2 });
    const sum = (v2.revision as { transfer?: { check: number; flagged: { status: string }[] } })
      .transfer;
    expect(sum?.check).toBeGreaterThan(0);
    expect(sum?.flagged.map((f) => f.status)).toContain('check');
    expect(v2.comments.open).toBe(2);
    await expect(page.locator('#notice-text')).toContainText(
      /bracket-v2\.step is a new version of bracket\.step: \d+ markers moved over — .* to check \(mirrored\)\. Look for ⚠ in Markers\./,
    );
    const badges = page.locator('.marker-transfer.check');
    const flagged = await badges.count();
    expect(flagged).toBe(sum?.check);
    await expect(badges.first()).toHaveAttribute('title', /mirrored.*bracket\.step/);
    // "? Check" markers are drawn as ghosts at their old place until "Looks right".
    expect((await revisionStats()).ghosts).toBe(flagged);
    // "✓ Place here" paints / holds the ghost where it is drawn; undo takes it back.
    const checkRow = page
      .locator('.marker-row', { has: page.locator('.marker-transfer.check') })
      .first();
    const checkId = await checkRow.getAttribute('data-marker');
    const painted = (id: string | null) =>
      page.evaluate(
        (m) =>
          (
            (window as HookWindow).__thirdWheelTest as unknown as {
              paint(): { count(id: string): number } | undefined;
            }
          )
            .paint()
            ?.count(m ?? '') ?? 0,
        id,
      );
    const held = (id: string | null) =>
      page.evaluate(
        (m) =>
          (
            (window as HookWindow).__thirdWheelTest as unknown as {
              markers: { get(id: string): { entities: unknown[] } | undefined };
            }
          ).markers.get(m ?? '')?.entities.length ?? 0,
        id,
      );
    const paintBefore = await painted(checkId);
    const heldBefore = await held(checkId);
    const checkBadge = checkRow.locator('.marker-transfer');
    await checkBadge.hover();
    await expect(checkBadge).toContainText('✓ Place here');
    await expect(checkRow.locator('.transfer-drop')).toBeVisible();
    await checkBadge.click();
    await expect(badges).toHaveCount(flagged - 1);
    expect((await revisionStats()).ghosts).toBe(flagged - 1);
    expect((await painted(checkId)) + (await held(checkId))).toBeGreaterThan(
      paintBefore + heldBefore,
    );
    await page.keyboard.press('ControlOrMeta+z');
    await expect(badges).toHaveCount(flagged);
    expect(await painted(checkId)).toBe(paintBefore);
    expect(await held(checkId)).toBe(heldBefore);
    // "✕ Drop" removes the unplaced part instead; undo brings it back.
    await checkRow.hover();
    await checkRow.locator('.transfer-drop').click();
    await expect(badges).toHaveCount(flagged - 1);
    expect(await painted(checkId)).toBe(paintBefore);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(badges).toHaveCount(flagged);
    expect(hasNotes(bracket)).toBe(true); // the previous version's notes are left alone
    // Same contents under another name (same modelId, so this goes last).
    copyFileSync(bracket, join(dir, 'bracket-copy.step'));
    const same = await loadJson({ path: 'bracket-copy.step', revisionOf: shown.modelId });
    expect(same.revision).toMatchObject({
      of: 'bracket.step',
      annotations: 'carried',
      comments: 2,
    });
    expect(same.comments.open).toBe(2);
    // A file with its own old notes file (an older app) for an older version of itself, loaded
    // with revisionOf: its notes move into the project (as those older contents), so it is a
    // version saved over → refused, nothing loaded; the error names a free path in the project.
    const v3 = join(dir, 'bracket-v3.step');
    copyFileSync(join(revisions, 'base.step'), v3);
    const backupsBefore = backups().length;
    const own = mustReadNotes(bracket);
    writeFileSync(
      `${v3}.thirdwheel.json`,
      JSON.stringify({
        ...own,
        model: {
          ...own.model,
          fileName: 'bracket-v3.step',
          contentHash: `sha256:${'0'.repeat(64)}`,
        },
        versions: undefined,
      }),
    );
    const refused = await load({ path: v3, revisionOf: shown.modelId });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain(
      'bracket-v3.step is already a version in the project with other contents',
    );
    expect(refused.text).toContain(`save it as ${join(dir, 'bracket-v4.step')}`);
    expect(refused.text).toContain("don't try again: tell the user");
    expect((await hook()).comments).toHaveLength(2); // bracket-copy.step still shown
    expect(backups()).toHaveLength(backupsBefore); // nothing moved aside
    // The AI saves it where the error says: loaded, its notes moved over.
    copyFileSync(v3, join(dir, 'bracket-v4.step'));
    const v4 = (await loadJson({
      path: 'bracket-v4.step',
      revisionOf: shown.modelId,
    })) as Loaded & {
      project?: { folder: string };
      saveNextAs?: string;
    };
    expect(v4.revision).toMatchObject({ of: 'bracket-copy.step', annotations: 'moved' });
    expect(v4.project?.folder).toBe(dir);
    expect(v4.saveNextAs).toBe(join(dir, 'bracket-v5.step'));
    const unknown = await load({ path: 'bracket-v2.step', revisionOf: 'ffffffffffff' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toMatch(/revisionOf: no model ffffffffffff/);
    // A versioned name without revisionOf → hint naming the latest earlier version.
    copyFileSync(join(revisions, '01-fillet.step'), join(dir, 'bracket-v5.step'));
    const hinted = (await loadJson({ path: 'bracket-v5.step' })) as Loaded & { hint?: string };
    expect(hinted.revision).toBeUndefined();
    expect(hinted.hint).toMatch(/new version of bracket-v4\.step .*revisionOf: "[0-9a-f]{12}"/);
    // Outside the project folder: refused with or without revisionOf; nothing loaded there.
    const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), 'tw-elsewhere-')));
    try {
      copyFileSync(join(revisions, '03-thicker-wall.step'), join(elsewhere, 'bracket-v6.step'));
      for (const args of [
        { path: join(elsewhere, 'bracket-v6.step'), revisionOf: hinted.modelId },
        { path: join(elsewhere, 'bracket-v6.step') },
      ]) {
        const out = await load(args);
        expect(out.isError).toBe(true);
        expect(out.text).toContain(`outside the project folder ${dir}`);
        expect(out.text).toContain(`Save or copy it as ${join(dir, 'bracket-v6.step')}`);
      }
      expect(existsSync(join(elsewhere, '.thirdwheel'))).toBe(false);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
    // Saved over in place (same path, new contents) without revisionOf: the same version (as
    // Reload), its paint moved; a hint names the next free name.
    copyFileSync(join(revisions, '02-hole-bigger.step'), join(dir, 'bracket-v2.step'));
    const over = (await loadJson({ path: 'bracket-v2.step' })) as Loaded & { hint?: string };
    expect(over.revision).toMatchObject({ of: 'bracket-v2.step' });
    expect(over.hint).toContain('changed on disk since it was listed');
    expect(over.hint).toContain(join(dir, 'bracket-v6.step'));
    // …and with revisionOf (a new version under a used name): refused.
    copyFileSync(join(revisions, '04-longer.step'), join(dir, 'bracket-v2.step'));
    const reused = await load({ path: 'bracket-v2.step', revisionOf: hinted.modelId });
    expect(reused.isError).toBe(true);
    expect(reused.text).toContain(`save it as ${join(dir, 'bracket-v6.step')}`);
    // Another part named as the new version: the AI is never asked; loaded and moved anyway,
    // and told why it looks like another part (the user too, in the notice).
    copyFileSync(
      resolve(appDir, '../../test-models/square-wheel/square-wheel.step'),
      join(dir, 'bracket-v6.step'),
    );
    const other = (await loadJson({
      path: 'bracket-v6.step',
      revisionOf: over.modelId,
    })) as Loaded & {
      revision?: { transfer?: { looksDifferent?: string } };
    };
    expect(other.revision).toMatchObject({ of: 'bracket-v2.step', annotations: 'moved' });
    expect(other.revision?.transfer?.looksDifferent).toMatch(/size .+ mm → .+ mm/);
    await expect(page.locator('#notice-text')).toContainText('The files look very different (');
    await expect(page.locator('#choice-dialog[open]')).toHaveCount(0);
  } finally {
    await client.close();
  }
});

test('Versions under new names: Open asks to bring notes from the earlier version', async () => {
  const page = await app.firstWindow();
  const revisions = resolve(appDir, '../../packages/geometry/test-data/revisions');
  const folder = join(dir, 'versions');
  mkdirSync(folder);
  const open = async (name: string): Promise<void> => {
    const path = join(folder, name);
    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
    }, path);
    await openStubbed();
  };
  // "widget.step · 2 bodies · …" once shown ("Loading widget.step…" before).
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
  const question = page.locator('#version-dialog');
  copyFileSync(join(revisions, 'base.step'), join(folder, 'widget.step'));
  await open('widget.step');
  // After the Revision test this session holds bracket files with the same body names (Bracket,
  // Pin): then it asks about those (a renamed file); run alone, nothing fits and it is silent.
  const info = page.locator('#model-info');
  await expect
    .poll(
      async () => (await question.isVisible()) || /^widget\.step · /.test(await info.innerText()),
      {
        timeout: 60_000,
      },
    )
    .toBe(true);
  if (await question.isVisible()) {
    await expect(page.locator('#version-title')).toHaveText(
      /^Is widget\.step a new version of bracket/,
    );
    await page.locator('#version-separate').click();
  }
  await loadedName('widget.step');
  await expect(question).toBeHidden();
  await page.evaluate(() => {
    const h = (window as HookWindow).__thirdWheelTest as unknown as {
      markers: { add(e: { kind: string; id: number }[]): { id: string } };
      comments: { add(text: string, ids: string[]): unknown };
    };
    h.comments.add('Round this', [h.markers.add([{ kind: 'face', id: 0 }]).id]);
  });
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  const v1Sidecar = JSON.stringify(mustReadNotes(join(folder, 'widget.step')));

  // A versioned name next to it, opened by the user: asked, "Bring my notes over" moves them.
  copyFileSync(join(revisions, '01-fillet.step'), join(folder, 'widget_v2.step'));
  await open('widget_v2.step');
  await expect(question).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#version-title')).toHaveText(
    'Is widget_v2.step a new version of widget.step?',
  );
  await expect(page.locator('#version-text')).toContainText('2 markers and 1 comment');
  await page.locator('#version-bring').click();
  await loadedName('widget_v2.step');
  await expect(page.locator('#notice-text')).toContainText(
    'widget_v2.step is a new version of widget.step',
  );
  expect(await comments()).toEqual(['Round this']);
  // v1 was shown just before: its mesh is in memory to compare with.
  await page.locator('#versions-menu').click();
  await expect(page.locator('[data-action="compare-previous"]')).toContainText('widget.step');
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());
  expect(hasNotes(join(folder, 'widget_v2.step'))).toBe(true);
  // v1's notes only get a "newer version" line; markers and comments stay as they were.
  const v1Now = mustReadNotes(join(folder, 'widget.step')) as unknown as Record<string, unknown> & {
    versions?: { newer?: { name: string }[] };
  };
  expect(v1Now.versions?.newer?.map((l) => l.name)).toEqual(['widget_v2.step']);
  delete v1Now.versions;
  expect(v1Now).toEqual(JSON.parse(v1Sidecar));
  const v2Notes = mustReadNotes(join(folder, 'widget_v2.step'));
  expect(v2Notes.versions?.earlier?.map((l) => l.name)).toEqual(['widget.step']);

  // v3: the newest earlier version with notes (v2) is named; "Separate part" keeps it empty and
  // isn't asked again this session.
  copyFileSync(join(revisions, '05-rib.step'), join(folder, 'widget-rev3.step'));
  await open('widget-rev3.step');
  await expect(page.locator('#version-title')).toHaveText(
    'Is widget-rev3.step a new version of widget_v2.step?',
    { timeout: 60_000 },
  );
  await page.locator('#version-separate').click();
  await loadedName('widget-rev3.step');
  expect(await comments()).toEqual([]);
  await open('widget_v2.step'); // own notes: never asked
  await loadedName('widget_v2.step');
  await open('widget-rev3.step');
  await loadedName('widget-rev3.step');
  await expect(question).toBeHidden();
  expect(await comments()).toEqual([]);
  // Opening an older version after a newer one (v0 < v2, rev3): silent.
  copyFileSync(join(revisions, 'base.step'), join(folder, 'widget_v0.step'));
  await open('widget_v0.step');
  await loadedName('widget_v0.step');
  await expect(question).toBeHidden();
});

test('Import onto a file with stale notes: "keep" moves no markers of the named file', async () => {
  const { page, notes, flush, open, importNew, comment, copy, pick, loadedName } =
    await versionFolder('keep-parent');
  const names = (list: { name: string }[] | undefined) => (list ?? []).map((l) => l.name);
  // X = k_v2 linked as a newer version of k, with k's comment brought over.
  copy('base.step', 'k.step');
  await open('k.step');
  await comment('From k');
  await flush();
  copy('01-fillet.step', 'k_v2.step');
  await importNew('k_v2.step');
  expect(names(notes('k_v2.step').versions?.earlier)).toEqual(['k.step']);
  // k_v2 changes outside the app: its notes are now for older contents of it.
  copy('05-rib.step', 'k_v2.step');
  // Another file q with its own comment; Import k_v2 onto it → "keep" k.
  copy('base.step', 'q.step');
  await open('q.step');
  await comment('From q');
  await flush();
  await pick('k_v2.step');
  await addAsVersion(page);
  const choice = page.locator('#choice-dialog');
  await expect(choice).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#choice-title')).toHaveText(
    'Which file is k_v2.step a newer version of?',
  );
  await page.locator('#choice-second').click();
  await loadedName('k_v2.step');
  await flush();
  // Like Open…: its own notes moved onto its new contents; nothing of q.
  const texts = (notes('k_v2.step').comments ?? []).map((c) => c.text);
  expect(texts).toEqual(['From k']);
  expect(names(notes('k_v2.step').versions?.earlier)).not.toContain('q.step');
  expect(names(notes('k_v2.step').versions?.earlier)).toContain('k.step');
  expect(names(notes('q.step').versions?.newer)).toEqual([]);
  // The AI hears where the notes came from: its own older contents, not q.
  const revision = await page.evaluate(() =>
    (
      (window as HookWindow).__thirdWheelTest as unknown as {
        revisionInfo(): { of: string; annotations: string } | undefined;
      }
    ).revisionInfo(),
  );
  expect(revision?.of).toBe('k_v2.step');
  expect(revision?.annotations).not.toBe('own');
});

test('Import onto a file with its own notes: empty = none, else its own / earlier / both', async () => {
  const { page, folder, notes, flush, open, importNew, comment, copy, pick, loadedName } =
    await versionFolder('own-notes');
  const texts = (file: string) => (notes(file).comments ?? []).map((c) => c.text);
  const names = (list: { name: string }[] | undefined) => (list ?? []).map((l) => l.name);
  const hook = () =>
    page.evaluate(() => {
      const h = (window as HookWindow).__thirdWheelTest as unknown as {
        notice(): string | undefined;
        revisionInfo(): { annotations: string } | undefined;
      };
      return { notice: h.notice(), annotations: h.revisionInfo()?.annotations };
    });
  // A version without paint (here: b, listed when it got a newer version) takes the notes over.
  copy('base.step', 'a.step');
  copy('01-fillet.step', 'b.step');
  copy('05-rib.step', 'c.step');
  await open('b.step');
  await importNew('c.step');
  expect(texts('b.step')).toEqual([]);
  await open('a.step');
  await comment('From a');
  await flush();
  await importNew('b.step');
  expect(texts('b.step')).toEqual(['From a']);
  expect(names(notes('b.step').versions?.earlier)).toEqual(['a.step']);
  expect(names(notes('b.step').versions?.newer)).toEqual(['c.step']);
  // Markers of its own: asked whose markers to use. Its own (Esc) → nothing moves; it joins d's
  // part, whose comments it shares.
  copy('base.step', 'd.step');
  copy('01-fillet.step', 'e.step');
  await open('e.step');
  await comment('From e');
  await flush();
  await open('d.step');
  // Marker names are unique in the project: d's markers never take a name e uses.
  await comment('From d');
  await comment('From d 2');
  await flush();
  type Marked = {
    markers: { id: string; name: string; color: string; entities: unknown[] }[];
    comments: { text: string; markerIds: string[] }[];
  };
  const marked = (file: string) => notes(file) as unknown as Marked;
  const dBefore = JSON.stringify(marked('d.step').markers.map((m) => [m.id, m.name, m.color]));
  const choice = page.locator('#choice-dialog');
  const addEOntoD = async () => {
    await open('d.step');
    await pick('e.step');
    await addAsVersion(page);
    await expect(choice).toBeVisible({ timeout: 60_000 });
    await expect(page.locator('#choice-title')).toHaveText('Which markers should e.step use?');
  };
  await pick('e.step');
  await addAsVersion(page);
  await expect(choice).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#choice-title')).toHaveText('Which markers should e.step use?');
  await expect(page.locator('#choice-first')).toHaveText('e.step (new)');
  await expect(page.locator('#choice-second')).toHaveText('d.step (earlier)');
  await expect(page.locator('#choice-third')).toHaveText('Both');
  await expect(page.locator('#choice-second')).toHaveAttribute('title', /kept in a backup copy/);
  await page.keyboard.press('Escape'); // Esc = its own
  await loadedName('e.step');
  await flush();
  // A part's comments are stored once, so both files show both (none lost).
  expect(texts('e.step')).toEqual(['From e', 'From d', 'From d 2']);
  expect(texts('d.step')).toEqual(['From e', 'From d', 'From d 2']);
  expect(names(notes('e.step').versions?.earlier)).toEqual(['d.step']);
  let state = await hook();
  expect(state.notice).toMatch(/^e\.step uses its own markers; none came from d\.step\./);
  expect(state.notice).not.toContain('has the name of an earlier marker');
  expect(state.annotations).toBe('own');
  const markerOf = (file: string, text: string) =>
    marked(file).comments.find((c) => c.text === text)?.markerIds[0] ?? '';
  const held = (file: string, id: string) =>
    (marked(file).markers.find((m) => m.id === id)?.entities.length ?? 0) > 0;
  const fromD = markerOf('d.step', 'From d');
  const fromD2 = markerOf('d.step', 'From d 2');
  // No two markers share a name, so none of e's is one of d's: "From e" keeps e's own marker.
  const fromE = markerOf('e.step', 'From e');
  expect(fromE).not.toBe(fromD);
  expect(held('e.step', fromE)).toBe(true);
  expect(held('e.step', fromD)).toBe(false);
  const all = marked('e.step').markers.map((m) => m.name.toLowerCase());
  expect(new Set(all).size).toBe(all.length);
  // Nothing of the earlier version changed (names, colours); it now also lists e's marker
  // (the shared comment "From e" names it).
  const dIds = new Set((JSON.parse(dBefore) as string[][]).map((m) => m[0]));
  expect(
    JSON.stringify(
      marked('d.step')
        .markers.filter((m) => dIds.has(m.id))
        .map((m) => [m.id, m.name, m.color]),
    ),
  ).toBe(dBefore);
  // d's Marker 3 has no place on e yet: listed (a shared comment names it), its row faded.
  expect(held('e.step', fromD2)).toBe(false);
  const bareRow = page.locator(`#markers li[data-marker="${fromD2}"]`);
  await expect(bareRow).toHaveClass(/marker-bare/);
  await expect(bareRow).toHaveAttribute('title', /no paint on this version/);
  await expect(page.locator(`#markers li[data-marker="${fromE}"]`)).not.toHaveClass(/marker-bare/);
  await expect(page.locator(`#markers li[data-marker="${fromD}"]`)).toHaveClass(/marker-bare/);
  // Painting it un-fades the row; undo fades it again (the list follows paint and undo).
  const canvas = page.locator('#viewport canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no canvas');
  await bareRow.locator('.marker-name').click();
  await page.keyboard.press('f');
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('v');
  await expect(bareRow).not.toHaveClass(/marker-bare/);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(bareRow).toHaveClass(/marker-bare/);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(bareRow).not.toHaveClass(/marker-bare/);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(bareRow).toHaveClass(/marker-bare/);
  await flush();
  // Both → its own stay, d's other markers move over.
  await addEOntoD();
  await page.locator('#choice-third').click();
  await loadedName('e.step');
  await flush();
  expect(held('e.step', fromD)).toBe(true);
  expect(held('e.step', fromD2)).toBe(true);
  state = await hook();
  expect(state.notice).toContain('e.step kept its own');
  // d's (earlier) → d's markers moved over, e's own paint kept in a backup copy.
  await addEOntoD();
  await page.locator('#choice-second').click();
  await loadedName('e.step');
  await flush();
  expect(held('e.step', fromD)).toBe(true);
  expect(held('e.step', fromD2)).toBe(true);
  const tw = projectFolderOf(join(folder, 'e.step')) ?? '';
  const bak = readdirSync(join(tw, '.thirdwheel', 'marks')).filter((f) =>
    /\.bak(-\d+)?\.json$/.test(f),
  );
  expect(bak.length).toBeGreaterThan(0);
  expect(texts('e.step')).toEqual(['From e', 'From d', 'From d 2']); // comments untouched
  state = await hook();
  expect(state.annotations).not.toBe('own');
});

test('Resolving the last comment on a moved marker hides it and clears its badge', async () => {
  const page = await app.firstWindow();
  const folder = join(dir, 'settle');
  mkdirSync(folder);
  const models = resolve(appDir, '../../test-models/square-wheel');
  copyFileSync(join(models, 'square-wheel.step'), join(folder, 'sw.step'));
  copyFileSync(join(models, 'square-wheel_v2.step'), join(folder, 'sw_v2.step'));
  const pick = (name: string) =>
    app.evaluate(
      ({ dialog }, p) => {
        dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [p] });
      },
      join(folder, name),
    );
  const loadedName = (name: string) =>
    expect(page.locator('#model-info')).toHaveText(new RegExp(`^${name.replace('.', '\\.')} · `), {
      timeout: 60_000,
    });
  type Hook = {
    model(): { faceBody: Uint32Array } | undefined;
    markers: {
      add(e: { kind: string; id: number }[], name?: string): { id: string };
      list(): { id: string; name: string; transfer?: { status: string } }[];
    };
    comments: {
      add(text: string, ids: string[]): { id: string };
      list(): { id: string; text: string; status: string }[];
      setStatus(id: string, status: string, note?: string, author?: string): boolean;
    };
    viewport: { markerEntityStats(): { tris: number } };
  };
  const tris = () =>
    page.evaluate(
      () =>
        ((window as HookWindow).__thirdWheelTest as unknown as Hook).viewport.markerEntityStats()
          .tris,
    );
  await pick('sw.step');
  await openStubbed();
  const question = page.locator('#version-dialog');
  await expect
    .poll(
      async () =>
        (await question.isVisible()) ||
        /^sw\.step · /.test(await page.locator('#model-info').innerText()),
      { timeout: 60_000 },
    )
    .toBe(true);
  if (await question.isVisible()) await page.locator('#version-separate').click();
  await loadedName('sw.step');
  await page.waitForFunction(() => (window as HookWindow).__thirdWheelTest?.loaded() === true);
  // Two markers, each holding every face of one body (v2 changes both bodies): "Cube" on one
  // comment, "Wheel" on an open and a closed one.
  await page.evaluate(() => {
    const h = (window as HookWindow).__thirdWheelTest as unknown as Hook;
    const faceBody = h.model()?.faceBody ?? new Uint32Array();
    const facesOf = (b: number) =>
      [...faceBody].flatMap((body, id) => (body === b ? [{ kind: 'face', id }] : []));
    const cube = h.markers.add(facesOf(0), 'Cube');
    const wheel = h.markers.add(facesOf(1), 'Wheel');
    h.comments.add('Eye higher', [cube.id]);
    h.comments.add('Looser pin', [wheel.id]);
    h.comments.add('Wheel colour', [wheel.id]);
  });
  await page.evaluate(() => (window as HookWindow).__thirdWheelTest?.flush());

  await pick('sw_v2.step');
  await addAsVersion(page);
  await loadedName('sw_v2.step');
  const cubeRow = page.locator('.marker-row', { hasText: 'Cube' });
  const wheelRow = page.locator('.marker-row', { hasText: 'Wheel' });
  await expect(cubeRow.locator('.marker-transfer')).toHaveCount(1);
  await expect(wheelRow.locator('.marker-transfer')).toHaveCount(1);
  const shownBefore = await tris();
  expect(shownBefore).toBeGreaterThan(0);

  // The AI says "Eye higher" is fixed; your Confirm closes it, hides Cube and clears its badge.
  await page.evaluate(() => {
    const h = (window as HookWindow).__thirdWheelTest as unknown as Hook;
    const c = h.comments.list().find((x) => x.text === 'Eye higher');
    h.comments.setStatus(c?.id ?? '', 'resolved', 'Moved the eye up', 'ai');
  });
  const eyeCard = page.locator('.comment-card', { hasText: 'Eye higher' });
  await expect(cubeRow.locator('.marker-resolved-tag')).toHaveCount(0); // AI alone: nothing
  await eyeCard.locator('[data-action="confirm"]').click();
  await expect(cubeRow.locator('.marker-resolved-tag')).toHaveText('✓ Resolved');
  await expect(cubeRow.locator('.marker-transfer')).toHaveCount(0);
  await expect.poll(tris).toBeLessThan(shownBefore);
  const shownAfter = await tris();

  // Wheel is shared by an open and a closed comment: it stays, badge and all.
  await page
    .locator('.comment-card', { hasText: 'Looser pin' })
    .locator('[data-action="resolve"]')
    .click();
  await expect(wheelRow.locator('.marker-resolved-tag')).toHaveCount(0);
  await expect(wheelRow.locator('.marker-transfer')).toHaveCount(1);
  expect(await tris()).toBe(shownAfter);

  // "Show resolved" draws Cube again (faded); off hides it again.
  await page.locator('#comment-show-closed').check();
  await expect.poll(tris).toBe(shownBefore);
  await page.locator('#comment-show-closed').uncheck();
  await expect.poll(tris).toBe(shownAfter);

  // Undo the resolve, then the Confirm: one step brings the badge and Cube back.
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(cubeRow.locator('.marker-transfer')).toHaveCount(1);
  await expect(cubeRow.locator('.marker-resolved-tag')).toHaveCount(0);
  await expect.poll(tris).toBe(shownBefore);
});
