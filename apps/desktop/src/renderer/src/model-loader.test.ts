import type { ExactRequest, StepModel } from '@third-wheel/geometry';
import { describe, expect, it } from 'vitest';
import {
  FILE_CHANGED_MESSAGE,
  KEEP_KERNEL_MAX_HEAP_BYTES,
  ModelLoader,
  workerCrashMessage,
  type ImportWorker,
} from './model-loader.js';

/** A worker that never answers by itself; `reply` answers its last request. */
class FakeWorker implements ImportWorker {
  terminated = false;
  onerror: ((event: ErrorEvent) => void) | null = null;
  private listener: ((e: { data: unknown }) => void) | undefined;
  private lastId = 0;
  readonly requests: { type: string; keep?: { maxHeapBytes?: number } }[] = [];

  postMessage(message: unknown): void {
    this.lastId = (message as { id: number }).id;
    this.requests.push(message as { type: string });
  }
  addEventListener(_type: 'message', listener: (e: { data: unknown }) => void): void {
    this.listener = listener;
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(model: StepModel, kept = false): void {
    this.listener?.({ data: { type: 'done', id: this.lastId, model, kept } });
  }
  replyExact(result: unknown): void {
    this.listener?.({ data: { type: 'exact', id: this.lastId, result } });
  }
}

const file = (name: string, contentHash = 'sha256:a') => ({
  path: name,
  name,
  data: new ArrayBuffer(8),
  contentHash,
});
const model = { bodyCount: 0, faceBody: [], edgeBody: [], vertexBody: [] } as unknown as StepModel;
/** A model with id counts (the re-read check compares them). */
const counted = (faces: number): StepModel =>
  ({
    bodyCount: 1,
    faceBody: new Uint32Array(faces),
    edgeBody: new Uint32Array(1),
    edgeChain: new Uint32Array(1),
    vertexBody: new Uint32Array(1),
  }) as unknown as StepModel;
const request: ExactRequest = { faceAreas: [0], bodyAreas: [], bodyBoxes: [], distances: [] };
const result = { faceAreas: [42], bodyAreas: [], bodyBoxes: [], distances: [] };
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('ModelLoader', () => {
  it('a new load cancels the running one at once and stops its worker', async () => {
    const workers: FakeWorker[] = [];
    const loader = new ModelLoader(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const a = loader.load(file('a.step'), () => undefined);
    const b = loader.load(file('b.step'), () => undefined);
    await expect(a).resolves.toBeNull(); // without waiting for A's worker
    expect(workers[0]?.terminated).toBe(true);

    workers[1]?.reply(model);
    const loaded = await b;
    expect(loaded?.file.name).toBe('b.step');
    expect(loaded?.model).toBe(model);
    expect(workers[1]?.terminated).toBe(true); // freed after the import
  });

  it('a crashed worker rejects the load instead of hanging', async () => {
    const worker = new FakeWorker();
    const loader = new ModelLoader(() => worker);
    const load = loader.load(file('huge.step'), () => undefined);
    worker.onerror?.({ message: 'Out of memory', preventDefault: () => undefined } as ErrorEvent);
    await expect(load).rejects.toThrow(workerCrashMessage('Out of memory'));
    expect(worker.terminated).toBe(true);
  });

  it('keeps a small model’s worker and asks it for exact values', async () => {
    const worker = new FakeWorker();
    const loader = new ModelLoader(() => worker);
    const load = loader.load(file('a.step'), () => undefined);
    expect(worker.requests[0]?.keep?.maxHeapBytes).toBe(KEEP_KERNEL_MAX_HEAP_BYTES);
    worker.reply(counted(6), true);
    expect((await load)?.kernelKept).toBe(true);
    expect(worker.terminated).toBe(false);
    expect(loader.exactNeedsReread).toBe(false);
    const exact = loader.exact(request, () => undefined);
    await tick();
    worker.replyExact(result);
    await expect(exact).resolves.toEqual(result);
  });

  it('a new load frees the kept worker', async () => {
    const workers: FakeWorker[] = [];
    const loader = new ModelLoader(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    });
    const a = loader.load(file('a.step'), () => undefined);
    workers[0]?.reply(counted(6), true);
    await a;
    void loader.load(file('b.step'), () => undefined);
    expect(workers[0]?.terminated).toBe(true);
  });

  it('re-reads the file when the worker was freed (large model)', async () => {
    const workers: FakeWorker[] = [];
    const reads: string[] = [];
    const loader = new ModelLoader(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      (path) => {
        reads.push(path);
        return Promise.resolve(file(path));
      },
    );
    const load = loader.load(file('big.step'), () => undefined);
    workers[0]?.reply(counted(6), false);
    expect((await load)?.kernelKept).toBe(false);
    expect(workers[0]?.terminated).toBe(true);
    expect(loader.exactNeedsReread).toBe(true);

    const exact = loader.exact(request, () => undefined);
    await tick();
    expect(reads).toEqual(['big.step']);
    expect(workers[1]?.requests[0]?.keep).toEqual({}); // no heap limit: the user asked
    workers[1]?.reply(counted(6), true);
    await tick();
    workers[1]?.replyExact(result);
    await expect(exact).resolves.toEqual(result);
    expect(loader.exactNeedsReread).toBe(false); // kept now, until the next load
  });

  it('refuses a re-read file whose content hash changed (no second import)', async () => {
    const workers: FakeWorker[] = [];
    const loader = new ModelLoader(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      (path) => Promise.resolve(file(path, 'sha256:b')),
    );
    const load = loader.load(file('big.step'), () => undefined);
    workers[0]?.reply(counted(6), false);
    await load;
    const exact = loader.exact(request, () => undefined);
    await expect(exact).rejects.toThrow(FILE_CHANGED_MESSAGE);
    expect(workers).toHaveLength(1);
    expect(loader.exactNeedsReread).toBe(true);
  });

  it('a new load during the re-read wins; exact resolves with null', async () => {
    const workers: FakeWorker[] = [];
    const loader = new ModelLoader(
      () => {
        const w = new FakeWorker();
        workers.push(w);
        return w;
      },
      (path) => Promise.resolve(file(path)),
    );
    const load = loader.load(file('big.step'), () => undefined);
    workers[0]?.reply(counted(6), false);
    await load;
    const exact = loader.exact(request, () => undefined);
    await tick();
    void loader.load(file('other.step'), () => undefined);
    await expect(exact).resolves.toBeNull();
    expect(workers[1]?.terminated).toBe(true);
  });
});
