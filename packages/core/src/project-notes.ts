/**
 * One project version seen as v1 notes, and v1 notes written back into the project.
 *
 * The app's window still works with one notes document per model file (the v1 sidecar shape:
 * markers with paint, comments, body folders, version chain). The project stores the same things
 * split up (docs/file-format.md): comments and marker names once in `project.json`, paint per
 * version in `marks/<version-id>.json`, the versions as one list per part. These functions turn
 * one into the other, so the window can open and save through the project unchanged.
 *
 * Ids: the window gives new markers and comments random ids (`newId`), unique in the project, so
 * they are stored as they are. (Files moved in from v1 sidecars keep their counter ids, made
 * unique per project by the migration.)
 *
 * Pure: no I/O. The caller reads and writes the files (`project-store.ts`).
 */
import {
  newUniqueId,
  resolveStoredPath,
  toStoredPath,
  type PathApi,
  type RandomBytes,
} from './project-paths.js';
import {
  PROJECT_SCHEMA_VERSION,
  projectSchema,
  versionMarksSchema,
  type BodyRef,
  type Project,
  type ProjectBodyTree,
  type ProjectComment,
  type ProjectPart,
  type ProjectVersion,
  type VersionMark,
  type VersionMarks,
} from './project-schema.js';
import {
  annotationsSchema,
  type Annotations,
  type BodyFingerprint,
  type BodyTreeData,
  type PartItemData,
  type VersionLink,
} from './schema.js';

/** Whether two absolute paths are the same file (the app compares real paths; tests: `===`). */
export type SameFile = (a: string, b: string) => boolean;

const samePath: SameFile = (a, b) => a === b;

export interface VersionRef {
  readonly part: ProjectPart;
  readonly version: ProjectVersion;
}

/** The file a version points to, on this system. */
export function versionFile(folder: string, v: ProjectVersion, path: PathApi): string {
  return resolveStoredPath(folder, { path: v.path, ...(v.outside ? { outside: true } : {}) }, path);
}

function allVersions(project: Project): VersionRef[] {
  return project.models.flatMap((part) => part.versions.map((version) => ({ part, version })));
}

/** The version of `file` with exactly these contents. */
export function findVersion(
  project: Project,
  folder: string,
  file: string,
  contentHash: string,
  path: PathApi,
  same: SameFile = samePath,
): VersionRef | undefined {
  return allVersions(project).find(
    (r) =>
      r.version.contentHash === contentHash && same(versionFile(folder, r.version, path), file),
  );
}

/**
 * The version a file path stands for, when only the path is known: the one not overwritten
 * (the file's current contents), else the newest.
 */
export function versionAtPath(
  project: Project,
  folder: string,
  file: string,
  path: PathApi,
  same: SameFile = samePath,
): VersionRef | undefined {
  const here = allVersions(project).filter((r) => same(versionFile(folder, r.version, path), file));
  const ms = (r: VersionRef): number => Date.parse(r.version.added) || 0;
  here.sort(
    (a, b) => Number(!a.version.overwritten) - Number(!b.version.overwritten) || ms(a) - ms(b),
  );
  return here[here.length - 1];
}

function linkOf(folder: string, v: ProjectVersion, path: PathApi): VersionLink {
  const file = versionFile(folder, v, path);
  return {
    path: file,
    name: path.basename(file) || v.path,
    contentHash: v.contentHash,
    date: v.added,
    ...(v.overwritten ? { overwritten: true as const } : {}),
  };
}

// --- project → notes -----------------------------------------------------------------------------

/** Index of a body named by `ref` in `bodies` (name + path when unique, else the stored index). */
function bodyIndex(
  ref: BodyRef,
  bodies: readonly { name: string; path?: string | undefined }[] | undefined,
): number | undefined {
  if (bodies) {
    const hits: number[] = [];
    bodies.forEach((b, i) => {
      if (ref.name !== '' && b.name === ref.name && (b.path ?? undefined) === ref.path)
        hits.push(i);
    });
    if (hits.length === 1) return hits[0];
    if (ref.index !== undefined && ref.index < bodies.length) return ref.index;
    return undefined;
  }
  return ref.index;
}

function treeToV1(tree: ProjectBodyTree, bodies: VersionMarks['bodies']): BodyTreeData {
  const out: BodyTreeData['bodies'] = [];
  const taken = new Set<number>();
  for (const b of tree.bodies) {
    const i = bodyIndex(b.body, bodies);
    if (i === undefined || taken.has(i)) continue;
    taken.add(i);
    out.push({ body: i, parent: b.parent });
  }
  return {
    folders: tree.folders,
    bodies: out,
    assemblies: tree.assemblies,
  };
}

