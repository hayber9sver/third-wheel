/**
 * Frame-time measurement for performance checks. Dev only: enabled by the
 * `THIRD_WHEEL_PERF` env var (`1` = live readout after each orbit, `bench` = scripted run + quit).
 */

/** Budget for 60 fps. */
export const FRAME_BUDGET_MS = 1000 / 60;
/** A gap this long between frames means the pointer paused, not that a frame was slow. */
export const IDLE_GAP_MS = 100;

export interface FrameSummary {
  readonly frames: number;
  readonly avgMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
  /** Frames over FRAME_BUDGET_MS (a little slack for timer jitter). */
  readonly slowFrames: number;
}

export function summarizeFrames(intervalsMs: readonly number[]): FrameSummary {
  const n = intervalsMs.length;
  if (n === 0) return { frames: 0, avgMs: 0, p95Ms: 0, maxMs: 0, slowFrames: 0 };
  const sorted = [...intervalsMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  const p95 = sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)] ?? 0;
  return {
    frames: n,
    avgMs: sum / n,
    p95Ms: p95,
    maxMs: sorted[n - 1] ?? 0,
    slowFrames: sorted.filter((t) => t > FRAME_BUDGET_MS + 1).length,
  };
}

/**
 * Collects frame-to-frame intervals (from frame timestamps) and the CPU time each frame's draw
 * call took. Gaps over IDLE_GAP_MS are skipped: with render-on-demand they are pauses, not frames.
 */
export class FrameRecorder {
  private last: number | undefined;
  readonly intervals: number[] = [];
  readonly cpu: number[] = [];

  frame(timestampMs: number, cpuMs: number): void {
    this.cpu.push(cpuMs);
    if (this.last !== undefined) {
      const gap = timestampMs - this.last;
      if (gap <= IDLE_GAP_MS) this.intervals.push(gap);
    }
    this.last = timestampMs;
  }

  summary(): { interval: FrameSummary; cpu: FrameSummary } {
    return { interval: summarizeFrames(this.intervals), cpu: summarizeFrames(this.cpu) };
  }
}

export function formatSummary(s: FrameSummary): string {
  const fps = s.avgMs > 0 ? Math.round(1000 / s.avgMs) : 0;
  return `${String(s.frames)} frames · ${String(fps)} fps · avg ${s.avgMs.toFixed(1)} ms · worst ${s.maxMs.toFixed(1)} ms · ${String(s.slowFrames)} over 16.7 ms`;
}
