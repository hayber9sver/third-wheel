/**
 * v1 sidecars → v2 project (docs/file-format.md § Moving from sidecars). The old sidecars are
 * only read, never changed (an older app still opens them).
 *
 * - **Every sidecar of the folder at once** (`collectSidecars`), plus sidecars reached through
 *   version chains outside it (`../exports/part_v2.step`).
 * - **Versions:** a sidecar's `versions.earlier[0]` is its parent (the truth); the rest of
 *   `earlier` fills in parents of versions whose own notes are gone. A link finds its version by
 *   **content hash first**, then path — so a folder moved after the links were made still lines up.
 *   Linked versions form one part; unlinked sidecars are separate parts. A version only known from
 *   a link (no notes, file moved) is kept as a version without marks. Earlier contents of a file
 *   saved over in place are left out (one file name = one version). Self-links and circles are
 *   cut, never followed.
 * - **Markers:** name / colour from the newest version that has the marker; paint per version in
 *   its marks file. v1 ids come from a counter: the same id is one marker only when it came down
 *   the chain from one version; otherwise (another part, two variants that each added "m3") the
 *   second gets a new id.
 * - **Comments once:** each version's sidecar held its own copy; copies are one comment when id
 *   **and** creation time match (else the second gets a new id). A comment the user deleted in a
 *   later version (one made after the comment, however many versions down) is not brought back. Of
 *   the copies kept, the last edited wins (tie: the newest version).
 * - Merging into an existing project (`existing`) skips sidecars already merged and links new
 *   ones to the project's versions by the same rules.
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
  isAbsoluteStoredPath,
  projectSchema,
  versionMarksSchema,
  type BodyRef,
  type Project,
  type ProjectBodyTree,
  type ProjectComment,
  type ProjectMarker,
  type ProjectPart,
  type ProjectVersion,
  type VersionMarks,
} from './project-schema.js';
import { MAX_PROJECT_FILE_BYTES, errorCode, type ProjectFs } from './project-store.js';
import {
  MAX_VERSION_LINKS,
  parseAnnotationsJson,
  type Annotations,
  type ModelFormat,
  type VersionLink,
} from './schema.js';

/** A v1 sidecar and the model file it belongs to (absolute path). */
export interface SidecarInput {
  readonly modelPath: string;
  readonly data: Annotations;
}

export interface MigrateOptions {
  /** The project folder. */
  readonly folder: string;
  readonly sidecars: readonly SidecarInput[];
  readonly path: PathApi;
  readonly now: Date;
  readonly random?: RandomBytes;
  /** Merge into this project instead of making a new one. */
  readonly existing?: Project;
}

export interface MigrateResult {
  readonly project: Project;
  /** Marks files to write (one per version that had notes). */
  readonly marks: VersionMarks[];
  readonly report: {
    /** Sidecars taken in (already merged ones skipped). */
    readonly sidecars: number;
    readonly newParts: number;
    readonly newVersions: number;
    /** Versions known only from a link (no notes): shown as "not found" until located. */
    readonly versionsWithoutNotes: number;
    /** Comments the user had deleted in a newer version (not brought back). */
    readonly deletedComments: number;
    /** Marker ids changed because another part used them. */
    readonly renamedMarkers: number;
    /** Links not followed: to itself or making a circle. */
    readonly cutLinks: number;
  };
}

interface Node {
  readonly key: string;
  /** Absolute path, or the raw v1 path when it isn't absolute on this system. */
  readonly file: string;
  readonly contentHash: string;
  readonly name: string;
  meshHash?: string;
  format: ModelFormat;
  added?: string;
  overwritten?: true;
  sidecar?: Annotations;
  parent?: Node;
  /** Set for versions already in `existing`. */
  versionId?: string;
  partId?: string;
}

/** ISO time → ms (offsets compared correctly; a bad one sorts first). */
const ms = (iso: string | undefined): number => {
  const t = Date.parse(iso ?? '');
  return Number.isNaN(t) ? 0 : t;
};

function formatOf(name: string): ModelFormat {
  const n = name.toLowerCase();
  if (n.endsWith('.stl')) return 'stl';
  if (n.endsWith('.3mf')) return '3mf';
  return 'step';
}