function treeFromV1(
  tree: BodyTreeData,
  bodies: readonly BodyFingerprint[] | undefined,
): ProjectBodyTree {
  return {
    folders: tree.folders,
    bodies: tree.bodies.map((b) => {
      const f = bodies?.[b.body];
      const body: BodyRef = f
        ? { name: f.name, ...(f.path !== undefined ? { path: f.path } : {}), index: b.body }
        : { name: '', index: b.body };
      return { body, parent: b.parent };
    }),
    assemblies: tree.assemblies,
  };
}

/**
 * A version as v1 notes: its marks' paint and entities, the part's comments (stored once), marker
 * names from the project and the part's body folders. Its place in the version list is not in the
 * notes: the window asks {@link versionFacts}. Markers a
 * comment names that have no paint on this version come without paint. Fields the window doesn't
 * know are left out (they stay in the project files).
 */
export function notesOf(
  project: Project,
  ref: VersionRef,
  marks: VersionMarks,
  folder: string,
  path: PathApi,
): Annotations {
  const { part, version } = ref;
  const meta = new Map(project.markers.map((m) => [m.id, m]));
  const comments = project.comments.filter((c) => c.modelId === part.id);
  const markers = marks.markers
    .filter((m) => meta.has(m.id))
    .map((m) => {
      const info = meta.get(m.id) as Project['markers'][number];
      return {
        id: m.id,
        name: info.name,
        color: info.color,
        visible: info.visible,
        entities: m.entities,
        paint: m.paint,
        ...(m.transfer ? { transfer: m.transfer } : {}),
      };
    });
  const listed = new Set(markers.map((m) => m.id));
  for (const c of comments) {
    for (const id of c.markerIds) {
      const info = meta.get(id);
      if (!info || listed.has(id)) continue;
      listed.add(id);
      markers.push({
        id,
        name: info.name,
        color: info.color,
        visible: info.visible,
        entities: [],
        paint: { faces: [] },
      });
    }
  }
  const file = versionFile(folder, version, path);
  // A comment never links to its own part (another version of it is not "another model").
  const ownFiles = partFileNames(part, folder, path);
  const raw = {
    schemaVersion: 1,
    model: {
      fileName: path.basename(file) || 'model',
      format: version.format,
      contentHash: version.contentHash,
      ...(version.meshHash ? { meshHash: version.meshHash } : {}),
    },
    ...(marks.tessellation ? { tessellation: marks.tessellation } : {}),
    markers,
    comments: comments.map((c) => {
      const linked = c.linkedModels?.length
        ? newestLinks(project, c.linkedModels, c.linkedParts, folder, path).filter(
            (n) => !ownFiles.has(n.toLowerCase()),
          )
        : [];
      const markerIds = c.markerIds.filter((id) => listed.has(id));
      return {
        ...withoutKeys(c, ['linkedModels', 'parts']),
        markerIds,
        ...(linked.length ? { linkedModels: linked } : {}),
        ...(c.parts?.length ? { parts: partsForMarkers(c.parts, markerIds) } : {}),
      };
    }),
    ...(part.bodyTree ? { bodyTree: treeToV1(part.bodyTree, marks.bodies) } : {}),
    ...(marks.bodies ? { bodies: marks.bodies } : {}),
  };
  // z.object drops what v1 doesn't know (modelId, linkedParts, newer fields).
  const r = annotationsSchema.safeParse(raw);
  if (!r.success) {
    const first = r.error.issues[0];
    throw new Error(
      `version notes don't fit the window's format: ${first ? `${first.path.join('.')}: ${first.message}` : 'invalid'}`,
    );
  }
  return r.data;
}

/** The file names (lower case) of a part's versions: what a link by name to this part can say. */
export function partFileNames(part: ProjectPart, folder: string, path: PathApi): Set<string> {
  return new Set(
    part.versions.map((v) => path.basename(versionFile(folder, v, path)).toLowerCase()),
  );
}

/**
 * A comment's links to other models, by file name: a name that stands for a linked part (any of
 * its versions) becomes that part's newest version, so the link follows the part to new versions.
 * Other names stay as they are.
 */
function newestLinks(
  project: Project,
  names: readonly string[],
  partIds: readonly string[] | undefined,
  folder: string,
  path: PathApi,
): string[] {
  if (!partIds?.length) return [...names];
  const out: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    const part = project.models.find(
      (m) =>
        partIds.includes(m.id) &&
        m.versions.some((v) => path.basename(versionFile(folder, v, path)).toLowerCase() === lower),
    );
    const first = part?.versions[0];
    const newest = first
      ? partVersions(project, folder, versionFile(folder, first, path), first.contentHash, path)
          ?.rows[0]?.name
      : undefined;
    const next = newest ?? name;
    if (!out.some((n) => n.toLowerCase() === next.toLowerCase())) out.push(next);
  }
  return out;
}

/**
 * A version's notes for the window: from its marks, or — a version without marks (listed by a link
 * before its first save) — its part's comments without paint. Undefined: nothing to show (the
 * window may bring notes over). A STEP version needs tessellation settings for that.
 */
