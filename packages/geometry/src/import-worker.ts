/**
 * STEP import off the UI thread: a worker runs {@link serveStepImports}; the UI uses
 * {@link StepImportClient}. Both sides only need `postMessage` + a `message` listener, so the
 * protocol is testable with a plain `MessageChannel` (no DOM / bundler here).
 */
import type { OcctKernel } from 'occt-wasm';
import {
  IMPORT_STAGES,
  progressAtStageStart,
  transferablesOf,
  type ImportStage,
  type StepModel,
  type TessellationSettings,
} from './model.js';
import type { ExactRequest, ExactResult, KeptShapes } from './exact.js';
import { importStep, isOutOfMemory } from './step-import.js';
import { importMesh, type MeshFormat } from './mesh-import.js';

/** The part of `Worker` / `DedicatedWorkerGlobalScope` / `MessagePort` we use. */
export interface MessageEndpoint {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
}
type Transferable = ArrayBuffer;

export interface ImportProgress {
  /** 0–1, weighted by typical stage duration. The kernel reports no progress inside a stage. */
  readonly fraction: number;
  readonly label: string;
}

/** Keep the model's shapes for {@link StepImportClient.exact}. */
export interface KeepOptions {
  /**
   * Keep them only if OpenCascade's WASM heap is at most this big after the import (the heap
   * never shrinks: a kept worker holds all of it). Omit to always keep.
   */
  readonly maxHeapBytes?: number;
}

type Request =
  | {
      type: 'import';
      id: number;
      data: ArrayBuffer;
      tessellation?: TessellationSettings;
      keep?: KeepOptions;
      /** A mesh file: parsed without the kernel; `name` names a single-body file. */
      mesh?: { format: MeshFormat; name: string };
    }
  | { type: 'exact'; id: number; request: ExactRequest };
type Response =
  | { type: 'progress'; id: number; progress: ImportProgress }
  | { type: 'done'; id: number; model: StepModel; kept: boolean }
  | { type: 'exact'; id: number; result: ExactResult }
  | { type: 'error'; id: number; message: string };

/** Asked for exact values while the worker holds no model shapes. */
export const NO_KEPT_SHAPES = 'No model shapes kept in the import worker';

/**
 * Worker side. `initKernel` runs once, on the first request. With `keep`, the last import's
 * shapes stay in the kernel until the next import, for `exact` requests.
 */
