/**
 * The project's parts as the Parts ▾ menu lists them: each part's newest version and its open
 * comments. Pure: the app checks the files on disk.
 */
import type { PathApi } from './project-paths.js';
import type { Project } from './project-schema.js';
import { partVersions, versionFile } from './project-notes.js';

/** One part of the project, for the Parts ▾ menu. */
export interface PartRow {
  readonly partId: string;
  readonly name: string;
  /** The part's newest version (its file on this system): what opening the part shows. */
  readonly file: string;
  /** That file's name. */
  readonly fileName: string;
  /** The newest version's contents (to check the file on disk). */
  readonly contentHash: string;
  /** Comments on the part still open (resolved and won't-fix ones don't count). */
  readonly openComments: number;
  /** The part of the shown model. */
  readonly shown: boolean;
}

/**
 * Every part of the project in the order they were added, each with its newest version (as
 * Versions ▾ orders them; a version whose contents were saved over is skipped). `shownPart` = the
 * shown model's part id. A part with no versions is left out.
 */
export function projectParts(
  project: Project,
  folder: string,
  path: PathApi,
  shownPart?: string,
): PartRow[] {
  const rows: PartRow[] = [];
  for (const part of project.models) {
    const any = part.versions[0];
    if (!any) continue;
    const list = partVersions(
      project,
      folder,
      versionFile(folder, any, path),
      any.contentHash,
      path,
    );
    const newest = list?.rows.find((r) => !r.overwritten) ?? list?.rows[0];
    if (!newest) continue;
    rows.push({
      partId: part.id,
      name: part.name,
      file: newest.file,
      fileName: newest.name,
      contentHash: newest.contentHash,
      openComments: project.comments.filter((c) => c.modelId === part.id && c.status === 'open')
        .length,
      shown: part.id === shownPart,
    });
  }
  return rows;
}
