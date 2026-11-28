import { readFileSync } from 'node:fs';
import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { meshHash } from './mesh-hash.js';
import type { StepModel } from './model.js';
import { importStep } from './step-import.js';

// Revision test set: 00 differs from base only in ids inside the file.
const dir = new URL('../test-data/revisions/', import.meta.url);
const models = new Map<string, StepModel>();

beforeAll(async () => {
  const k = await OcctKernel.init();
  for (const f of ['base.step', '00-unchanged.step', '07-moved.step', '10-renamed-reordered.step'])
    models.set(f, importStep(k, readFileSync(new URL(f, dir), 'utf8')));
}, 60_000);

const hashOf = (f: string): Promise<string> => {
  const m = models.get(f);
  if (!m) throw new Error(f);
  return meshHash(m);
};

describe('meshHash', () => {
  it('is a sha256 and the same for the same file', async () => {
    const h = await hashOf('base.step');
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(await hashOf('base.step')).toBe(h);
  });

  it('is the same for a re-export that only changed ids inside the file', async () => {
    expect(await hashOf('00-unchanged.step')).toBe(await hashOf('base.step'));
  });

  it('differs when the geometry or the body order changed', async () => {
    const base = await hashOf('base.step');
    expect(await hashOf('07-moved.step')).not.toBe(base);
    expect(await hashOf('10-renamed-reordered.step')).not.toBe(base);
  });

  it('differs with other mesh settings', async () => {
    const m = models.get('base.step');
    if (!m) throw new Error('base');
    const other = { ...m, tessellation: { ...m.tessellation, linearDeflection: 0.2 } };
    expect(await meshHash(other)).not.toBe(await meshHash(m));
  });
});
