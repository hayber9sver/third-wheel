import { describe, expect, it } from 'vitest';
import {
  BRUSH_RADII_MM,
  brushInfo,
  DEFAULT_BRUSH_RADIUS_MM,
  formatBrushRadius,
  stepBrushRadius,
  DEFAULT_TOOL,
  TOOLS,
  toolDef,
  toolForKey,
  toolTitle,
} from './tools.js';

describe('tools', () => {
  it('defaults to Select', () => {
    expect(DEFAULT_TOOL).toBe('select');
  });

  it('has unique shortcuts', () => {
    const keys = TOOLS.map((t) => t.shortcut);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('maps keys to tools case-insensitively', () => {
    expect(toolForKey('b')).toBe('brush');
    expect(toolForKey('V')).toBe('select');
    expect(toolForKey('x')).toBeUndefined();
  });

  it('gives each tool its cursor', () => {
    expect(toolDef('select').cursor).toBe('pick');
    expect(toolDef('brush').cursor).toBe('circle');
    expect(toolDef('smart-fill').cursor).toBe('crosshair');
  });

  it('has a tooltip with shortcut and hint, and a fixed mm brush radius', () => {
    expect(toolTitle(toolDef('brush'))).toBe(
      'Brush (B) — paint the surface; Shift + drag erases the active marker',
    );
    expect(DEFAULT_BRUSH_RADIUS_MM).toBe(3);
  });

  it('steps the brush radius through the list, snapping first and stopping at the ends', () => {
    expect(BRUSH_RADII_MM).toContain(DEFAULT_BRUSH_RADIUS_MM);
    expect(stepBrushRadius(3, 1)).toBe(4);
    expect(stepBrushRadius(3, -1)).toBe(2.5);
    expect(stepBrushRadius(3, -3)).toBe(1.5);
    expect(stepBrushRadius(3.4, 0)).toBe(3);
    expect(stepBrushRadius(0.2, -1)).toBe(0.2);
    expect(stepBrushRadius(50, 5)).toBe(50);
    expect(stepBrushRadius(1000, -1)).toBe(40);
  });

  it('formats the radius in mm', () => {
    expect(formatBrushRadius(3)).toBe('3 mm');
    expect(formatBrushRadius(0.75)).toBe('0.75 mm');
  });

  it('shows the brush size and keys only for Brush', () => {
    expect(brushInfo('brush', 3)).toBe('Brush 3 mm · [ ] or Alt + scroll: size · Shift: erase');
    expect(toolForKey('e')).toBeUndefined(); // no Erase tool: Shift erases
    expect(brushInfo('select', 3)).toBe('');
    expect(brushInfo('smart-fill', 3)).toBe('');
    expect(brushInfo('smart-fill', 3, { angleDeg: 30, wholeFace: false })).toBe(
      'Smart fill 30° · [ ] or Alt + scroll: angle · Shift: erase',
    );
    expect(brushInfo('smart-fill', 3, { angleDeg: 30, wholeFace: true })).toBe(
      'Smart fill · whole CAD face · Shift: erase',
    );
    expect(brushInfo('brush', 3, { angleDeg: 30, wholeFace: true })).toBe(
      'Brush 3 mm · [ ] or Alt + scroll: size · Shift: erase',
    );
    // The readout names the marker Shift erases, and says so while Shift is held.
    expect(brushInfo('brush', 3, undefined, { marker: 'Marker 1' })).toBe(
      'Brush 3 mm · [ ] or Alt + scroll: size · Shift: erase Marker 1',
    );
    expect(brushInfo('smart-fill', 3, { angleDeg: 30, wholeFace: true }, { marker: 'Hole' })).toBe(
      'Smart fill · whole CAD face · Shift: erase Hole',
    );
    expect(brushInfo('brush', 3, undefined, { marker: 'Marker 1', on: true })).toBe(
      'Erasing Marker 1 — release Shift to paint',
    );
    expect(brushInfo('select', 3, undefined, { marker: 'Marker 1', on: true })).toBe('');
  });
});
