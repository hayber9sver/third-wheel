import { describe, expect, it } from 'vitest';
import { cheatSheet } from './help.js';
import { getNavigationStyle, NAVIGATION_STYLES } from './navigation.js';

type StyleId = 'fusion' | 'onshape' | 'slicer';

const lines = (rows: readonly { input: string; action: string }[]): string[] =>
  rows.map((r) => `${r.input}: ${r.action}`);

/** Everything on the sheet, shown and folded. */
const text = (id: StyleId, isMac = true): string =>
  cheatSheet(getNavigationStyle(id), isMac)
    .flatMap((s) => [s.title, ...lines(s.rows), ...lines(s.more)])
    .join('\n');

/** Only what shows before "More" is opened. */
const shown = (id: StyleId, isMac = true): string =>
  cheatSheet(getNavigationStyle(id), isMac)
    .flatMap((s) => [s.title, ...lines(s.rows)])
    .join('\n');

describe('cheatSheet', () => {
  it('has six short groups for every style', () => {
    for (const style of NAVIGATION_STYLES) {
      const sections = cheatSheet(style, false);
      expect(sections.map((s) => s.title)).toEqual([
        `View (${style.label})`,
        'Select',
        'Paint',
        'Markers and comments',
        'Files and versions',
        'AI',
      ]);
      for (const s of sections) {
        expect(s.rows.length).toBeGreaterThan(0);
        // Scannable: the always-shown part stays short.
        expect(s.rows.length).toBeLessThanOrEqual(5);
      }
    }
  });

  it('follows the navigation style', () => {
    expect(shown('fusion')).toContain('Shift + middle-drag: Orbit');
    expect(text('fusion')).toContain('Trackpad: two-finger swipe: Pan');
    expect(shown('onshape')).toContain('Right-drag: Orbit');
    expect(text('onshape')).toContain('Trackpad: two-finger swipe: Orbit');
    expect(shown('slicer')).toContain('Left-drag on the background: Orbit');
    expect(text('slicer')).toContain('Alt + left-drag: Orbit (anywhere)');
    expect(text('fusion')).not.toContain('Alt + left-drag');
  });

  it('says how a box starts: any drag, or from the model / Shift in Slicer', () => {
    expect(shown('fusion')).toContain('Drag left → right: Box: add');
    expect(shown('slicer')).toContain('Drag from the model, or Shift + drag left → right');
    expect(text('slicer')).toContain('Press Alt once the box has started');
    expect(text('fusion')).toContain('Hold Alt while boxing');
  });

  it('describes the brush tools and their cursors', () => {
    expect(shown('fusion')).toContain('B Brush: Drag on the model: paint with the active marker');
    expect(shown('fusion')).toContain(
      'F Smart fill: Click: fill up to edges sharper than the angle',
    );
    expect(shown('fusion')).toContain("Shift + drag / click: Erase the active marker's paint");
    expect(shown('fusion')).toContain('[ / ] or Alt + scroll: Smaller / larger brush');
    expect(text('fusion')).toContain(
      'Brush cursor: circle on the surface = brush size (red dashed while Shift erases)',
    );
    expect(text('fusion')).not.toContain('E Erase');
    expect(text('fusion')).not.toContain('Left press on the model');
    expect(text('slicer')).toContain('Left press on the model: Use the tool (background: orbit)');
  });

  it('a comment click highlights only, ⌖ zooms', () => {
    expect(shown('fusion')).toContain(
      'Click a comment: Highlight its markers (⌖ on the card zooms',
    );
    expect(text('fusion')).not.toMatch(/Click a comment: [^\n]*[Hh]ighlight and zoom/);
  });

  it('names Send review, Reload, Versions, marker rename and Delete', () => {
    expect(shown('fusion')).toContain('Send review:');
    expect(shown('fusion')).toContain(
      'File ▸ Reload from disk: Read the shown file again after you saved over it',
    );
    expect(shown('fusion')).toContain('Versions ▾: Compare with an earlier version');
    expect(text('fusion')).toContain('Double-click or F2 on a marker row: Rename the marker');
    expect(text('fusion')).toContain('Delete on a marker row: Delete the marker');
    expect(text('fusion')).not.toContain('annotations');
  });

  it('shows the platform shortcuts', () => {
    expect(shown('fusion', true)).toContain('⌘O: Open a folder');
    expect(shown('fusion', false)).toContain('Ctrl+O: Open a folder');
    expect(shown('fusion', true)).toContain('⌘I: Add a file');
    expect(shown('fusion', false)).toContain('Ctrl+Z / Ctrl+Y: Undo / redo');
    expect(text('fusion', false)).toContain('Ctrl+S: Save notes now');
    expect(text('fusion', false)).toContain('Win+H: Dictate a comment');
  });
});