export function versionNotes(
  project: Project,
  ref: VersionRef,
  marks: VersionMarks | null | undefined,
  folder: string,
  path: PathApi,
): Annotations | undefined {
  if (marks) return notesOf(project, ref, marks, folder, path);
  const { part, version } = ref;
  if (!project.comments.some((c) => c.modelId === part.id)) return undefined;
  const step = version.format === 'step';
  if (step && !project.tessellation) return undefined;
  const empty: VersionMarks = {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    versionId: version.id,
    contentHash: version.contentHash,
    ...(step && project.tessellation ? { tessellation: project.tessellation } : {}),
    markers: [],
  };
  return notesOf(project, ref, empty, folder, path);
}

// --- notes → project -----------------------------------------------------------------------------

export function newProject(
  folder: string,
  now: Date,
  path: PathApi,
  random?: RandomBytes,
): Project {
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: newUniqueId(new Set(), random),
    name: path.basename(path.resolve(folder)) || 'Project',
    created: now.toISOString(),
    models: [],
    markers: [],
    comments: [],
    chats: [],
  };
}

export interface ApplyNotesInput {
  /** The project so far; undefined = none yet (made now). */
  readonly project: Project | undefined;
  readonly folder: string;
  readonly path: PathApi;
  /** The model file (absolute). */
  readonly file: string;
  readonly notes: Annotations;
  readonly now: Date;
  readonly random?: RandomBytes;
  readonly same?: SameFile;
  /** This version's marks before the save (fields this app doesn't know are kept). */
  readonly oldMarks?: VersionMarks | undefined;
  /**
   * Project ids of the comments the window was shown (and made) for this file. Only those can be
   * deleted by leaving them out; others (added to the part meanwhile, e.g. by joining another
   * part) stay. Undefined: the notes hold all of the part's comments.
   */
  readonly windowComments?: ReadonlySet<string> | undefined;
}

export interface ApplyNotesResult {
  readonly project: Project;
  readonly marks: VersionMarks;
  readonly partId: string;
  readonly versionId: string;
  /**
   * Markers taken off this version that no comment names. Still listed in the project: other
   * versions may hold them. The caller checks those and calls {@link forgetMarkers}.
   */
  readonly droppedMarkers: string[];
}

interface Draft {
  project: Project;
  parts: ProjectPart[];
  taken: Set<string>;
}

function draftOf(project: Project): Draft {
  const parts = project.models.map((m) => ({ ...m, versions: m.versions.map((v) => ({ ...v })) }));
  const taken = new Set<string>([
    ...parts.flatMap((m) => [m.id, ...m.versions.map((v) => v.id)]),
    ...project.chats.map((c) => c.id),
    project.id,
  ]);
  return { project: { ...project, models: parts }, parts, taken };
}

function refById(d: Draft, versionId: string): VersionRef | undefined {
  for (const part of d.parts) {
    const version = part.versions.find((v) => v.id === versionId);
    if (version) return { part, version };
  }
  return undefined;
}

function partName(file: string, path: PathApi): string {
  const base = path.basename(file);
  return base.replace(/\.(step|stp|stl|3mf)$/i, '') || base || 'Part';
}

function formatOf(name: string): ProjectVersion['format'] {
  const n = name.toLowerCase();
  if (n.endsWith('.stl')) return 'stl';
  if (n.endsWith('.3mf')) return '3mf';
  return 'step';
}

function addPart(d: Draft, file: string, path: PathApi, random?: RandomBytes): ProjectPart {
  const part: ProjectPart = {
    id: newUniqueId(d.taken, random),
    name: partName(file, path),
    versions: [],
  };
  d.parts.push(part);
  return part;
}

function isAncestor(part: ProjectPart, maybe: string, of: string): boolean {
  const byId = new Map(part.versions.map((v) => [v.id, v]));
  const seen = new Set<string>();
  for (
    let at: string | undefined = of;
    at !== undefined && !seen.has(at);
    at = byId.get(at)?.from
  ) {
    if (at === maybe) return true;
    seen.add(at);
  }
  return false;
}

/** Move a part's only version into another part (the part goes; its comments follow). */
function mergePartInto(d: Draft, from: ProjectPart, into: ProjectPart): void {
  into.versions.push(...from.versions);
  if (!into.bodyTree && from.bodyTree) into.bodyTree = from.bodyTree;
  d.parts.splice(d.parts.indexOf(from), 1);
  d.project = {
    ...d.project,
    comments: d.project.comments.map((c) => {
      const moved = c.modelId === from.id ? { ...c, modelId: into.id } : c;
      // Links to the part that went now point to the part it joined.
      return c.linkedParts?.includes(from.id)
        ? {
            ...moved,
            linkedParts: [...new Set(c.linkedParts.map((id) => (id === from.id ? into.id : id)))],
          }
        : moved;
    }),
  };
}