/** Build the project (or merge into `existing`). Pure; the caller writes the result. */
export function migrateSidecars(opts: MigrateOptions): MigrateResult {
  const { folder, path, now, random, existing } = opts;
  const at = now.toISOString();
  const nodes: Node[] = [];
  const keyOf = (file: string, hash: string): string => `${file}\n${hash}`;
  const byKey = new Map<string, Node>();
  const add = (n: Node): Node => {
    nodes.push(n);
    byKey.set(n.key, n);
    return n;
  };
  const absolute = (file: string): string => (path.isAbsolute(file) ? path.resolve(file) : file);

  // Versions already in the project.
  for (const part of existing?.models ?? []) {
    for (const v of part.versions) {
      const file = resolveStoredPath(
        folder,
        { path: v.path, ...(v.outside ? { outside: true as const } : {}) },
        path,
      );
      add({
        key: keyOf(file, v.contentHash),
        file,
        contentHash: v.contentHash,
        name: path.basename(file),
        format: v.format,
        added: v.added,
        ...(v.overwritten ? { overwritten: true as const } : {}),
        versionId: v.id,
        partId: part.id,
      });
    }
  }
  if (existing) {
    for (const part of existing.models) {
      for (const v of part.versions) {
        if (!v.from) continue;
        const child = nodes.find((n) => n.versionId === v.id);
        const parent = nodes.find((n) => n.versionId === v.from);
        if (child && parent) child.parent = parent;
      }
    }
  }

  // Sidecars (skipping ones merged before and repeats of the same file).
  const merged = new Set(
    (existing?.sidecars ?? []).map((s) =>
      keyOf(
        resolveStoredPath(
          folder,
          { path: s.path, ...(isAbsoluteStoredPath(s.path) ? { outside: true as const } : {}) },
          path,
        ),
        s.contentHash,
      ),
    ),
  );
  const taken: Node[] = [];
  for (const s of opts.sidecars) {
    const file = absolute(s.modelPath);
    const key = keyOf(file, s.data.model.contentHash);
    if (merged.has(key)) continue;
    const known = byKey.get(key);
    // Already a version of the project (its marks are the truth) or a repeat: skip.
    if (known?.sidecar || known?.versionId) continue;
    const n =
      known ??
      add({
        key,
        file,
        contentHash: s.data.model.contentHash,
        name: path.basename(file),
        format: s.data.model.format,
      });
    n.sidecar = s.data;
    if (s.data.model.meshHash) n.meshHash = s.data.model.meshHash;
    taken.push(n);
  }

  /** The version a link means: same contents, same path preferred; else a new version from the link. */
  const nodeFor = (link: VersionLink): Node => {
    const file = absolute(link.path);
    const same = nodes.filter((n) => n.contentHash === link.contentHash);
    const found = same.find((n) => n.file === file) ?? same[0];
    if (found) return found;
    return add({
      key: keyOf(file, link.contentHash),
      file,
      contentHash: link.contentHash,
      name: link.name,
      format: formatOf(link.name),
      added: link.date,
      ...(link.overwritten ? { overwritten: true as const } : {}),
    });
  };
  let cutLinks = 0;
  const isAncestor = (maybe: Node, of: Node): boolean => {
    let steps = 0;
    for (let n: Node | undefined = of; n && steps <= nodes.length; n = n.parent, steps++) {
      if (n === maybe) return true;
    }
    return false;
  };
  const link = (child: Node, parent: Node): void => {
    if (child.parent) return;
    if (parent === child || isAncestor(child, parent)) {
      cutLinks++;
      return;
    }
    child.parent = parent;
  };

  // Parents from each sidecar's truth (earlier[0]) first, then the caches.
  for (const n of taken) {
    const first = n.sidecar?.versions?.earlier?.[0];
    if (!first) continue;
    n.added ??= first.date;
    link(n, nodeFor(first));
  }
  for (const n of taken) {
    const earlier = (n.sidecar?.versions?.earlier ?? []).slice(0, MAX_VERSION_LINKS);
    let child: Node = n;
    for (const l of earlier) {
      const p = nodeFor(l);
      if (child !== n && !child.parent && !child.sidecar) link(child, p);
      child = p;
    }
  }

  // When a version was added: its link date; a first version: its oldest note, else its first child.
  for (const n of nodes) {
    if (n.added) continue;
    const times = [
      ...(n.sidecar?.comments ?? []).map((c) => c.createdAt),
      ...nodes.filter((c) => c.parent === n && c.added).map((c) => c.added as string),
    ].sort((a, b) => ms(a) - ms(b));
    n.added = times[0] ?? at;
  }

  // One file name = one version: earlier contents of a file saved over in place (known only from a
  // link, no notes of their own) are left out; versions made from them are made from their parent.
  const gone = new Set(nodes.filter((n) => n.overwritten && !n.sidecar && !n.versionId));
  if (gone.size > 0) {
    for (const n of nodes) {
      let p = n.parent;
      for (let steps = 0; p && gone.has(p) && steps <= nodes.length; steps++) p = p.parent;
      if (p) n.parent = p;
      else delete n.parent;
    }
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i] as Node;
      if (!gone.has(n)) continue;
      nodes.splice(i, 1);
      byKey.delete(n.key);
    }
  }

  // Parts: a version's part is its root's part.
  const takenIds = new Set<string>([
    ...(existing?.models.flatMap((m) => [m.id, ...m.versions.map((v) => v.id)]) ?? []),
    ...(existing?.chats.map((c) => c.id) ?? []),
  ]);
  const rootOf = (n: Node): Node => {
    let r = n;
    let steps = 0;
    while (r.parent && steps++ < nodes.length) r = r.parent;
    return r;
  };
  const parts = new Map<string, ProjectPart>(
    (existing?.models ?? []).map((m) => [m.id, { ...m, versions: [...m.versions] }]),
  );
  let newParts = 0;
  let newVersions = 0;
  let versionsWithoutNotes = 0;
  // Oldest first, so parents get ids (and parts) before their children.
  const depth = (n: Node): number => {
    let d = 0;
    for (let at = n.parent; at && d <= nodes.length; at = at.parent) d++;
    return d;
  };
  // Same time (a version known only from a link carries its child's link date): parents first.
  const ordered = [...nodes].sort((a, b) => ms(a.added) - ms(b.added) || depth(a) - depth(b));
  for (const n of ordered) {
    if (!n.partId) {
      const root = rootOf(n);
      // A part already in the project anywhere above this version.
      let up: Node | undefined = n;
      while (up && !up.partId && up !== root) up = up.parent;
      if (up?.partId) n.partId = up.partId;
      else if (root.partId) n.partId = root.partId;
      else {
        const id = newUniqueId(takenIds, random);
        root.partId = id;
        n.partId = id;
        parts.set(id, {
          id,
          name: path.basename(root.name).replace(/\.(step|stp|stl|3mf)$/i, '') || root.name,
          versions: [],
        });
        newParts++;
      }
    }
  }
  for (const n of ordered) {
    if (n.versionId) continue;
    n.versionId = newUniqueId(takenIds, random);
    newVersions++;
    if (!n.sidecar) versionsWithoutNotes++;
  }
  const storedOf = (n: Node): { path: string; outside?: true } => {
    if (path.isAbsolute(n.file)) return toStoredPath(folder, n.file, path);
    if (isAbsoluteStoredPath(n.file)) return { path: n.file, outside: true };
    // A v1 path that isn't absolute anywhere (never written by the app): keep the file name.
    return { path: n.name.replace(/[\\/]/g, '_') || 'unknown' };
  };
  for (const n of ordered) {
    const part = parts.get(n.partId as string) as ProjectPart;
    if (part.versions.some((v) => v.id === n.versionId)) continue;
    const version: ProjectVersion = {
      id: n.versionId as string,
      ...storedOf(n),
      contentHash: n.contentHash,
      ...(n.meshHash ? { meshHash: n.meshHash } : {}),
      format: n.format,
      added: n.added as string,
      ...(n.parent?.versionId ? { from: n.parent.versionId } : {}),
      ...(n.overwritten ? { overwritten: true as const } : {}),
    };
    part.versions.push(version);
  }

  // Markers: one id space per project.
  // A project's own marker (`existing`) is never overwritten by a sidecar's copy.
  const markers = new Map<string, ProjectMarker & { own?: true; added: string }>();
  for (const m of existing?.markers ?? []) markers.set(m.id, { ...m, own: true, added: '' });
  // `${partId}\n${origin}\n${v1 id}` → project id. v1 ids come from a counter, so two variants (or a
  // version and a later edit of its parent) can each add their own "m3": the same id is the same
  // marker only when it came down the version chain from one version (its origin).
  const markerIds = new Map<string, string>();
  const originOf = (n: Node, v1: string): string => {
    let o = n;
    let steps = 0;
    while (o.parent?.sidecar?.markers.some((m) => m.id === v1) && steps++ < nodes.length) {
      o = o.parent;
    }
    return o.key;
  };
  const markerTaken = new Set(markers.keys());
  // Parts whose comments use each existing marker: within one part, the same id = the same marker.
  const ownMarkerParts = new Map<string, Set<string>>();
  for (const c of existing?.comments ?? []) {
    for (const m of c.markerIds)
      ownMarkerParts.set(m, (ownMarkerParts.get(m) ?? new Set()).add(c.modelId));
  }
  const existingParts = new Set(existing?.models.map((m) => m.id));
  let renamedMarkers = 0;
  const projectMarkerId = (n: Node, v1: string): string => {
    const partId = n.partId as string;
    const k = `${partId}\n${originOf(n, v1)}\n${v1}`;
    let id = markerIds.get(k);
    if (id) return id;
    const usedBy = ownMarkerParts.get(v1);
    const sameMarker =
      markers.get(v1)?.own &&
      existingParts.has(partId) &&
      (usedBy === undefined || usedBy.has(partId));
    if (sameMarker) id = v1;
    else if (markerTaken.has(v1)) {
      id = newUniqueId(markerTaken, random);
      renamedMarkers++;
    } else {
      id = v1;
      markerTaken.add(id);
    }
    markerIds.set(k, id);
    return id;
  };
  const withNotes = ordered.filter((n) => n.sidecar && taken.includes(n));
  const marks: VersionMarks[] = [];
  for (const n of withNotes) {
    const s = n.sidecar as Annotations;
    for (const m of s.markers) {
      const id = projectMarkerId(n, m.id);
      const prev = markers.get(id);
      if (!prev || (!prev.own && ms(prev.added) <= ms(n.added))) {
        markers.set(id, {
          id,
          name: m.name,
          color: m.color,
          visible: m.visible,
          added: n.added as string,
        });
      }
    }
    marks.push(
      versionMarksSchema.parse({
        schemaVersion: PROJECT_SCHEMA_VERSION,
        versionId: n.versionId,
        contentHash: s.model.contentHash,
        ...(s.model.meshHash ? { meshHash: s.model.meshHash } : {}),
        ...(s.tessellation ? { tessellation: s.tessellation } : {}),
        ...(s.bodies ? { bodies: s.bodies } : {}),
        markers: s.markers.map((m) => ({
          id: projectMarkerId(n, m.id),
          entities: m.entities,
          paint: m.paint,
          ...(m.transfer ? { transfer: m.transfer } : {}),
        })),
      }),
    );
  }

  // Comments once per project.
  const children = (n: Node): Node[] => nodes.filter((c) => c.parent === n);
  const comments = new Map<string, ProjectComment>(
    (existing?.comments ?? []).map((c) => [c.id, c]),
  );
  const commentTaken = new Set(comments.keys());
  let deletedComments = 0;
  const fileNames = new Map<string, string>(); // file name (lower case) → part id
  for (const n of nodes) fileNames.set(n.name.toLowerCase(), n.partId as string);
  const byPart = new Map<string, Node[]>();
  for (const n of withNotes)
    byPart.set(n.partId as string, [...(byPart.get(n.partId as string) ?? []), n]);
  type V1Comment = Annotations['comments'][number];
  // v1 comment ids come from a counter too: copies are one comment only when id and creation time
  // match (the revision transfer keeps both).
  const commentKey = (c: V1Comment): string => `${c.id}\n${String(ms(c.createdAt))}`;
  const holds = (n: Node, key: string): boolean =>
    n.sidecar?.comments.some((x) => commentKey(x) === key) ?? false;
  const aliveMemo = new Map<string, boolean>();
  /**
   * The comment is still there after version `n`: no version was made from `n` after the comment,
   * or one of those still holds it and is itself alive (a deletion two versions later counts).
   */
  const aliveAt = (n: Node, key: string, created: number): boolean => {
    const memo = `${n.key}\n${key}`;
    const known = aliveMemo.get(memo);
    if (known !== undefined) return known;
    aliveMemo.set(memo, false); // the chain is a tree; this only guards against bad input
    const later = children(n).filter((k) => k.sidecar && ms(k.added) > created);
    const alive =
      later.length === 0 || later.some((k) => holds(k, key) && aliveAt(k, key, created));
    aliveMemo.set(memo, alive);
    return alive;
  };
  for (const [partId, versions] of byPart) {
    const copies = new Map<string, { node: Node; c: V1Comment }[]>();
    for (const n of versions) {
      for (const c of (n.sidecar as Annotations).comments) {
        const key = commentKey(c);
        copies.set(key, [...(copies.get(key) ?? []), { node: n, c }]);
      }
    }
    for (const [key, list] of copies) {
      const alive = list.filter(({ node, c }) => aliveAt(node, key, ms(c.createdAt)));
      if (alive.length === 0) {
        deletedComments++;
        continue;
      }
      alive.sort((a, b) =>
        ms(a.c.updatedAt) === ms(b.c.updatedAt)
          ? ms(a.node.added) - ms(b.node.added)
          : ms(a.c.updatedAt) - ms(b.c.updatedAt),
      );
      const { node, c } = alive[alive.length - 1] as (typeof alive)[number];
      const v1Id = c.id;
      // The project already has this comment on this part: the project's copy wins.
      const own = existing?.comments.find((x) => x.id === v1Id);
      if (own && own.modelId === partId && ms(own.createdAt) === ms(c.createdAt)) continue;
      const id = commentTaken.has(v1Id)
        ? newUniqueId(commentTaken, random)
        : (commentTaken.add(v1Id), v1Id);
      const linkedParts = [
        ...new Set(
          (c.linkedModels ?? [])
            .map((name) => fileNames.get(name.toLowerCase()))
            .filter((p): p is string => p !== undefined && p !== partId),
        ),
      ];
      comments.set(id, {
        ...c,
        id,
        modelId: partId,
        markerIds: c.markerIds.map((m) => projectMarkerId(node, m)),
        ...(linkedParts.length ? { linkedParts } : {}),
        // Part requests aim at the comment's markers: their ids move the same way.
        ...(c.parts?.length
          ? {
              parts: c.parts.map((p) =>
                p.target
                  ? {
                      ...p,
                      target: {
                        ...p.target,
                        markerIds: p.target.markerIds.map((m) => projectMarkerId(node, m)),
                      },
                    }
                  : p,
              ),
            }
          : {}),
      });
    }
  }

  // Body-list folders per part: from the newest version that has them, bodies by name.
  for (const [partId, versions] of byPart) {
    const part = parts.get(partId) as ProjectPart;
    if (part.bodyTree) continue;
    const src = [...versions].reverse().find((n) => n.sidecar?.bodyTree);
    const s = src?.sidecar;
    if (!s?.bodyTree) continue;
    const ref = (i: number): BodyRef => {
      const b = s.bodies?.[i];
      return b
        ? { name: b.name, ...(b.path !== undefined ? { path: b.path } : {}), index: i }
        : { name: '', index: i };
    };
    const tree: ProjectBodyTree = {
      folders: s.bodyTree.folders,
      bodies: s.bodyTree.bodies.map((b) => ({ body: ref(b.body), parent: b.parent })),
      assemblies: s.bodyTree.assemblies,
    };
    part.bodyTree = tree;
  }

  const newestStep = [...withNotes].reverse().find((n) => n.sidecar?.tessellation);
  const tessellation = existing?.tessellation ?? newestStep?.sidecar?.tessellation;
  const sidecars = [
    ...(existing?.sidecars ?? []),
    ...taken.map((n) => ({ path: storedOf(n).path, contentHash: n.contentHash, at })),
  ];
  const project = projectSchema.parse({
    ...(existing ?? {}),
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: existing?.id ?? newUniqueId(takenIds, random),
    name: existing?.name ?? (path.basename(path.resolve(folder)) || 'Project'),
    created: existing?.created ?? at,
    ...(tessellation ? { tessellation } : {}),
    models: [...parts.values()],
    markers: [...markers.values()].map(
      (m) =>
        (m.own && existing?.markers.find((x) => x.id === m.id)) || {
          id: m.id,
          name: m.name,
          color: m.color,
          visible: m.visible,
        },
    ),
    comments: [...comments.values()].sort((a, b) => ms(a.createdAt) - ms(b.createdAt)),
    chats: existing?.chats ?? [],
    ...(sidecars.length ? { sidecars } : {}),
  });
  return {
    project,
    marks,
    report: {
      sidecars: taken.length,
      newParts,
      newVersions,
      versionsWithoutNotes,
      deletedComments,
      renamedMarkers,
      cutLinks,
    },
  };
}

