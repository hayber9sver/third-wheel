/**
 * Which model file a launch asks to open: the first command-line argument with a model
 * extension (`third-wheel part.step`, Windows "Open with"), resolved against the launch's folder.
 * Flags (`--user-data-dir=…`) and Electron's own arguments (`.`, the app path) are skipped; a flag
 * whose value is a separate argument (`--x part.step`) would be taken as the file (none in use).
 */
import { extname, resolve } from 'node:path';
import { LOADABLE_EXTENSIONS } from '@third-wheel/core';

export function modelPathFromArgs(argv: readonly string[], cwd: string): string | undefined {
  for (const arg of argv) {
    if (arg.startsWith('-')) continue;
    if (LOADABLE_EXTENSIONS.includes(extname(arg).toLowerCase())) return resolve(cwd, arg);
  }
  return undefined;
}

/** What a second launch hands the running app (`requestSingleInstanceLock`'s additional data). */
export interface LaunchRequest {
  open?: string;
}

export function isLaunchRequest(value: unknown): value is LaunchRequest {
  if (typeof value !== 'object' || value === null) return false;
  const open = (value as { open?: unknown }).open;
  return open === undefined || typeof open === 'string';
}