/**
 * Put `link` (v1 `earlier[0]`) in as `ref`'s parent. A link no version matches becomes a version
 * known only from the link. Circles are not made. `unlinked` without a link: `ref` was removed
 * from its versions → it leaves its part (a part of its own) unless it is the part's only one.
 */
function setParent(
  d: Draft,
  ref: VersionRef,
  link: VersionLink | undefined,
  /** The "removed from its versions" date (v1 `unlinked`), if set. */
  unlinked: string | undefined,
  folder: string,
  path: PathApi,
  same: SameFile,
  random?: RandomBytes,
): void {
  const { version } = ref;
  let part = ref.part;
  if (!link) {
    if (unlinked === undefined) return;
    version.unlinked ??= unlinked;
    if (version.from === undefined) return;
    delete version.from;
    if (part.versions.length > 1) {
      part.versions.splice(part.versions.indexOf(version), 1);
      const own = addPart(d, versionFile(folder, version, path), path, random);
      own.versions.push(version);
    }
    return;
  }
  const file = path.isAbsolute(link.path) ? path.resolve(link.path) : link.path;
  const all = d.parts.flatMap((p) => p.versions.map((v) => ({ part: p, version: v })));
  const sameHash = all.filter((r) => r.version.contentHash === link.contentHash);
  let parent =
    sameHash.find((r) => same(versionFile(folder, r.version, path), file)) ?? sameHash[0];
  if (parent?.version.id === version.id) return;
  if (!parent) {
    const v: ProjectVersion = {
      id: newUniqueId(d.taken, random),
      ...(path.isAbsolute(file)
        ? toStoredPath(folder, file, path)
        : { path: link.name.replace(/[\\/]/g, '_') }),
      contentHash: link.contentHash,
      format: formatOf(link.name),
      added: link.date,
      ...(link.overwritten ? { overwritten: true as const } : {}),
    };
    part.versions.push(v);
    parent = { part, version: v };
  } else if (link.overwritten) {
    parent.version.overwritten = true;
  }
  // Linked again: the "removed from its versions" marks go.
  delete version.unlinked;
  delete parent.version.unlinked;
  if (version.from === parent.version.id) return;
  if (parent.part !== part) {
    // Linked into another part: the version moves there with the versions made from it. A part
    // left empty goes (its comments come along); else its comments stay and the window's copy
    // is added to the new part (nothing is lost on either side).
    const moving = new Set([version.id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const v of part.versions) {
        if (v.from !== undefined && moving.has(v.from) && !moving.has(v.id)) {
          moving.add(v.id);
          grew = true;
        }
      }
    }
    if (moving.size === part.versions.length) {
      mergePartInto(d, part, parent.part);
    } else {
      const keep = part.versions.filter((v) => !moving.has(v.id));
      parent.part.versions.push(...part.versions.filter((v) => moving.has(v.id)));
      part.versions.splice(0, part.versions.length, ...keep);
    }
    part = parent.part;
  }
  if (isAncestor(part, version.id, parent.version.id)) return; // would make a circle
  version.from = parent.version.id;
}

/**
 * A comment's part requests with their target markers cut to the markers the comment still names
 * (v1 notes refuse a part aimed at a marker its comment doesn't name).
 */
function partsForMarkers(
  parts: readonly PartItemData[],
  markerIds: readonly string[],
): PartItemData[] {
  const keep = new Set(markerIds);
  return parts.map((p) =>
    p.target && p.target.markerIds.some((m) => !keep.has(m))
      ? { ...p, target: { ...p.target, markerIds: p.target.markerIds.filter((m) => keep.has(m)) } }
      : p,
  );
}

function withoutKeys<T extends object>(o: T, keys: readonly string[]): T {
  const drop = new Set(keys);
  return Object.fromEntries(Object.entries(o).filter(([k]) => !drop.has(k))) as T;
}

