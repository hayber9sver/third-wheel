import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dialogStartFolder } from './dialog-folder.js';

describe('dialogStartFolder', () => {
  const folder = join('models', 'bracket');
  const model = join(folder, 'bracket.step');
  const opened = (p: string): boolean => p === model;
  it("starts in the shown model's folder", () => {
    expect(dialogStartFolder(model, opened, () => true)).toBe(folder);
  });
  it('no model, a path the app never opened, or a gone folder → OS default', () => {
    expect(dialogStartFolder(undefined, opened, () => true)).toBeUndefined();
    expect(dialogStartFolder(join('elsewhere', 'x.step'), opened, () => true)).toBeUndefined();
    expect(dialogStartFolder(42, opened, () => true)).toBeUndefined();
    expect(dialogStartFolder(model, opened, () => false)).toBeUndefined();
  });
});
