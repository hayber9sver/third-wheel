/** Dev perf probe: wires FrameRecorder to the viewport for the `perf` URL query. */
import type { PerfMode } from '../../shared/ipc.js';
import { FrameRecorder, formatSummary } from './perf.js';
import type { Viewport } from './viewport.js';

export interface LoadTimings {
  readonly file: string;
  readonly bodies: number;
  readonly triangles: number;
  /** Worker import (parse + tessellate + maps), ms. */
  readonly importMs: number;
  /** Building GPU buffers + scene, ms. */
  readonly buildMs: number;
  /** From the file reaching the renderer to the model on screen, ms. */
  readonly firstPictureMs: number;
  /** Worker stages (read, topology, mesh, edges, info), ms; importMs minus their sum ≈ worker + kernel start. */
  readonly stages: Readonly<Record<string, number>>;
}

const BENCH_WARMUP_FRAMES = 60;
const BENCH_FRAMES = 360;
/** Hover picks in the bench (one per frame, random positions). */
const BENCH_PICKS = 240;
/** Brush strokes in the bench: radius in mm, one stroke of `BENCH_STROKE_FRAMES` steps each. */
const BENCH_STROKE_RADII_MM = [3, 50] as const;
const BENCH_STROKE_FRAMES = 120;

/** Sets the app up for a bench brush stroke: a fresh active marker, Brush tool, radius in mm. */
export type StrokeSetup = (radiusMm: number) => void;

export function perfModeFromUrl(search: string): PerfMode {
  const v = new URLSearchParams(search).get('perf');
  return v === 'live' || v === 'bench' ? v : 'off';
}

export class PerfProbe {
  private recorder: FrameRecorder | undefined;
  /** Paint overlay rebuild times during a bench stroke, ms. */
  private paintBuilds: number[] | undefined;

  constructor(
    private readonly viewport: Viewport,
    private readonly mode: PerfMode,
    private readonly show: (text: string) => void,
    private readonly strokeSetup?: StrokeSetup,
  ) {
    if (mode === 'off') return;
    viewport.onFrame = (t, cpu) => {
      this.recorder?.frame(t, cpu);
      if (viewport.paintBuildMs > 0) this.paintBuilds?.push(viewport.paintBuildMs);
    };
    if (mode === 'live') {
      viewport.onNavigate((active) => {
        if (active) {
          this.recorder = new FrameRecorder();
          return;
        }
        const r = this.recorder;
        this.recorder = undefined;
        if (!r || r.intervals.length < 2) return;
        const { interval, cpu } = r.summary();
        const text = `Last orbit: ${formatSummary(interval)} · draw CPU worst ${cpu.maxMs.toFixed(1)} ms`;
        console.info(text);
        this.show(text);
      });
    }
  }

  /** Called when a load fails. In bench mode the error is reported and the app quits. */
  loadFailed(file: string, error: string, ms: number): void {
    if (this.mode === 'bench')
      window.thirdWheel?.sendPerfResult({ file, error, ms: Math.round(ms) });
  }

  /** Called once a model is on screen. In bench mode: orbit, report, and the app quits. */
  async modelShown(t: LoadTimings): Promise<void> {
    if (this.mode === 'off') return;
    console.info('Load timings', t);
    if (this.mode !== 'bench') return;
    await this.viewport.benchOrbit(BENCH_WARMUP_FRAMES);
    this.recorder = new FrameRecorder();
    await this.viewport.benchOrbit(BENCH_FRAMES);
    const { interval, cpu } = this.recorder.summary();
    this.recorder = undefined;
    // The first pick compiles the pick shaders and uploads the id buffers: reported separately.
    const [firstPick = 0, ...rest] = await this.viewport.benchPick(BENCH_PICKS + 1);
    const picks = rest.sort((x, y) => x - y);
    const round = (ms: number): number => Math.round(ms * 100) / 100;
    const pick = {
      firstMs: round(firstPick),
      count: picks.length,
      avgMs: round(picks.reduce((sum, ms) => sum + ms, 0) / Math.max(1, picks.length)),
      p95Ms: round(picks[Math.floor(picks.length * 0.95)] ?? 0),
      maxMs: round(picks[picks.length - 1] ?? 0),
    };
    const strokes = [];
    if (this.strokeSetup) {
      for (const radiusMm of BENCH_STROKE_RADII_MM) {
        this.strokeSetup(radiusMm);
        this.recorder = new FrameRecorder();
        this.paintBuilds = [];
        const steps = (await this.viewport.benchStroke(BENCH_STROKE_FRAMES)).sort((x, y) => x - y);
        const frames = this.recorder.summary();
        const builds = this.paintBuilds.sort((x, y) => x - y);
        this.recorder = undefined;
        this.paintBuilds = undefined;
        strokes.push({
          radiusMm,
          frame: frames.interval,
          drawCpu: frames.cpu,
          paintBuildAvgMs: round(
            builds.reduce((sum, ms) => sum + ms, 0) / Math.max(1, builds.length),
          ),
          paintBuildMaxMs: round(builds[builds.length - 1] ?? 0),
          stepAvgMs: round(steps.reduce((sum, ms) => sum + ms, 0) / Math.max(1, steps.length)),
          stepMaxMs: round(steps[steps.length - 1] ?? 0),
          paintedTriangles: this.viewport.paintShownTriangles(),
        });
      }
    }
    const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    window.thirdWheel?.sendPerfResult({
      ...t,
      orbit: interval,
      drawCpu: cpu,
      pick,
      strokes,
      devicePixelRatio: window.devicePixelRatio,
      canvas: [window.innerWidth, window.innerHeight],
      jsHeapMB: heap ? Math.round(heap.usedJSHeapSize / 1e6) : null,
    });
  }
}