/** Write a version's notes into the project. Pure: returns the new project and marks. */
export function applyNotes(input: ApplyNotesInput): ApplyNotesResult {
  const { folder, path, file, notes, now, random, oldMarks } = input;
  const same = input.same ?? samePath;
  const d = draftOf(input.project ?? newProject(folder, now, path, random));
  const at = now.toISOString();
  const hash = notes.model.contentHash;

  let ref = findVersion(d.project, folder, file, hash, path, same);
  if (!ref) {
    const version: ProjectVersion = {
      id: newUniqueId(d.taken, random),
      ...toStoredPath(folder, file, path),
      contentHash: hash,
      ...(notes.model.meshHash ? { meshHash: notes.model.meshHash } : {}),
      format: notes.model.format,
      added: at,
    };
    const part = addPart(d, file, path, random);
    part.versions.push(version);
    ref = { part, version };
  } else if (notes.model.meshHash) {
    ref.version.meshHash = notes.model.meshHash;
  }
  // Links between versions are not in the notes: they change only through `linkAsNewer` & co.
  const { part, version } = ref;
  const partId = part.id;

  // Markers' names and colours (fields this app doesn't know kept).
  const markerMeta = new Map(d.project.markers.map((m) => [m.id, m]));
  for (const m of notes.markers) {
    const id = m.id;
    markerMeta.set(id, {
      ...(markerMeta.get(id) ?? {}),
      id,
      name: m.name,
      color: m.color,
      visible: m.visible,
    });
  }

  // Comments: the notes hold all of this part's comments.
  const partFiles = new Map<string, string>();
  for (const p of d.parts) {
    for (const v of p.versions)
      partFiles.set(path.basename(versionFile(folder, v, path)).toLowerCase(), p.id);
  }
  const oldComments = new Map(d.project.comments.map((c) => [c.id, c]));
  const kept = new Set<string>();
  const updated: ProjectComment[] = [];
  for (const c of notes.comments) {
    const id = c.id;
    kept.add(id);
    const old = oldComments.get(id);
    const oldReplies = new Map((old?.replies ?? []).map((r) => [r.id, r]));
    // Links naming a version of this comment's own part are dropped: a link is to another part.
    const linkedModels = (c.linkedModels ?? []).filter(
      (n) => partFiles.get(n.toLowerCase()) !== partId,
    );
    const linkedParts = [
      ...new Set(
        linkedModels
          .map((n) => partFiles.get(n.toLowerCase()))
          .filter((p): p is string => p !== undefined),
      ),
    ];
    const base = withoutKeys(old ?? ({} as ProjectComment), [
      'note',
      'replies',
      'linkedModels',
      'linkedParts',
      'awaitingConfirm',
      'parts',
    ]);
    updated.push({
      ...base,
      id,
      modelId: partId,
      text: c.text,
      markerIds: [...c.markerIds],
      status: c.status,
      author: c.author,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      ...(c.replies?.length
        ? { replies: c.replies.map((r) => ({ ...(oldReplies.get(r.id) ?? {}), ...r })) }
        : {}),
      ...(linkedModels.length ? { linkedModels } : {}),
      ...(linkedParts.length ? { linkedParts } : {}),
      ...(c.awaitingConfirm ? { awaitingConfirm: true as const } : {}),
      ...(c.parts?.length ? { parts: c.parts } : {}),
    });
  }
  // Only comments the window was shown can be deleted by leaving them out.
  const known = input.windowComments;
  const deleted = (c: ProjectComment): boolean =>
    c.modelId === partId && !kept.has(c.id) && (known ? known.has(c.id) : true);
  const comments = [
    ...d.project.comments.filter((c) => !kept.has(c.id) && !deleted(c)),
    ...updated,
  ].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));

  // Paint of this version.
  const oldMarkById = new Map((oldMarks?.markers ?? []).map((m) => [m.id, m]));
  const markMarkers: VersionMark[] = notes.markers.map((m) => {
    const id = m.id;
    const old = withoutKeys(oldMarkById.get(id) ?? ({} as VersionMark), ['transfer']);
    return {
      ...old,
      id,
      entities: m.entities,
      paint: m.paint,
      ...(m.transfer ? { transfer: m.transfer } : {}),
    };
  });
  const oldExtra = withoutKeys(oldMarks ?? ({} as VersionMarks), [
    'meshHash',
    'tessellation',
    'bodies',
  ]);
  const marks = versionMarksSchema.parse({
    ...oldExtra,
    schemaVersion: PROJECT_SCHEMA_VERSION,
    versionId: version.id,
    contentHash: hash,
    ...(notes.model.meshHash ? { meshHash: notes.model.meshHash } : {}),
    ...(notes.tessellation ? { tessellation: notes.tessellation } : {}),
    ...(notes.bodies ? { bodies: notes.bodies } : {}),
    markers: markMarkers,
  });

  // Body folders per part.
  if (notes.bodyTree) part.bodyTree = treeFromV1(notes.bodyTree, notes.bodies);
  else delete part.bodyTree;

  const named = new Set(comments.flatMap((c) => c.markerIds));
  const nowHeld = new Set(markMarkers.map((m) => m.id));
  const droppedMarkers = [...oldMarkById.keys()].filter((id) => !nowHeld.has(id) && !named.has(id));

  const project = projectSchema.parse({
    ...d.project,
    ...(notes.tessellation ? { tessellation: notes.tessellation } : {}),
    models: d.parts,
    markers: [...markerMeta.values()],
    comments,
  });
  return { project, marks, partId, versionId: version.id, droppedMarkers };
}

/** A model file with its contents. */
export interface VersionFileRef {
  readonly file: string;
  readonly contentHash: string;
  readonly format: ProjectVersion['format'];
}

