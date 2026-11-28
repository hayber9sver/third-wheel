/**
 * The toolbar "Versions" menu's list: every version of the shown model's part, newest first, as
 * the project lists them (linked by Add file… → New version / Bring my notes over / the AI's
 * `revisionOf`, never by file names). Side branches (two versions made from the same one) are
 * listed too.
 */
import type { ProjectVersionRow } from '../../shared/ipc.js';

/**
 * - `found`: the file is there with the listed contents.
 * - `changed`: a file is there, with other contents (replaced since).
 * - `missing`: no file at that path (moved, renamed or deleted): Locate….
 * - `overwritten`: the file was replaced by a newer version of itself; these contents are gone.
 */
export type VersionRowState = 'shown' | 'found' | 'changed' | 'missing' | 'overwritten';

export interface VersionRow {
  /** The version's id in the project. */
  readonly id: string;
  readonly path: string;
  readonly name: string;
  readonly contentHash: string;
  /** When it was added (ISO). */
  readonly added: string;
  readonly state: VersionRowState;
}

/** Menu rows from the project's list (already newest first), each with its state on disk. */
export function versionRows(list: readonly ProjectVersionRow[]): VersionRow[] {
  return list.map((v) => ({
    id: v.id,
    path: v.path,
    name: v.name,
    contentHash: v.contentHash,
    added: v.added,
    state: v.shown
      ? 'shown'
      : v.overwritten
        ? 'overwritten'
        : v.onDisk === null
          ? 'missing'
          : v.onDisk === v.contentHash
            ? 'found'
            : 'changed',
  }));
}

/** Short grey text after a row's name. */
export function versionDetail(row: VersionRow, locale?: string): string {
  switch (row.state) {
    case 'shown':
      return 'shown';
    case 'missing':
      return 'not found';
    case 'changed':
      return 'file changed since';
    case 'overwritten':
      return 'overwritten';
    case 'found': {
      const t = new Date(row.added);
      if (Number.isNaN(t.getTime())) return '';
      return t.toLocaleString(locale, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
    }
  }
}

/** The row's label: overwritten contents are "earlier contents of X". */
export function versionLabel(row: VersionRow): string {
  return row.state === 'overwritten' ? `earlier contents of ${row.name}` : row.name;
}

/**
 * Add file's question text with a model shown. Adding a STEP while a mesh is shown moves the
 * mesh's paint and comments onto the STEP's faces (its name may differ); the name hint is given
 * only when the names really match (`bracket_v2` ↔ `bracket`).
 */
export function addFileQuestion(
  fileName: string,
  shownName: string,
  opts: { fromMesh: boolean; fileIsMesh: boolean; sameName: boolean },
): string {
  const moves =
    opts.fromMesh && !opts.fileIsMesh
      ? `its paint and comments move onto the faces of ${fileName}`
      : 'its markers and comments move over';
  const hint = opts.sameName ? ` Its name looks like a version of ${shownName}.` : '';
  return `Is it a new version of ${shownName} (${moves}) or a separate part of this project?${hint}`;
}
