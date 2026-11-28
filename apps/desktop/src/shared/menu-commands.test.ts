import { describe, expect, it } from 'vitest';
import { isMenuCommand, SAME_PRESS_MS, ShortcutOnce } from './menu-commands.js';

describe('ShortcutOnce', () => {
  it('one press from both menu and key runs once, whichever comes first', () => {
    const once = new ShortcutOnce();
    expect(once.take('openFolder', 'menu', 1000)).toBe(true);
    expect(once.take('openFolder', 'key', 1010)).toBe(false);
    const other = new ShortcutOnce();
    expect(other.take('undo', 'key', 1000)).toBe(true);
    expect(other.take('undo', 'menu', 1005)).toBe(false);
  });

  it('repeats from one side all run (holding Cmd+Z)', () => {
    const once = new ShortcutOnce();
    for (let t = 0; t < 200; t += 30) expect(once.take('undo', 'menu', t)).toBe(true);
  });

  it('a later press from the other side runs; other commands are separate', () => {
    const once = new ShortcutOnce();
    expect(once.take('undo', 'menu', 0)).toBe(true);
    expect(once.take('redo', 'key', 10)).toBe(true);
    expect(once.take('undo', 'key', SAME_PRESS_MS + 1)).toBe(true);
    // A pair is used up: key, menu (dropped), then key again runs.
    expect(once.take('openFolder', 'key', 0)).toBe(true);
    expect(once.take('openFolder', 'menu', 5)).toBe(false);
    expect(once.take('openFolder', 'key', 50)).toBe(true);
  });

  it('isMenuCommand', () => {
    expect(isMenuCommand('openFolder')).toBe(true);
    expect(isMenuCommand('reload')).toBe(false);
    expect(isMenuCommand(3)).toBe(false);
  });
});