/**
 * File ▸ Add file… → Separate part (or the first model of an empty project): the file is listed at
 * once as a part of its own, so the version list and the next Add file know it. Nothing changes
 * when the project already lists these contents at that path.
 */
export function addFileAsPart(
  project: Project | undefined,
  f: VersionFileRef,
  opts: {
    readonly folder: string;
    readonly path: PathApi;
    readonly now: Date;
    readonly random?: RandomBytes;
    readonly same?: SameFile;
  },
): Project {
  const { folder, path, now, random } = opts;
  const base = project ?? newProject(folder, now, path, random);
  if (findVersion(base, folder, f.file, f.contentHash, path, opts.same ?? samePath)) return base;
  const d = draftOf(base);
  const part = addPart(d, f.file, path, random);
  part.versions.push({
    id: newUniqueId(d.taken, random),
    ...toStoredPath(folder, f.file, path),
    contentHash: f.contentHash,
    format: f.format,
    added: now.toISOString(),
  });
  return projectSchema.parse({ ...d.project, models: d.parts });
}

/** Take markers out of the project list (no version holds them and no comment names them). */
export function forgetMarkers(project: Project, ids: readonly string[]): Project {
  if (ids.length === 0) return project;
  const named = new Set(project.comments.flatMap((c) => c.markerIds));
  const drop = new Set(ids.filter((id) => !named.has(id)));
  return { ...project, markers: project.markers.filter((m) => !drop.has(m.id)) };
}

// --- the version list (Versions ▾) ---------------------------------------------------------------

/** One version of a part, for the Versions ▾ menu. */
export interface PartVersionRow {
  readonly id: string;
  /** Its file on this system. */
  readonly file: string;
  readonly name: string;
  readonly contentHash: string;
  /** When it was added (ISO). */
  readonly added: string;
  /** The version it was made from (an id in the same list), if any. */
  readonly from?: string;
  /** A newer version was saved over its file: these contents are gone from disk. */
  readonly overwritten?: true;
  /** The version asked about (the shown one). */
  readonly shown: boolean;
}

/** The part a version belongs to, with all of its versions, newest first. */
export interface PartVersionList {
  readonly partId: string;
  readonly partName: string;
  readonly rows: readonly PartVersionRow[];
}

/** How many versions back `v` was made (0 = from none); stops at a circle. */
function depthOf(byId: ReadonlyMap<string, ProjectVersion>, v: ProjectVersion): number {
  const seen = new Set<string>([v.id]);
  let n = 0;
  for (let at = v.from; at !== undefined;) {
    const p = byId.get(at);
    if (!p || seen.has(p.id)) break;
    seen.add(p.id);
    n++;
    at = p.from;
  }
  return n;
}

/**
 * All versions of the part that holds the version of `file` with these contents, newest first
 * (by the time added; a version before the one it was made from never comes first). Undefined
 * when the project doesn't list that version.
 */
export function partVersions(
  project: Project,
  folder: string,
  file: string,
  contentHash: string,
  path: PathApi,
  same: SameFile = samePath,
): PartVersionList | undefined {
  const ref = findVersion(project, folder, file, contentHash, path, same);
  if (!ref) return undefined;
  const byId = new Map(ref.part.versions.map((v) => [v.id, v]));
  const ms = (v: ProjectVersion): number => Date.parse(v.added) || 0;
  // A version counts as no newer than any version made from it (directly or further down), so
  // it never comes above one of them, even when it was added to the project later.
  const latest = new Map(ref.part.versions.map((v) => [v.id, ms(v)]));
  for (const v of ref.part.versions) {
    const seen = new Set<string>([v.id]);
    for (let at = v.from; at !== undefined && !seen.has(at); at = byId.get(at)?.from) {
      seen.add(at);
      latest.set(at, Math.min(latest.get(at) ?? 0, ms(v)));
    }
  }
  const time = (v: ProjectVersion): number => latest.get(v.id) ?? 0;
  const sorted = [...ref.part.versions].sort(
    (a, b) => time(b) - time(a) || depthOf(byId, b) - depthOf(byId, a) || ms(b) - ms(a),
  );
  return {
    partId: ref.part.id,
    partName: ref.part.name,
    rows: sorted.map((v) => {
      const f = versionFile(folder, v, path);
      return {
        id: v.id,
        file: f,
        name: path.basename(f) || v.path,
        contentHash: v.contentHash,
        added: v.added,
        ...(v.from !== undefined && byId.has(v.from) ? { from: v.from } : {}),
        ...(v.overwritten ? { overwritten: true as const } : {}),
        shown: v.id === ref.version.id,
      };
    }),
  };
}

