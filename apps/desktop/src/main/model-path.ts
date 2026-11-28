import { realpath } from 'node:fs/promises';

/** `\\host\share` or `//host/share`. */
const UNC = /^[\\/]{2}/;

/**
 * One spelling per model file, so the same model never counts twice (Send review, version lists):
 * symlinks resolved (macOS `/var` → `/private/var`) and, on Windows, the on-disk letter case
 * (`c:\parts\A.STEP` → `C:\Parts\a.step`). A mapped network drive keeps its drive letter (realpath
 * would turn it into a `\\host\share` path). Falls back to `path` when it can't be resolved.
 */
export async function canonicalModelPath(
  path: string,
  resolveReal: (p: string) => Promise<string> = realpath, // fs/promises: the OS realpath (uv_fs_realpath)
): Promise<string> {
  try {
    const real = await resolveReal(path);
    return UNC.test(real) && !UNC.test(path) ? path : real;
  } catch {
    return path;
  }
}
