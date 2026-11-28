/**
 * The app menu: a small real menu instead of Electron's default one.
 *
 * macOS: Third Wheel (About, Hide, Quit) · File · Edit · Window (Minimize, Zoom) · Help.
 * Windows: File (… Exit) · Edit · Help (… About Third Wheel).
 *
 * File (project-first: New project folder… · Open folder… · Open Recent · Add file… ·
 * Reload from disk · Make this folder its own project… · Save project as…) / Undo / Redo / Help items are carried out by the window (`MenuCommand`, the same code
 * as its buttons and keys). Their accelerators are only *shown* on Windows (the page's keydown
 * handles the key there); on macOS the menu takes them and the window drops a second copy of
 * the same press (`ShortcutOnce`). Cut / Copy / Paste / Select All stay Electron roles: they
 * make Cmd+C / Cmd+V work in text boxes on macOS. Dev builds add a Developer menu (Reload,
 * Developer Tools); packaged builds have none.
 */
import type { MenuItemConstructorOptions } from 'electron';
import { ABOUT_MENU_ID, ABOUT_MENU_LABEL } from '../shared/about.js';
import { APP_DISPLAY_NAME } from '../shared/app-name.js';
import { MENU_IDS, type MenuCommand } from '../shared/menu-commands.js';

export interface AppMenuOptions {
  readonly platform: NodeJS.Platform;
  /** Unpackaged run: add the Developer menu. */
  readonly dev: boolean;
  readonly onAbout: () => void;
  readonly onCommand: (command: MenuCommand) => void;
  /** File ▸ Open Recent: projects, newest first (label + folder). */
  readonly recent?: readonly { readonly label: string; readonly folder: string }[];
  readonly onOpenRecent?: (folder: string) => void;
  readonly onClearRecent?: () => void;
}

export function appMenuTemplate(opts: AppMenuOptions): MenuItemConstructorOptions[] {
  const mac = opts.platform === 'darwin';
  const recent = opts.recent ?? [];
  /** Windows: `&` marks the Alt key letter (Alt+F opens File); macOS would show the `&`. */
  const top = (name: string): string => (mac ? name : `&${name}`);
  const command = (
    cmd: MenuCommand,
    label: string,
    accelerator?: string,
  ): MenuItemConstructorOptions => ({
    id: MENU_IDS[cmd],
    label,
    ...(accelerator ? { accelerator, ...(mac ? {} : { registerAccelerator: false }) } : {}),
    click: () => {
      opts.onCommand(cmd);
    },
  });
  const about: MenuItemConstructorOptions = {
    id: ABOUT_MENU_ID,
    label: ABOUT_MENU_LABEL,
    click: opts.onAbout,
  };

  const file: MenuItemConstructorOptions = {
    label: top('File'),
    submenu: [
      command('newProjectFolder', 'New project folder…'),
      command('openFolder', 'Open folder…', 'CmdOrCtrl+O'),
      {
        id: 'menu-open-recent',
        label: 'Open Recent',
        submenu: recent.length
          ? [
              ...recent.map((r): MenuItemConstructorOptions => ({
                label: r.label,
                click: () => opts.onOpenRecent?.(r.folder),
              })),
              { type: 'separator' },
              { label: 'Clear Recent', click: () => opts.onClearRecent?.() },
            ]
          : [{ label: 'No recent projects', enabled: false }],
      },
      { type: 'separator' },
      command('addModel', 'Add file…', 'CmdOrCtrl+I'),
      command('reloadFromDisk', 'Reload from disk'),
      { type: 'separator' },
      command('makeOwnProject', 'Make this folder its own project…'),
      command('saveProjectAs', 'Save project as…'),
      ...(mac ? [] : [{ type: 'separator' } as const, { role: 'quit', label: 'Exit' } as const]),
    ],
  };
  const edit: MenuItemConstructorOptions = {
    label: top('Edit'),
    submenu: [
      command('undo', 'Undo', 'CmdOrCtrl+Z'),
      command('redo', 'Redo', mac ? 'Shift+Cmd+Z' : 'Ctrl+Y'),
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };
  const helpItems: MenuItemConstructorOptions[] = [
    command('shortcuts', 'Keyboard shortcuts'),
    command('connect', 'Set up your AI agent…'),
    command('feedback', 'Send feedback…'),
  ];
  const developer: MenuItemConstructorOptions[] = opts.dev
    ? [
        {
          label: 'Developer',
          submenu: [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }],
        },
      ]
    : [];

  if (mac) {
    return [
      {
        label: APP_DISPLAY_NAME,
        submenu: [
          about,
          { type: 'separator' },
          { role: 'hide' },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      file,
      edit,
      { role: 'windowMenu', submenu: [{ role: 'minimize' }, { role: 'zoom' }] },
      ...developer,
      { role: 'help', submenu: helpItems },
    ];
  }
  return [
    file,
    edit,
    ...developer,
    { role: 'help', label: top('Help'), submenu: [...helpItems, { type: 'separator' }, about] },
  ];
}