/**
 * Remove from versions…: take a version out of its part, like taking a node out of a list — the
 * versions made from it are now made from its own earlier version (or from none). It moves to a
 * part of its own with the "removed" mark (left out of "new version?" guesses), its marks stay.
 * The part's comments stay with the part. Adding it again as a new version (Add file… → New
 * version) merges its part back and clears the mark.
 */
export function removeFromVersions(
  project: Project,
  versionId: string,
  now: Date,
  folder: string,
  path: PathApi,
  random?: RandomBytes,
): Project {
  const d = draftOf(project);
  const ref = refById(d, versionId);
  if (!ref) throw new Error('not a version of this project');
  const { part, version } = ref;
  const parent = version.from !== undefined && part.versions.some((v) => v.id === version.from);
  for (const v of part.versions) {
    if (v.from !== version.id) continue;
    if (parent) v.from = version.from;
    else delete v.from;
  }
  delete version.from;
  version.unlinked = now.toISOString();
  if (part.versions.length > 1) {
    part.versions.splice(part.versions.indexOf(version), 1);
    const own = addPart(d, versionFile(folder, version, path), path, random);
    own.versions.push(version);
  }
  return projectSchema.parse({ ...d.project, models: d.parts });
}

/**
 * Locate…: a version's file was moved or renamed; it is at `file` now (the caller checked its
 * contents). Refused when another version of the project already stands for that file with the
 * same contents.
 */
export function relocateVersion(
  project: Project,
  versionId: string,
  file: string,
  folder: string,
  path: PathApi,
  same: SameFile = samePath,
): Project {
  const d = draftOf(project);
  const ref = refById(d, versionId);
  if (!ref) throw new Error('not a version of this project');
  const other = findVersion(d.project, folder, file, ref.version.contentHash, path, same);
  if (other && other.version.id !== versionId)
    throw new Error(`${path.basename(file)} is already listed as another version`);
  const stored = toStoredPath(folder, file, path);
  ref.version.path = stored.path;
  if (stored.outside) ref.version.outside = true;
  else delete ref.version.outside;
  delete ref.version.overwritten;
  return projectSchema.parse({ ...d.project, models: d.parts });
}

// --- versions in the project (the window asks these instead of walking files) -------------------

/** What the project knows about the version of a file with given contents. */
export interface VersionFacts {
  /** The version with exactly these contents at this path; undefined = not listed. */
  readonly version?: VersionRef;
  /** The version it was made from. */
  readonly parent?: VersionRef;
  /** The newest version made from it. */
  readonly newer?: VersionRef;
  /**
   * Not listed with these contents, but the project lists the file with other contents (not
   * marked overwritten): the file was saved over since — these contents are a new version of it.
   */
  readonly replaced?: VersionRef;
}

export function versionFacts(
  project: Project,
  folder: string,
  file: string,
  contentHash: string,
  path: PathApi,
  same: SameFile = samePath,
): VersionFacts {
  const ref = findVersion(project, folder, file, contentHash, path, same);
  if (!ref) {
    const at = versionAtPath(project, folder, file, path, same);
    return at && !at.version.overwritten && at.version.contentHash !== contentHash
      ? { replaced: at }
      : {};
  }
  const { part, version } = ref;
  const from = version.from;
  const parentVersion = from === undefined ? undefined : part.versions.find((v) => v.id === from);
  const ms = (v: ProjectVersion): number => Date.parse(v.added) || 0;
  const newer = part.versions.filter((v) => v.from === version.id).sort((a, b) => ms(b) - ms(a))[0];
  return {
    version: ref,
    ...(parentVersion ? { parent: { part, version: parentVersion } } : {}),
    ...(newer ? { newer: { part, version: newer } } : {}),
  };
}

/** `maybe` is `of` or one of the versions `of` was made from (directly or further back). */
export function isEarlierVersion(
  project: Project,
  folder: string,
  maybe: { readonly file: string; readonly contentHash: string },
  of: { readonly file: string; readonly contentHash: string },
  path: PathApi,
  same: SameFile = samePath,
): boolean {
  const a = findVersion(project, folder, maybe.file, maybe.contentHash, path, same);
  const b = findVersion(project, folder, of.file, of.contentHash, path, same);
  return !!a && !!b && a.part === b.part && isAncestor(b.part, a.version.id, b.version.id);
}

/** How {@link linkAsNewer} went. */
export type LinkOutcome =
  /**
   * Linked; `before` = the version it was made from until now, when it was another one.
   * `removedLinks`: comments of the part that linked to a file now in it lost those links.
   */
  | {
      readonly kind: 'linked';
      readonly before?: VersionRef;
      readonly removedLinks?: { readonly count: number; readonly partName: string };
    }
  /** Already made from that version: nothing changed. */
  | { readonly kind: 'already' }
  /** `newer` is that version, or one it was made from: not linked (a version list has no circles). */
  | { readonly kind: 'circle' };

