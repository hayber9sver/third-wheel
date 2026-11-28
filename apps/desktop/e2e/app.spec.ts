/**
 * e2e: app name, About, the app menu, one app copy.
 */
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  app,
  appDir,
  bridgeFile,
  closeApp,
  dir,
  expect,
  launchApp,
  loadedWindow,
  test,
} from './fixtures.js';

test.beforeAll(launchApp);
test.afterAll(closeApp);

test('Display name "Third Wheel": window, toolbar, start view; settings folder kept', async () => {
  const page = await loadedWindow();
  // With a model shown: "<project> — <model>" (the project is named after its folder).
  await expect(page).toHaveTitle(`${basename(dir)} — box.step`);
  // The toolbar shows the logo alone; its tooltip names the app.
  await expect(page.locator('.brand')).toHaveAttribute('title', 'Third Wheel');
  await expect(page.locator('.empty-title')).toHaveText('Third Wheel');
  const main = await app.evaluate(({ app: a }) => ({
    name: a.getName(),
    userData: a.getPath('userData'),
  }));
  // setName must not move the settings folder (here: the test's --user-data-dir).
  expect(main).toEqual({ name: 'Third Wheel', userData: join(dir, 'profile') });
  const winTitle = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getTitle(),
  );
  expect(winTitle).toBe(`${basename(dir)} — box.step`);
});

test('About Third Wheel: menu item opens the dialog; third-party licences', async () => {
  const page = await loadedWindow();
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  // macOS: first item of the app menu; Windows: Help → About. Click it the way the menu does.
  const where = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.getMenuItemById('about-third-wheel');
    const top = item && menu?.items.find((m) => m.submenu?.items.includes(item));
    item?.click();
    return { label: item?.label, top: top?.role === 'help' ? 'help' : top?.label };
  });
  expect(where).toEqual({
    label: 'About Third Wheel',
    top: process.platform === 'darwin' ? 'Third Wheel' : 'help',
  });
  const dialog = page.locator('#about-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('#about-title')).toHaveText('Third Wheel');
  await expect(dialog.locator('#about-version')).toHaveText(`Version ${version}`);
  await expect(dialog).toContainText('© 2026 XiLaoTr · Apache License 2.0');
  await expect(dialog.locator('#about-link')).toHaveAttribute(
    'href',
    'https://github.com/XiLaoTr/third-wheel',
  );
  await expect(dialog).toContainText('Designed by XiLaoTr, built with Claude Code (Anthropic).');
  await expect(dialog.locator('svg.about-logo')).toBeVisible();
  // No Electron default About role left (it would open Electron's own panel).
  expect(
    await app.evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).some((m) =>
        m.submenu?.items.some((i) => i.role === 'about'),
      ),
    ),
  ).toBe(false);

  await expect(dialog.locator('#about-notices')).toBeHidden();
  await dialog.locator('#about-licences').click();
  const notices = dialog.locator('#about-notices-text');
  await expect(notices).toContainText('occt-wasm 5.15.0');
  await expect(notices).toContainText('GNU LESSER GENERAL PUBLIC LICENSE');
  await expect(notices).toContainText(/^three \S+ — MIT$/m);
  await expect(dialog.locator('#about-licences')).toHaveText('Hide licences');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('Send feedback: Help menu opens the pop-up; the form / a GitHub issue open in the browser', async () => {
  const page = await loadedWindow();
  const version = await app.evaluate(({ app: a }) => a.getVersion());
  // Record the links instead of opening a browser.
  await app.evaluate(({ shell }) => {
    const g = globalThis as { opened?: string[] };
    g.opened = [];
    shell.openExternal = (url: string) => {
      g.opened?.push(url);
      return Promise.resolve();
    };
  });
  const opened = () => app.evaluate(() => (globalThis as { opened?: string[] }).opened ?? []);
  const where = await app.evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    const item = menu?.getMenuItemById('menu-feedback');
    const top = item && menu?.items.find((m) => m.submenu?.items.includes(item));
    item?.click();
    return { label: item?.label, top: top?.role };
  });
  expect(where).toEqual({ label: 'Send feedback…', top: 'help' });
  const dialog = page.locator('#feedback-dialog');
  await expect(dialog).toBeVisible();
  const os = process.platform === 'darwin' ? 'macOS' : 'Windows';
  await expect(dialog.locator('#feedback-setup')).toContainText(`Third Wheel ${version} · ${os}`);
  await expect(dialog).toContainText('Your model, notes and chats are never sent.');
  await page.screenshot({ path: 'test-results/feedback-dialog.png' });

  await dialog.locator('#feedback-form').click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#notice')).toContainText('The feedback form opened in your browser');
  const form = new URL((await opened())[0] ?? '');
  expect(form.origin).toBe('https://docs.google.com');
  expect(form.searchParams.get('entry.259798060')).toContain(`Third Wheel ${version}`);

  // Without the setup line the issue opens empty but for its title.
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()?.getMenuItemById('menu-feedback')?.click();
  });
  await dialog.locator('#feedback-setup-on').uncheck();
  await dialog.locator('#feedback-github').click();
  await expect(dialog).toBeHidden();
  const issue = new URL((await opened())[1] ?? '');
  expect(`${issue.origin}${issue.pathname}`).toBe(
    'https://github.com/XiLaoTr/third-wheel/issues/new',
  );
  expect(issue.searchParams.get('title')).toBe('Feedback: ');
  expect(issue.searchParams.has('body')).toBe(false);
});

