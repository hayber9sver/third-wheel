import { describe, expect, it } from 'vitest';
import {
  clampPanelWidth,
  coveredWidth,
  LEFT_PANEL_DEFAULT_WIDTH,
  LEFT_PANEL_MIN_WIDTH,
  parseLeftPanel,
} from './left-panel.js';

describe('left panel', () => {
  it('width stays between 300 px and what leaves the view usable', () => {
    expect(clampPanelWidth(100, 1400)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(clampPanelWidth(380, 1400)).toBe(380);
    expect(clampPanelWidth(2000, 1400)).toBe(640);
    // 960 px window − 300 px right panel: the view keeps 200 px.
    expect(clampPanelWidth(600, 660)).toBe(460);
    // Never under the minimum, even in a tiny view.
    expect(clampPanelWidth(600, 300)).toBe(LEFT_PANEL_MIN_WIDTH);
    expect(clampPanelWidth(Number.NaN, 1400)).toBe(LEFT_PANEL_DEFAULT_WIDTH);
  });

  it('settings: anything malformed falls back to open at the default width', () => {
    expect(parseLeftPanel('{"width":420,"folded":true}')).toEqual({ width: 420, folded: true });
    expect(parseLeftPanel('nope')).toEqual({ width: LEFT_PANEL_DEFAULT_WIDTH, folded: false });
    expect(parseLeftPanel(null)).toEqual({ width: LEFT_PANEL_DEFAULT_WIDTH, folded: false });
    expect(parseLeftPanel('{"width":"x"}')).toEqual({
      width: LEFT_PANEL_DEFAULT_WIDTH,
      folded: false,
    });
  });

  it('a folded panel covers nothing of the view', () => {
    expect(coveredWidth({ width: 340, folded: false })).toBe(348);
    expect(coveredWidth({ width: 340, folded: true })).toBe(0);
  });
});
