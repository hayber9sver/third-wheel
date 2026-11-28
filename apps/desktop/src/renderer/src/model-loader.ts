/** Loads model files through the STEP import worker and reports progress. */
import {
  meshFormatOf,
  StepImportClient,
  type ExactRequest,
  type ExactResult,
  type ImportProgress,
  type MessageEndpoint,
  type StepModel,
} from '@third-wheel/geometry';
import type { ModelFile } from '../../shared/ipc.js';

export interface LoadedModel {
  readonly file: Pick<ModelFile, 'path' | 'name' | 'contentHash'>;
  readonly model: StepModel;
  /** Wall time from request to result, ms. */
  readonly ms: number;
  /** The worker kept the model's shapes: exact values come at once (else the file is re-read). */
  readonly kernelKept: boolean;
}

/**
 * Keep the import worker (and its shapes, for exact values) only up to this WASM heap.
 * Typical models use a few MB; huge assemblies (a 2.7 GB one) free it.
 */
export const KEEP_KERNEL_MAX_HEAP_BYTES = 1024 ** 3;

/** The file on disk no longer matches the model shown (ids would point at other entities). */
export const FILE_CHANGED_MESSAGE =
  'The file changed on disk since it was opened. Reopen it to get exact values.';

/**
 * One fresh worker per import. That lets a new file cancel a running import at once (instead of
 * queueing behind it). After the import the worker is kept for exact values if OpenCascade's
 * heap stayed small, else terminated to free that memory — WASM memory never shrinks (
 * ~1 GB kept after the 130-body sample). Costs a kernel start per load.
 */
export type ImportWorker = MessageEndpoint & {
  terminate(): void;
  /** Fires if the worker itself dies (e.g. a JS out-of-memory): without it the load would hang. */
  onerror: ((event: ErrorEvent) => void) | null;
};

/** Shown when the worker crashed instead of reporting an error. */
export function workerCrashMessage(detail: string | undefined): string {
  return (
    `The import stopped unexpectedly${detail ? ` (${detail})` : ''}. ` +
    'The model may be too large — try exporting only the sub-assembly you need.'
  );
}

type Job = { worker: ImportWorker; client: StepImportClient };

export class ModelLoader {
  /** Import (or re-read) in progress. */
  private running: Job | undefined;
  /** The model shown: its path, content hash and — when kept — the worker holding its shapes. */
  private shown: { path: string; hash: string; kept: Job | undefined } | undefined;
  private latest = 0;

  constructor(
    private readonly createWorker: () => ImportWorker = () =>
      new Worker(new URL('./step-worker.ts', import.meta.url), {
        type: 'module',
      }),
    /** Reads the shown file again (exact values after its worker was freed). */
    private readonly readFile: (path: string) => Promise<ModelFile> = (path) => {
      const api = window.thirdWheel;
      return api ? api.rereadModelFile(path) : Promise.reject(new Error('No file access'));
    },
  ) {}

  /** True if exact values need the file read again first (the worker was freed). */
  get exactNeedsReread(): boolean {
    return this.shown?.kept === undefined;
  }

  /**
   * Import a file. Resolves with null if a newer load started meanwhile (it cancels this one).
   * The file's bytes are transferred to the worker.
   */
  async load(
    file: ModelFile,
    onProgress: (p: ImportProgress) => void,
  ): Promise<LoadedModel | null> {
    const ticket = ++this.latest;
    this.cancel();
    this.dropShown();
    const t0 = performance.now();
    const format = meshFormatOf(file.name);
    // STL / 3MF are read as meshes (no kernel, nothing kept: they have no exact values).
    const mesh = format ? { format, name: file.name.replace(/\.[^.]*$/, '') } : undefined;
    const result = await this.run(ticket, file.data, onProgress, KEEP_KERNEL_MAX_HEAP_BYTES, mesh);
    if (!result) return null;
    const { job, model, kept } = result;
    this.shown = { path: file.path, hash: file.contentHash, kept: kept ? job : undefined };
    return {
      file: { path: file.path, name: file.name, contentHash: file.contentHash },
      model,
      ms: performance.now() - t0,
      kernelKept: kept,
    };
  }

  /**
   * Exact values for the shown model. If its worker was freed, the file is read and imported
   * again first (`onProgress` reports that). Resolves with null if a new load started meanwhile.
   */
  async exact(
    request: ExactRequest,
    onProgress: (p: ImportProgress) => void,
  ): Promise<ExactResult | null> {
    const shown = this.shown;
    if (!shown) throw new Error('No model loaded');
    const ticket = this.latest;
    if (!shown.kept) {
      if (this.running) throw new Error('The file is still being read');
      const file = await this.readFile(shown.path);
      if (ticket !== this.latest) return null;
      // Another file version: ids would point at other entities (hash, was id counts).
      if (file.contentHash !== shown.hash) throw new Error(FILE_CHANGED_MESSAGE);
      // No heap limit: the user asked for it; freed with the next load.
      const result = await this.run(ticket, file.data, onProgress, undefined);
      if (!result) return null;
      shown.kept = result.job;
    }
    const job = shown.kept;
    try {
      const values = await job.client.exact(request);
      return ticket === this.latest ? values : null;
    } catch (err) {
      if (ticket !== this.latest) return null;
      // A crashed worker can't answer again: re-read next time.
      if (shown.kept === job && this.crashed.has(job)) {
        job.worker.terminate();
        shown.kept = undefined;
      }
      throw err;
    }
  }

  private readonly crashed = new WeakSet<Job>();

  /**
   * Import in a fresh worker. Resolves with null if superseded (`ticket` no longer latest). The
   * worker is terminated unless it kept the shapes.
   */
  private async run(
    ticket: number,
    data: ArrayBuffer,
    onProgress: (p: ImportProgress) => void,
    maxHeapBytes: number | undefined,
    mesh?: { format: 'stl' | '3mf'; name: string },
  ): Promise<{ job: Job; model: StepModel; kept: boolean } | null> {
    const worker = this.createWorker();
    const job: Job = { worker, client: new StepImportClient(worker) };
    this.running = job;
    worker.onerror = (event) => {
      event.preventDefault();
      this.crashed.add(job);
      job.client.cancelAll(workerCrashMessage(event.message || undefined));
    };
    let result: { model: StepModel; kept: boolean } | undefined;
    try {
      result = await job.client.importKeeping(data, {
        onProgress,
        keep: maxHeapBytes === undefined ? {} : { maxHeapBytes },
        ...(mesh ? { mesh } : {}),
      });
    } catch (err) {
      worker.terminate();
      if (ticket !== this.latest) return null; // superseded: nobody waits for this error
      throw err;
    } finally {
      if (this.running === job) this.running = undefined;
    }
    if (ticket !== this.latest || !result.kept) worker.terminate();
    if (ticket !== this.latest) return null;
    return { job, ...result };
  }

  /**
   * Stop any import and free the worker kept for the last model (a version read only to
   * compare needs no exact values).
   */
  release(): void {
    this.latest++;
    this.cancel();
    this.dropShown();
  }

  /** Stop a running import (its `load` resolves with null if a newer load replaced it). */
  private cancel(): void {
    const job = this.running;
    if (!job) return;
    this.running = undefined;
    job.worker.terminate();
    job.client.cancelAll();
  }

  /** Free the shown model's worker (a new file is being opened). */
  private dropShown(): void {
    const kept = this.shown?.kept;
    this.shown = undefined;
    if (!kept) return;
    kept.worker.terminate();
    kept.client.cancelAll();
  }
}