/**
 * `newer` (listed now when it isn't yet) becomes a version made from `parent` (which must be
 * listed). It moves into `parent`'s part with the versions made from it; a part left empty merges
 * (its comments follow). A "removed from its versions" mark on either goes. A file saved over in
 * place is not linked: it stays one version ({@link replaceContents}).
 */
export function linkAsNewer(
  project: Project | undefined,
  newer: VersionFileRef,
  parent: { readonly file: string; readonly contentHash: string },
  opts: {
    readonly folder: string;
    readonly path: PathApi;
    readonly now: Date;
    readonly random?: RandomBytes;
    readonly same?: SameFile;
  },
): { readonly project: Project; readonly outcome: LinkOutcome } {
  const { folder, path, now, random } = opts;
  const same = opts.same ?? samePath;
  const base = project ?? newProject(folder, now, path, random);
  const d = draftOf(base);
  const p = findVersion(d.project, folder, parent.file, parent.contentHash, path, same);
  if (!p) throw new Error('The earlier version is not listed in the project');
  let n = findVersion(d.project, folder, newer.file, newer.contentHash, path, same);
  if (n?.version.id === p.version.id) return { project: base, outcome: { kind: 'circle' } };
  if (n && n.part === p.part && isAncestor(p.part, n.version.id, p.version.id))
    return { project: base, outcome: { kind: 'circle' } };
  if (n?.version.from === p.version.id && !n.version.unlinked && !p.version.unlinked)
    return { project: base, outcome: { kind: 'already' } };
  const before =
    n?.version.from !== undefined && n.version.from !== p.version.id
      ? n.part.versions.find((v) => v.id === n?.version.from)
      : undefined;
  const beforeRef = before && n ? { part: n.part, version: before } : undefined;
  if (!n) {
    const version: ProjectVersion = {
      id: newUniqueId(d.taken, random),
      ...toStoredPath(folder, newer.file, path),
      contentHash: newer.contentHash,
      format: newer.format,
      added: now.toISOString(),
    };
    const part = addPart(d, newer.file, path, random);
    part.versions.push(version);
    n = { part, version };
  }
  const link = linkOf(folder, p.version, path);
  setParent(d, n, link, undefined, folder, path, same, random);
  const removed = dropOwnPartLinks(d, p.part, folder, path);
  const out = projectSchema.parse({ ...d.project, models: d.parts });
  return {
    project: out,
    outcome: {
      kind: 'linked',
      ...(beforeRef ? { before: beforeRef } : {}),
      ...(removed > 0 ? { removedLinks: { count: removed, partName: p.part.name } } : {}),
    },
  };
}

/**
 * Two parts became one (or versions moved in): `part`'s comments that linked to a file now in it
 * lose that link (a comment links to other parts only). Returns how many links went.
 */
function dropOwnPartLinks(d: Draft, part: ProjectPart, folder: string, path: PathApi): number {
  const own = partFileNames(part, folder, path);
  let removed = 0;
  d.project = {
    ...d.project,
    comments: d.project.comments.map((c) => {
      if (c.modelId !== part.id || (!c.linkedModels?.length && !c.linkedParts?.length)) return c;
      const names = (c.linkedModels ?? []).filter((n) => !own.has(n.toLowerCase()));
      const parts = (c.linkedParts ?? []).filter((id) => id !== part.id);
      const gone = (c.linkedModels?.length ?? 0) - names.length;
      if (gone === 0 && parts.length === (c.linkedParts?.length ?? 0)) return c;
      removed += Math.max(gone, 1); // only `linkedParts` changed: still one link
      return {
        ...withoutKeys(c, ['linkedModels', 'linkedParts']),
        ...(names.length ? { linkedModels: names } : {}),
        ...(parts.length ? { linkedParts: parts } : {}),
      };
    }),
  };
  return removed;
}

/**
 * A version's file was saved over in place (one file name = one version): the version with
 * `oldHash` at `file` now stands for `newHash` — same id, place in the list, links and comments.
 * Its marks belong to the old geometry; the caller moves them (or drops them) itself. Refused when
 * another version already lists `file` with `newHash`.
 */
export function replaceContents(
  project: Project,
  folder: string,
  file: string,
  oldHash: string,
  newHash: string,
  path: PathApi,
  same: SameFile = samePath,
): { readonly project: Project; readonly versionId: string } {
  const d = draftOf(project);
  const ref = findVersion(d.project, folder, file, oldHash, path, same);
  if (!ref) throw new Error('not a version of this project');
  if (findVersion(d.project, folder, file, newHash, path, same))
    throw new Error(`${path.basename(file)} is already listed with these contents`);
  ref.version.contentHash = newHash;
  delete ref.version.meshHash;
  delete ref.version.overwritten;
  return {
    project: projectSchema.parse({ ...d.project, models: d.parts }),
    versionId: ref.version.id,
  };
}
