/**
 * In-memory `ProjectFs` for tests, for POSIX or Windows paths, with fault injection
 * (refused renames, failing writes, unreadable files). For tests only: the package exports it as
 * `@third-wheel/core/testing` (app tests use it); app code never imports it.
 */
import type { PathApi } from '../project-paths.js';
import type { ProjectFs } from '../project-store.js';

export class FsError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export class MemoryFs implements ProjectFs {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();
  /** Per file: error codes the next renames onto it throw, one per try. */
  readonly renameFails = new Map<string, string[]>();
  /** Writes to a path containing one of these throw `ENOSPC`. */
  readonly writeFails: string[] = [];
  /** Reads of these paths throw `EACCES`. */
  readonly unreadable = new Set<string>();
  /** Fake sizes (to test the 256 MB limit without 256 MB). */
  readonly fakeSize = new Map<string, number>();
  readonly sleeps: number[] = [];
  readonly renames: { from: string; to: string }[] = [];

  constructor(readonly path: PathApi) {}

  private norm(p: string): string {
    return this.path.resolve(p);
  }

  addFile(p: string, text: string): void {
    const f = this.norm(p);
    this.files.set(f, text);
    for (let d = this.path.dirname(f); ; d = this.path.dirname(d)) {
      this.dirs.add(d);
      if (this.path.dirname(d) === d) break;
    }
  }

  read(p: string): string | undefined {
    return this.files.get(this.norm(p));
  }

  readText(file: string): Promise<string> {
    const f = this.norm(file);
    if (this.unreadable.has(f)) return Promise.reject(new FsError('EACCES'));
    const t = this.files.get(f);
    return t === undefined ? Promise.reject(new FsError('ENOENT')) : Promise.resolve(t);
  }
  async readTail(file: string, bytes: number): Promise<string> {
    const t = await this.readText(file);
    return t.slice(Math.max(0, t.length - bytes));
  }
  size(file: string): Promise<number | undefined> {
    const f = this.norm(file);
    const t = this.files.get(f);
    if (t === undefined) return Promise.resolve(undefined);
    return Promise.resolve(this.fakeSize.get(f) ?? t.length);
  }
  isDirectory(p: string): Promise<boolean> {
    return Promise.resolve(this.dirs.has(this.norm(p)));
  }
  private checkWrite(f: string): void {
    if (!this.dirs.has(this.path.dirname(f))) throw new FsError('ENOENT');
    if (this.writeFails.some((w) => f.includes(w))) throw new FsError('ENOSPC');
  }
  async writeText(file: string, text: string): Promise<void> {
    await Promise.resolve();
    const f = this.norm(file);
    this.checkWrite(f);
    this.files.set(f, text);
  }
  createExclusive(file: string, text: string): Promise<boolean> {
    const f = this.norm(file);
    if (this.files.has(f)) return Promise.resolve(false);
    return this.writeText(f, text).then(() => true);
  }
  async appendText(file: string, text: string): Promise<void> {
    await Promise.resolve();
    const f = this.norm(file);
    this.checkWrite(f);
    this.files.set(f, (this.files.get(f) ?? '') + text);
  }
  rename(from: string, to: string): Promise<void> {
    const a = this.norm(from);
    const b = this.norm(to);
    const fails = this.renameFails.get(b);
    const code = fails?.shift();
    if (code) return Promise.reject(new FsError(code));
    const t = this.files.get(a);
    if (t === undefined) return Promise.reject(new FsError('ENOENT'));
    this.files.delete(a);
    this.files.set(b, t);
    this.renames.push({ from: a, to: b });
    return Promise.resolve();
  }
  remove(file: string): Promise<void> {
    this.files.delete(this.norm(file));
    return Promise.resolve();
  }
  list(dir: string): Promise<string[]> {
    const d = this.norm(dir);
    const names = new Set<string>();
    for (const p of [...this.files.keys(), ...this.dirs]) {
      if (p !== d && this.path.dirname(p) === d) names.add(this.path.basename(p));
    }
    return Promise.resolve([...names]);
  }
  makeDir(dir: string): Promise<void> {
    for (let d = this.norm(dir); ; d = this.path.dirname(d)) {
      this.dirs.add(d);
      if (this.path.dirname(d) === d) break;
    }
    return Promise.resolve();
  }
  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    return Promise.resolve();
  }
  /** Temp files left over (`….tmp`). */
  temps(): string[] {
    return [...this.files.keys()].filter((f) => f.endsWith('.tmp'));
  }
}

/** Deterministic random bytes for ids (a counter). */
export function counterRandom(): (n: number) => Uint8Array {
  let i = 0;
  return (n) => {
    const out = new Uint8Array(n);
    let x = i++;
    for (let k = n - 1; k >= 0; k--) {
      out[k] = x % 26;
      x = Math.floor(x / 26);
    }
    return out;
  };
}
