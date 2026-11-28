import { importStep, KeptShapes, type ExactRequest, type StepModel } from '@third-wheel/geometry';
import { OcctKernel } from 'occt-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  approxRequest,
  describeSelection,
  EXACT_DISTANCE_FAILED_NOTE,
  ExactValues,
} from './info-format.js';
import type { SelectionItem } from './selection.js';

// Body 0: 10×20×30 box. Body 1: cylinder r5 h15 at x = 30.
let m: StepModel;
let kept: KeptShapes;

beforeAll(async () => {
  const k = await OcctKernel.init();
  const step = k.exportStep(
    k.makeCompound([k.makeBox(10, 20, 30), k.translate(k.makeCylinder(5, 15), 30, 0, 0)]),
  );
  m = importStep(k, step, {
    keep: (s) => {
      kept = s;
    },
  });
}, 30_000);

const values = (blocks: ReturnType<typeof describeSelection>): string[] =>
  blocks.flatMap((b) => b.rows.map((r) => `${r.label}: ${r.value}`));
const cylFace = (): number => m.faceTypes.indexOf('cylinder');
const exactFor = (items: SelectionItem[], exact: ExactValues): ExactRequest => {
  const request = approxRequest(m, items, exact);
  exact.add(request, kept.measure(request));
  return request;
};

describe('approxRequest + ExactValues', () => {
  it('a curved face: asks for its area, then shows it without ≈', () => {
    const items: SelectionItem[] = [{ kind: 'face', id: cylFace() }];
    const exact = new ExactValues();
    expect(values(describeSelection(m, items, exact)).find((v) => v.startsWith('Area'))).toMatch(
      /^Area: ≈ /,
    );
    expect(exactFor(items, exact).faceAreas).toEqual([cylFace()]);
    // 2·π·5·15
    expect(values(describeSelection(m, items, exact))).toContain('Area: 471.24 mm²');
    expect(approxRequest(m, items, exact).faceAreas).toEqual([]);
  });

  it('two bodies: areas, sizes and the shortest distance', () => {
    const items: SelectionItem[] = [
      { kind: 'body', id: 0 },
      { kind: 'body', id: 1 },
    ];
    const exact = new ExactValues();
    const request = exactFor(items, exact);
    expect(request.bodyAreas).toEqual([0, 1]);
    expect(request.bodyBoxes).toEqual([0, 1]);
    expect(request.distances).toHaveLength(1);
    const text = values(describeSelection(m, items, exact));
    expect(text).toContain('Size X × Y × Z: 10 × 20 × 30 mm');
    expect(text).toContain('Area: 2200 mm²');
    expect(text).toContain('Shortest distance: 15 mm');
    expect(text.some((v) => v.includes('≈'))).toBe(false);
    const again = approxRequest(m, items, exact);
    expect(again.bodyAreas.length + again.bodyBoxes.length + again.distances.length).toBe(0);
  });

  it('OpenCascade gives no distance (NaN): ≈ stays, not asked again, a note says why', () => {
    const items: SelectionItem[] = [
      { kind: 'body', id: 0 },
      { kind: 'body', id: 1 },
    ];
    const exact = new ExactValues();
    expect(describeSelection(m, items, exact).at(-1)?.note).toBeUndefined();
    const request = approxRequest(m, items, exact);
    exact.add(request, { ...kept.measure(request), distances: [NaN] });
    const between = describeSelection(m, items, exact).at(-1);
    expect(between?.title).toBe('Between');
    expect(between?.rows.find((r) => r.label === 'Shortest distance')?.value).toMatch(/^≈ /);
    expect(between?.note).toBe(EXACT_DISTANCE_FAILED_NOTE);
    expect(approxRequest(m, items, exact).distances).toEqual([]);
  });

  it('vertices: nothing to ask (already exact); 3+ items: only face areas', () => {
    const exact = new ExactValues();
    const vv: SelectionItem[] = [
      { kind: 'vertex', id: 0 },
      { kind: 'vertex', id: 1 },
    ];
    expect(approxRequest(m, vv, exact).distances).toEqual([]);
    const many: SelectionItem[] = [
      { kind: 'face', id: 0 },
      { kind: 'face', id: 1 },
      { kind: 'body', id: 1 },
    ];
    const r = approxRequest(m, many, exact);
    expect(r.faceAreas).toEqual([0, 1]);
    expect(r.bodyAreas).toEqual([]);
    exactFor(many, exact);
    const total = values(describeSelection(m, many, exact)).find((v) =>
      v.startsWith('Total face area'),
    );
    expect(total).not.toContain('≈');
  });
});
