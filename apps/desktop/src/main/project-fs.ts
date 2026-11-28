/** Node's `fs` as the core project store's `ProjectFs` (docs/file-format.md). */
import {
  open,
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import type { ProjectFs } from '@third-wheel/core';

export const nodeProjectFs: ProjectFs = {
  readText: (file) => readFile(file, 'utf8'),
  async readTail(file, bytes) {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const length = Math.min(bytes, size);
      if (length === 0) return '';
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, size - length);
      return buf.toString('utf8');
    } finally {
      await handle.close();
    }
  },
  async size(file) {
    try {
      const info = await stat(file);
      return info.isFile() ? info.size : undefined;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
  },
  async isDirectory(p) {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  },
  writeText: (file, text) => writeFile(file, text, 'utf8'),
  async createExclusive(file, text) {
    try {
      await writeFile(file, text, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e;
    }
  },
  appendText: (file, text) => appendFile(file, text, 'utf8'),
  rename: (from, to) => rename(from, to),
  remove: (file) => rm(file, { force: true }),
  async list(dir) {
    try {
      return await readdir(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  },
  async makeDir(dir) {
    await mkdir(dir, { recursive: true });
  },
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};