test('App menu: small real menu; items run once, Undo is the app’s or the text’s', async () => {
  const page = await loadedWindow();
  const click = (id: string) =>
    app.evaluate(({ Menu }, menuId) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById(menuId);
      if (!item) throw new Error(`no menu item ${menuId}`);
      (item.click as (this: typeof item) => void).call(item);
    }, id);
  const tops = await app.evaluate(({ Menu }) =>
    (Menu.getApplicationMenu()?.items ?? []).map((m) => m.label),
  );
  // Tests run unpackaged: the dev-only Developer menu is there; no View menu.
  expect(tops).toEqual(
    process.platform === 'darwin'
      ? ['Third Wheel', 'File', 'Edit', 'Window', 'Developer', 'Help']
      : ['&File', '&Edit', 'Developer', '&Help'],
  );

  // Open folder…: one dialog per click, and one for a key press that also reached the menu.
  await app.evaluate(({ dialog }) => {
    const g = globalThis as { dialogCount?: number };
    g.dialogCount = 0;
    dialog.showOpenDialog = () => {
      g.dialogCount = (g.dialogCount ?? 0) + 1;
      return Promise.resolve({ canceled: true, filePaths: [] });
    };
  });
  const dialogs = () =>
    app.evaluate(() => (globalThis as { dialogCount?: number }).dialogCount ?? 0);
  await click('menu-open-folder');
  await expect.poll(dialogs).toBe(1);
  await page.keyboard.press('ControlOrMeta+o');
  await click('menu-open-folder'); // the same press, as the macOS menu would send it
  await expect.poll(dialogs).toBe(2);
  await page.waitForTimeout(400);
  expect(await dialogs()).toBe(2);
  await click('menu-add-model');
  await expect.poll(dialogs).toBe(3);

  // Undo / Redo outside a text field = the app's history, one step per press.
  const rows = page.locator('#markers li[data-marker]');
  const before = await rows.count();
  await page.locator('#marker-add').click();
  await page.locator('#marker-add').click();
  await expect(rows).toHaveCount(before + 2);
  await click('menu-undo');
  await expect(rows).toHaveCount(before + 1);
  await click('menu-redo');
  await expect(rows).toHaveCount(before + 2);
  await page
    .locator('#viewport canvas')
    .first()
    .click({ position: { x: 5, y: 5 } }); // focus off
  await page.keyboard.press('ControlOrMeta+z');
  await click('menu-undo'); // same press
  await expect(rows).toHaveCount(before + 1);
  await page.waitForTimeout(400);
  await expect(rows).toHaveCount(before + 1);
  await click('menu-undo');
  await expect(rows).toHaveCount(before);

  // In a text field: Undo undoes typing, not a marker step.
  await page.locator('#marker-add').click();
  await expect(rows).toHaveCount(before + 1);
  await page.evaluate(() => {
    const t = document.createElement('textarea');
    t.id = 'menu-undo-probe';
    document.body.append(t);
  });
  const probe = page.locator('#menu-undo-probe');
  await probe.click();
  await page.keyboard.type('abc');
  await click('menu-undo');
  await expect(probe).toHaveValue('');
  await click('menu-redo');
  await expect(probe).toHaveValue('abc');
  await expect(rows).toHaveCount(before + 1);
  await page.evaluate(() => document.getElementById('menu-undo-probe')?.remove());
  await click('menu-undo');
  await expect(rows).toHaveCount(before);

  // Help: Keyboard shortcuts = the cheat sheet; Set up your AI agent… = the pop-up.
  await click('menu-shortcuts');
  await expect(page.locator('#help-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#help-sheet')).toBeHidden();
  await click('menu-connect');
  await expect(page.locator('#connect-dialog')).toBeVisible();
  // Behind an open pop-up, Open folder… does nothing (the keys don't reach the app there either).
  await click('menu-open-folder');
  await page.waitForTimeout(400);
  expect(await dialogs()).toBe(3);
  await page.keyboard.press('Escape');
  await expect(page.locator('#connect-dialog')).toBeHidden();
});

test('One app copy: a second launch hands its file to the open window and quits', async () => {
  const page = await loadedWindow();
  const execPath = await app.evaluate(() => process.execPath);
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['ELECTRON_RENDERER_URL'];
  delete env['THIRD_WHEEL_OPEN'];
  // Its own bridge file: had it started, it would have written this one.
  const secondBridge = join(dir, 'bridge-second.json');
  const lid = join(dir, 'lid.step');
  // Same profile folder as the open app = the same "app copy".
  const second = spawn(execPath, [appDir, `--user-data-dir=${join(dir, 'profile')}`, lid], {
    env: { ...env, THIRD_WHEEL_TEST: '1', THIRD_WHEEL_BRIDGE_FILE: secondBridge },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((done, fail) => {
    const timer = setTimeout(() => {
      second.kill();
      fail(new Error('the second launch did not quit'));
    }, 30_000);
    second.on('exit', (exitCode) => {
      clearTimeout(timer);
      done(exitCode);
    });
  });
  expect(code).toBe(0);
  await expect(page.locator('#model-info')).toHaveText(/^lid\.step · /, { timeout: 60_000 });
  expect(existsSync(secondBridge), 'the second launch never started its bridge').toBe(false);
  expect(existsSync(bridgeFile), 'the first app keeps its bridge').toBe(true);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
});