// --- reading the sidecars ------------------------------------------------------------------------

export interface CollectedSidecars {
  readonly sidecars: SidecarInput[];
  /** Sidecars that couldn't be read or checked (left as they are, named in a notice). */
  readonly unreadable: { readonly file: string; readonly errors: readonly string[] }[];
}

const SIDECAR_SUFFIX = '.thirdwheel.json';

/**
 * Every v1 sidecar in `folder` (not sub-folders), plus sidecars of versions outside it that their
 * chains link to (at most `MAX_VERSION_LINKS` extra), so `../exports/part_v2.step` comes along.
 * A sidecar reached through a link counts only when it holds the linked contents.
 */
export async function collectSidecars(
  fs: ProjectFs,
  folder: string,
  path: PathApi,
): Promise<CollectedSidecars> {
  const sidecars: SidecarInput[] = [];
  const unreadable: { file: string; errors: readonly string[] }[] = [];
  const seen = new Set<string>();
  const read = async (modelPath: string, wantHash?: string): Promise<SidecarInput | undefined> => {
    const file = `${modelPath}${SIDECAR_SUFFIX}`;
    if (seen.has(file)) return undefined;
    seen.add(file);
    let text: string;
    try {
      const size = await fs.size(file);
      if (size === undefined) return undefined;
      if (size > MAX_PROJECT_FILE_BYTES) {
        unreadable.push({ file, errors: ['larger than 256 MB'] });
        return undefined;
      }
      text = await fs.readText(file);
    } catch (e) {
      unreadable.push({ file, errors: [`can't read the file (${errorCode(e) ?? String(e)})`] });
      return undefined;
    }
    const r = parseAnnotationsJson(text);
    if (!r.ok) {
      if (wantHash === undefined) unreadable.push({ file, errors: r.errors });
      return undefined;
    }
    if (wantHash !== undefined && r.data.model.contentHash !== wantHash) return undefined;
    const s = { modelPath, data: r.data };
    sidecars.push(s);
    return s;
  };

  const names = (await fs.list(folder)).filter((n) => n.endsWith(SIDECAR_SUFFIX)).sort();
  const queue: SidecarInput[] = [];
  for (const name of names) {
    const s = await read(path.join(folder, name.slice(0, -SIDECAR_SUFFIX.length)));
    if (s) queue.push(s);
  }
  let extra = 0;
  while (queue.length > 0 && extra < MAX_VERSION_LINKS) {
    const s = queue.shift() as SidecarInput;
    const links = [...(s.data.versions?.earlier ?? []), ...(s.data.versions?.newer ?? [])];
    for (const l of links) {
      if (extra >= MAX_VERSION_LINKS) break;
      if (!path.isAbsolute(l.path) || l.overwritten) continue;
      const next = await read(path.resolve(l.path), l.contentHash);
      if (next) {
        extra++;
        queue.push(next);
      }
    }
  }
  return { sidecars, unreadable };
}
