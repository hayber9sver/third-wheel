/**
 * The toolbar "Parts" menu's list: every part of the shown project in the order added, each
 * opened at its newest version. Pure.
 */
import type { ProjectPartRow } from '../../shared/ipc.js';

/**
 * - `shown`: the shown model's part, at its newest version.
 * - `shownOlder`: the shown model's part, an earlier version on screen: opens the newest.
 * - `found`: its newest version's file is there with the listed contents.
 * - `changed`: a file is there, with other contents (replaced since): opens as it is now.
 * - `missing`: no file at that path (moved, renamed or deleted).
 */
export type PartRowState = 'shown' | 'shownOlder' | 'found' | 'changed' | 'missing';

export interface PartMenuRow {
  readonly name: string;
  readonly path: string;
  readonly fileName: string;
  readonly openComments: number;
  readonly state: PartRowState;
}

/**
 * Menu rows from the project's list, each with its newest file's state on disk. `shown` = the
 * file on screen (an earlier version of its part leaves that row openable).
 */
export function partRows(
  list: readonly ProjectPartRow[],
  shown?: { readonly path: string; readonly contentHash: string },
): PartMenuRow[] {
  const newestShown = (p: ProjectPartRow): boolean =>
    shown === undefined || (p.path === shown.path && p.contentHash === shown.contentHash);
  return list.map((p) => ({
    name: p.name,
    path: p.path,
    fileName: p.fileName,
    openComments: p.openComments,
    state: p.shown
      ? newestShown(p)
        ? 'shown'
        : p.onDisk === p.contentHash
          ? 'shownOlder'
          : 'shown'
      : p.onDisk === null
        ? 'missing'
        : p.onDisk === p.contentHash
          ? 'found'
          : 'changed',
  }));
}

/** Short grey text after a row's name: its newest file (or why it can't be opened), open comments. */
export function partDetail(row: PartMenuRow, format: (n: number) => string = String): string {
  const bits: string[] = [];
  if (row.state === 'missing') bits.push('not found');
  else if (row.state === 'changed') bits.push('file changed since');
  else bits.push(row.fileName);
  if (row.openComments > 0) bits.push(`${format(row.openComments)} open`);
  return bits.join(' · ');
}

/** The row's tooltip. */
export function partTitle(row: PartMenuRow): string {
  const open =
    row.openComments === 0
      ? ''
      : ` ${String(row.openComments)} open comment${row.openComments === 1 ? '' : 's'}.`;
  switch (row.state) {
    case 'shown':
      return `Shown now: ${row.path}.${open}`;
    case 'shownOlder':
      return `An earlier version is shown. Open the newest: ${row.path}.${open}`;
    case 'found':
      return `Open its newest version: ${row.path}.${open}`;
    case 'changed':
      return `${row.path} has other contents than the version listed here; it opens as it is now.${open}`;
    case 'missing':
      return `${row.path} is not there any more (moved, renamed or deleted).${open}`;
  }
}
