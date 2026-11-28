/**
 * Optional check of region analysis (core) and the review payload on real paint: every local STEP sample in
 * `test-models/` (or the folder in `THIRD_WHEEL_SAMPLES_DIR`) that has a sidecar next to it (not in CI):
 *   THIRD_WHEEL_SAMPLES=1 pnpm test packages/geometry
 * (`THIRD_WHEEL_SAMPLES=bracket` runs only files whose name contains `bracket`.)
 * Lives here, not in core, because it needs the STEP import.
 */
import { analyzeRegions, faceAreas, parseAnnotationsJson } from '@third-wheel/core';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OcctKernel } from 'occt-wasm';
import { describe, expect, it } from 'vitest';
import { bodyFingerprints, entityFingerprints } from './fingerprint.js';
import { estimateTokens, reviewPayload, reviewPayloadText } from './review.js';
import { importStep } from './step-import.js';

const dir =
  process.env['THIRD_WHEEL_SAMPLES_DIR'] ??
  join(import.meta.dirname, '..', '..', '..', 'test-models');
const filter = process.env['THIRD_WHEEL_SAMPLES'];
const files =
  filter && existsSync(dir)
    ? readdirSync(dir).filter(
        (f) =>
          /\.(step|stp)$/i.test(f) &&
          (filter === '1' || f.includes(filter)) &&
          existsSync(join(dir, `${f}.thirdwheel.json`)),
      )
    : [];

describe.skipIf(files.length === 0)('region analysis on local samples', () => {
  it.each(files)(
    '%s: regions are consistent with the paint',
    async (file) => {
      const parsed = parseAnnotationsJson(
        readFileSync(join(dir, `${file}.thirdwheel.json`), 'utf8'),
      );
      if (!parsed.ok) throw new Error(parsed.errors.join('\n'));
      const kernel = await OcctKernel.init();
      const bytes = readFileSync(join(dir, file));
      const model = importStep(
        kernel,
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
      const t0 = performance.now();
      const regions = analyzeRegions(model, parsed.data.markers);
      const ms = Math.round(performance.now() - t0);
      for (const m of parsed.data.markers) {
        const r = regions.get(m.id);
        console.log(JSON.stringify({ file, marker: m.id, ms, region: r }));
        if (m.paint.faces.length === 0) {
          expect(r).toBeNull();
          continue;
        }
        if (!r) throw new Error(`${m.id}: no region`);
        expect(r.area).toBeGreaterThan(0);
        for (let i = 0; i < 3; i++) {
          expect(r.centroid[i]).toBeGreaterThanOrEqual((r.bbox.min[i] ?? 0) - 1e-6);
          expect(r.centroid[i]).toBeLessThanOrEqual((r.bbox.max[i] ?? 0) + 1e-6);
        }
        const held = new Set(m.entities.filter((e) => e.kind === 'face').map((e) => e.id));
        const areas = faceAreas(
          model,
          m.paint.faces.map((f) => f.faceId),
        );
        let painted = 0;
        for (const f of r.stepFaces) {
          expect(held.has(f.faceId)).toBe(false);
          expect(f.coverage).toBeGreaterThan(0);
          expect(f.coverage).toBeLessThanOrEqual(1);
          painted += f.coverage * (areas.get(f.faceId) ?? 0);
        }
        // Paint on held faces is in `area` but not in `stepFaces`.
        expect(painted).toBeLessThanOrEqual(r.area * (1 + 1e-9));
        const parts = r.components.reduce((s, c) => s + c.area, 0);
        expect(parts).toBeCloseTo(r.area, 6);
      }

      // Review payload: compact on real, messy paint.
      const t1 = performance.now();
      const text = reviewPayloadText(reviewPayload(model, parsed.data));
      const tokens = estimateTokens(text);
      const t2 = performance.now();
      const bodies = bodyFingerprints(model, model.bodyCount);
      entityFingerprints(
        model,
        parsed.data.markers.flatMap((m) => m.entities),
        bodies,
      );
      const t3 = performance.now();
      console.log(
        JSON.stringify({
          file,
          payloadMs: Math.round(t2 - t1),
          tokens,
          fingerprintMs: Math.round(t3 - t2),
          bodies: bodies.length,
          bodiesBytes: JSON.stringify(bodies).length,
        }),
      );
      console.log(text);
      expect(tokens).toBeLessThan(2000);
    },
    120_000,
  );
});
