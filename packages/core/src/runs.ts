/** Triangle runs: ascending triangle numbers ↔ `[first, count]` pairs as the sidecar stores them. */
import type { TriangleRun } from './schema.js';

/** Appends triangle `t` (ascending order) to `runs`, extending the last run when `t` follows it. */
export function pushRun(runs: TriangleRun[], t: number): void {
  const last = runs[runs.length - 1];
  if (last && last[0] + last[1] === t) last[1] += 1;
  else runs.push([t, 1]);
}

/** Runs of ascending, distinct triangle numbers. */
export function toRuns(triangles: Iterable<number>): TriangleRun[] {
  const runs: TriangleRun[] = [];
  for (const t of triangles) pushRun(runs, t);
  return runs;
}

/** Every triangle number in `runs`, in order. */
export function* fromRuns(runs: readonly (readonly [number, number])[]): Generator<number> {
  for (const [first, count] of runs) for (let t = first; t < first + count; t++) yield t;
}