export function serveStepImports(
  endpoint: MessageEndpoint,
  initKernel: () => Promise<OcctKernel>,
): void {
  let kernel: Promise<OcctKernel> | undefined;
  // One import at a time: the kernel is synchronous anyway, and this keeps progress ordered.
  let queue: Promise<void> = Promise.resolve();
  let kept: KeptShapes | undefined;

  endpoint.addEventListener('message', ({ data }) => {
    const req = data as Request | null;
    const post = (res: Response, transfer?: Transferable[]): void => {
      endpoint.postMessage(res, transfer ?? []);
    };
    if (req?.type === 'exact' && typeof req.id === 'number') {
      const { id, request } = req;
      queue = queue.then(() => {
        try {
          if (!kept) throw new Error(NO_KEPT_SHAPES);
          post({ type: 'exact', id, result: kept.measure(request) });
        } catch (err) {
          post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
        }
      });
      return;
    }
    if (req?.type !== 'import' || typeof req.id !== 'number' || !(req.data instanceof ArrayBuffer))
      return;
    const { id, data: bytes, tessellation, keep, mesh } = req;
    queue = queue.then(async () => {
      kept?.release();
      kept = undefined;
      try {
        if (mesh) {
          post({ type: 'progress', id, progress: { fraction: 0, label: 'Reading mesh' } });
          const model = await importMesh(bytes, mesh.format, mesh.name);
          post({ type: 'done', id, model, kept: false }, transferablesOf(model));
          return;
        }
        post({
          type: 'progress',
          id,
          progress: { fraction: 0, label: 'Starting OpenCascade' },
        });
        // A failed init is forgotten so the next request retries it.
        kernel ??= initKernel().catch((err: unknown) => {
          kernel = undefined;
          throw err;
        });
        const k = await kernel;
        let lastPosted = -1;
        const report = (stage: ImportStage, within: number): void => {
          const info = IMPORT_STAGES.find((s) => s.stage === stage);
          const fraction = progressAtStageStart(stage) + (info?.weight ?? 0) * within;
          // At most ~100 messages per import (the mesh stage reports once per body).
          if (within > 0 && within < 1 && fraction - lastPosted < 0.01) return;
          lastPosted = fraction;
          post({ type: 'progress', id, progress: { fraction, label: info?.label ?? stage } });
        };
        let model: StepModel;
        try {
          model = importStep(k, bytes, {
            ...(tessellation ? { tessellation } : {}),
            onStage: (stage) => {
              report(stage, 0);
            },
            onStageProgress: report,
            ...(keep
              ? {
                  keep: (shapes: KeptShapes) => {
                    kept = shapes;
                  },
                }
              : {}),
          });
        } catch (err) {
          // A full WASM heap leaves the kernel unusable: start a fresh one next time.
          if (isOutOfMemory(err) || isOutOfMemory((err as { cause?: unknown }).cause))
            kernel = undefined;
          throw err;
        }
        // (Set by the `keep` callback: TS can't see that.)
        const shapes = kept as KeptShapes | undefined;
        if (
          shapes &&
          keep?.maxHeapBytes !== undefined &&
          k.getRawModule().HEAPU32.buffer.byteLength > keep.maxHeapBytes
        ) {
          shapes.release();
          kept = undefined;
        }
        post(
          { type: 'done', id, model, kept: (kept as KeptShapes | undefined) !== undefined },
          transferablesOf(model),
        );
      } catch (err) {
        post({
          type: 'error',
          id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  });
}

/** UI side: one client per worker. */
export class StepImportClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    {
      resolve: (res: Response) => void;
      reject: (e: Error) => void;
      onProgress: ((p: ImportProgress) => void) | undefined;
    }
  >();

  constructor(private readonly endpoint: MessageEndpoint) {
    endpoint.addEventListener('message', ({ data }) => {
      const res = data as Response;
      const job = this.pending.get(res.id);
      if (!job) return;
      if (res.type === 'progress') {
        job.onProgress?.(res.progress);
        return;
      }
      this.pending.delete(res.id);
      if (res.type === 'error') job.reject(new Error(res.message));
      else job.resolve(res);
    });
  }

  /** Reject every pending request (e.g. before the worker is terminated to cancel it). */
  cancelAll(message = 'Import cancelled'): void {
    const jobs = [...this.pending.values()];
    this.pending.clear();
    for (const job of jobs) job.reject(new Error(message));
  }

  /** Import STEP bytes. `data` is transferred to the worker (it becomes unusable here). */
  async import(
    data: ArrayBuffer,
    options: {
      tessellation?: TessellationSettings;
      onProgress?: (p: ImportProgress) => void;
    } = {},
  ): Promise<StepModel> {
    return (await this.importKeeping(data, options)).model;
  }

  /**
   * Like {@link import}; with `keep`, the worker keeps the model's shapes for {@link exact}
   * (`kept` says whether it did — see {@link KeepOptions.maxHeapBytes}).
   */
  async importKeeping(
    data: ArrayBuffer,
    options: {
      tessellation?: TessellationSettings;
      onProgress?: (p: ImportProgress) => void;
      keep?: KeepOptions;
      /** Read as a mesh file (STL / 3MF) instead of STEP; never kept. */
      mesh?: { format: MeshFormat; name: string };
    } = {},
  ): Promise<{ model: StepModel; kept: boolean }> {
    const req: Omit<Extract<Request, { type: 'import' }>, 'id'> = {
      type: 'import',
      data,
      ...(options.tessellation ? { tessellation: options.tessellation } : {}),
      ...(options.keep ? { keep: options.keep } : {}),
      ...(options.mesh ? { mesh: options.mesh } : {}),
    };
    const res = await this.send(req, [data], options.onProgress);
    if (res.type !== 'done') throw new Error(`unexpected reply ${res.type}`);
    return { model: res.model, kept: res.kept };
  }

  /** Exact values for the last import kept by the worker (else rejects with {@link NO_KEPT_SHAPES}). */
  async exact(request: ExactRequest): Promise<ExactResult> {
    const res = await this.send({ type: 'exact', request }, []);
    if (res.type !== 'exact') throw new Error(`unexpected reply ${res.type}`);
    return res.result;
  }

  private send(
    req:
      | Omit<Extract<Request, { type: 'import' }>, 'id'>
      | Omit<Extract<Request, { type: 'exact' }>, 'id'>,
    transfer: Transferable[],
    onProgress?: (p: ImportProgress) => void,
  ): Promise<Response> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onProgress });
      this.endpoint.postMessage({ ...req, id }, transfer);
    });
  }
}
