import { dirname } from 'node:path';

/**
 * Folder an Open… / Import / Locate… dialog starts in: the shown model's folder, so
 * a new version exported next to it is right there. Only for a model this app opened (the
 * renderer can't point the dialog anywhere else); none (the OS default, usually the last folder
 * used) with no model or when that folder is gone.
 */
export function dialogStartFolder(
  shownPath: unknown,
  opened: (path: string) => boolean,
  isFolder: (path: string) => boolean,
): string | undefined {
  if (typeof shownPath !== 'string' || !opened(shownPath)) return undefined;
  const folder = dirname(shownPath);
  return isFolder(folder) ? folder : undefined;
}
