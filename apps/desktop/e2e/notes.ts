/**
 * Test helper: a model's notes as the app saves them, read from its project (`.thirdwheel/`),
 * in the v1 notes shape the tests check (markers with paint, comments). The version links come
 * from the project's list, as a v1-style `versions` chain (earlier = made from, nearest first;
 * newer = made from it, newest first), so tests can check how versions are linked.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  PROJECT_DIR,
  PROJECT_SCHEMA_VERSION,
  notesOf,
  versionFile,
  versionNotes,
  parseProjectJson,
  parseVersionMarksJson,
  projectFiles,
  projectSearchFolders,
  versionAtPath,
  type Annotations,
  type Project,
  type ProjectPart,
  type ProjectVersion,
  type VersionChain,
} from '@third-wheel/core';

/** A version's links in the project, in the v1 chain shape; undefined = none. */
function linksOf(
  part: ProjectPart,
  version: ProjectVersion,
  folder: string,
): VersionChain | undefined {
  const byId = new Map(part.versions.map((v) => [v.id, v]));
  const link = (v: ProjectVersion) => {
    const file = versionFile(folder, v, path);
    return {
      path: file,
      name: path.basename(file),
      contentHash: v.contentHash,
      date: v.added,
      ...(v.overwritten ? { overwritten: true as const } : {}),
    };
  };
  const earlier = [];
  const seen = new Set([version.id]);
  for (let at = version.from; at !== undefined;) {
    const v = byId.get(at);
    if (!v || seen.has(v.id)) break;
    seen.add(v.id);
    earlier.push(link(v));
    at = v.from;
  }
  const newer = part.versions
    .filter((v) => v.from === version.id)
    .sort((a, b) => (Date.parse(b.added) || 0) - (Date.parse(a.added) || 0))
    .map(link);
  if (earlier.length === 0 && newer.length === 0 && !version.unlinked) return undefined;
  return {
    ...(earlier.length ? { earlier } : {}),
    ...(newer.length ? { newer } : {}),
    ...(version.unlinked ? { unlinked: version.unlinked } : {}),
  };
}

/** The project folder a model belongs to (nearest `.thirdwheel/` upwards), if any. */
export function projectFolderOf(model: string): string | undefined {
  return projectSearchFolders(path.dirname(model), homedir(), path).find((f) =>
    existsSync(path.join(f, PROJECT_DIR, 'project.json')),
  );
}

/** The project of a model, parsed. */
export function readProjectOf(model: string): Project | undefined {
  const folder = projectFolderOf(model);
  if (!folder) return undefined;
  const r = parseProjectJson(readFileSync(projectFiles(folder, path).project, 'utf8'));
  if (!r.ok) throw new Error(`project.json: ${r.errors.join('; ')}`);
  return r.data;
}

/** The model's notes (undefined: none saved yet). */
export function readNotes(model: string): Annotations | undefined {
  const folder = projectFolderOf(model);
  if (!folder) return undefined;
  const project = readProjectOf(model);
  if (!project) return undefined;
  const ref = versionAtPath(project, folder, path.resolve(model), path);
  if (!ref) return undefined;
  const chain = linksOf(ref.part, ref.version, folder);
  const file = projectFiles(folder, path).marks(ref.version.id);
  let notes: Annotations | undefined;
  if (existsSync(file)) {
    const marks = parseVersionMarksJson(readFileSync(file, 'utf8'));
    if (!marks.ok) throw new Error(`marks: ${marks.errors.join('; ')}`);
    notes = versionNotes(project, ref, marks.data, folder, path);
  } else {
    notes = versionNotes(project, ref, undefined, folder, path);
    // A linked version without paint or comments: empty notes, so its links can be checked.
    if (!notes && chain) {
      const step = ref.version.format === 'step';
      notes = notesOf(
        project,
        ref,
        {
          schemaVersion: PROJECT_SCHEMA_VERSION,
          versionId: ref.version.id,
          contentHash: ref.version.contentHash,
          // Nothing saved yet: any settings do (there is no paint to place).
          ...(step
            ? {
                tessellation: project.tessellation ?? {
                  linearDeflection: 0.1,
                  angularDeflection: 0.5,
                },
              }
            : {}),
          markers: [],
        },
        folder,
        path,
      );
    }
  }
  return notes && chain ? { ...notes, versions: chain } : notes;
}

/** The notes, or a test failure when there are none. */
export function mustReadNotes(model: string): Annotations {
  const n = readNotes(model);
  if (!n) throw new Error(`no notes saved for ${model}`);
  return n;
}

export function hasNotes(model: string): boolean {
  return readNotes(model) !== undefined;
}
