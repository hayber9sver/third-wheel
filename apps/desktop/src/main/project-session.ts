/**
 * The window's notes, read from and saved into the project (docs/file-format.md).
 *
 * The window asks for a model file's version (its notes in the window's shape, and its place in the
 * version list), links versions, and saves notes back; this session turns that into project files: it finds the nearest project folder, moves old
 * `*.thirdwheel.json` notes in (once; the old files are left as they are), holds the project's lock
 * while a model of it is shown, and opens the project read-only when it can't be written (folder
 * not writable, held on another computer, made by a newer app, path too long). Read-only changes
 * stay in memory for the session.
 *
 * File access goes through `ProjectFs`, so the logic runs in tests on an in-memory file system.
 * All calls run one after another (a save never overlaps a read).
 *
 * Why one file (~1,500 lines): one class whose methods share the open projects, the lock and the
 * one-at-a-time call queue; splitting it would mean rewriting it. Its sections, in order: public
 * calls (shown / open / link / save / versions / parts / new project / save as / AI load check),
 * chats, loading (project folder, migration of old notes), current project + lock, saving.
 */
import {
  ProjectPathError,
  acquireLock,
  appendChatEntry,
  newestVersionOf,
  readChat,
  withChatLines,
  type ChatEntry as ChatLine,
  type ChatInfo,
  type ProjectVersion,
  applyNotes,
  addFileAsPart,
  isEarlierVersion,
  linkAsNewer,
  sameModelName,
  nextVersionName,
  replaceContents,
  versionFacts,
  type VersionFacts,
  findVersion,
  partVersions,
  projectParts,
  type PartRow,
  relocateVersion,
  removeFromVersions,
  type PartVersionList,
  collectSidecars,
  copyAside,
  errorCode,
  lockState,
  parseLock,
  findProjectFolder,
  forgetMarkers,
  formatJson,
  migrateSidecars,
  moveAside,
  versionNotes,
  type VersionFileRef,
  parseAnnotationsJson,
  projectFiles,
  readMarks,
  readProject,
  otherMarkers,
  renamedMarkersText,
  uniqueMarkerNames,
  releaseLock,
  saveProject,
  strayProjectFiles,
  versionAtPath,
  versionFile,
  newProject,
  toStoredPath,
  writeAtomic,
  PROJECT_DIR,
  type LockSelf,
  type PathApi,
  type Project,
  type ProjectFiles,
  type ProjectFs,
  type RandomBytes,
  type VersionMarks,
  type VersionRef,
} from '@third-wheel/core';
import type {
  LinkResult,
  OpenedVersion,
  ProjectState,
  SaveResult,
  VersionInfo,
} from '../shared/ipc.js';
import { otherProjectText, outsideProjectText, savedOverText } from '../shared/load-rules.js';
import type { ChatAppendResult, ChatProjectFacts } from '../shared/chat.js';

/** Where the project's lock is held when someone else has it. */
export interface LockHolder {
  readonly folder: string;
  readonly host: string;
  readonly since: string;
  /** Another computer (a synced folder); else another app on this computer. */
  readonly otherHost: boolean;
}

export interface SessionDeps {
  readonly fs: ProjectFs;
  readonly path: PathApi;
  readonly home: string;
  readonly self: LockSelf;
  now(): Date;
  readonly random?: RandomBytes;
  /** The file's real path (case on disk, links resolved); the path itself when it can't be found. */
  realpath(p: string): Promise<string>;
  /** The lock is held elsewhere: true = take it over, false = open read-only. */
  askTakeOver(holder: LockHolder): Promise<boolean>;
  /**
   * Ask before a change to the files (true = go ahead). `learnMore`: the box also links to the
   * user guide's "how projects and folders work".
   */
  confirm(message: string, detail: string, button: string, learnMore?: boolean): Promise<boolean>;
  /** A message for the window (shown once). */
  notice(text: string): void;
  /** The shown project changed (title, read-only bar). */
  stateChanged(state: ProjectState | undefined): void;
}

/** Errors that mean "this folder can't be written" (not a passing hold, those are retried). */
const NOT_WRITABLE = new Set(['EACCES', 'EPERM', 'EROFS']);
/** Most parts a catch-up lists. */
const MAX_CATCH_UP_PARTS = 20;

interface Loaded {
  readonly folder: string;
  readonly files: ProjectFiles | undefined;
  project: Project | undefined;
  /** `project.json` exists on disk. */
  onDisk: boolean;
  /** Marks per version: null = none on disk. */
  readonly marks: Map<string, VersionMarks | null>;
  /** Changes not on disk yet (migration, or saves while read-only). */
  dirty: boolean;
  readonly pendingMarks: Set<string>;
  readOnly: string | undefined;
  /** Made by a newer app: nothing is written or merged. */
  newer: boolean;
  locked: boolean;
}

const SIDECAR_SUFFIX = '.thirdwheel.json';

/** `load_model` checked against the project (`ProjectSession.checkAiLoad`). */
export type AiLoadCheck =
  | { readonly ok: true; readonly saveNextAs: string }
  | { readonly ok: false; readonly message: string };

/** File ▸ Add file…: where a picked model file stands (`ProjectSession.placeOf`). */
export type ModelPlace =
  | { readonly place: 'inside'; readonly listed: boolean }
  | { readonly place: 'other'; readonly project: ProjectState }
  | { readonly place: 'outside' };

/** The model format a file name stands for. */
function formatOfName(file: string): VersionFileRef['format'] {
  const n = file.toLowerCase();
  return n.endsWith('.stl') ? 'stl' : n.endsWith('.3mf') ? '3mf' : 'step';
}

/** `file` is `folder` or lies somewhere under it. */
function within(folder: string, file: string, path: PathApi): boolean {
  const rel = path.relative(folder, file);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

export class ProjectSession {
  private readonly loaded = new Map<string, Loaded>();
  private current: Loaded | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** Per model file + contents: project ids of the comments its window was given or saved. */
  private readonly shownComments = new Map<string, Set<string>>();
  private readonly real = new Map<string, string>();
  /** A lock file whose release has started but not finished (see {@link heldLock}). */
  private releasing: string | undefined;
  /** Real path of a project folder → the spelling seen first (one folder, one string). */
  private readonly spelling = new Map<string, string>();

  constructor(private readonly deps: SessionDeps) {}

  /** Runs `job` after every earlier call. */
  private run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.queue.then(job, job);
    this.queue = next.catch(() => undefined);
    return next;
  }

  // --- public ------------------------------------------------------------------------------------

  /** The model the window shows now: its project becomes the current one (lock, title). */
  shown(file: string): Promise<ProjectState> {
    return this.run(async () => {
      // Read the files again (changed on disk since: git, another tool), unless they hold
      // changes not saved yet (read-only session).
      for (const [folder, known] of this.loaded) {
        if (!known.dirty) this.loaded.delete(folder);
      }
      const before = this.current;
      if (before && !before.dirty) this.current = undefined;
      const p = await this.projectFor(file);
      if (before && before !== p && !this.current) {
        if (before.folder === p.folder) {
          // The same project read again: the lock stays held, a read-only choice stays.
          p.locked = before.locked && p.onDisk && (await this.stillMine(p));
          p.readOnly ??= before.readOnly;
          this.current = p;
        } else {
          this.current = before; // makeCurrent releases its lock
        }
      }
      await this.makeCurrent(p);
      return this.stateOf(p);
    });
  }

  /** The shown project (title, read-only), if a model was shown. */
  state(): ProjectState | undefined {
    return this.current ? this.stateOf(this.current) : undefined;
  }

  /**
   * The version of a model file in the project: its notes (window shape; null = none) and its
   * place in the version list. With `contentHash`, exactly the version with these contents (a file
   * put back to older contents gets that one); without, the version the path stands for now.
   */
  open(file: string, contentHash?: string): Promise<OpenedVersion> {
    return this.run(async () => {
      const p = await this.projectFor(file);
      await this.prime(p, file);
      const { path } = this.deps;
      const facts = (): VersionFacts => {
        if (!p.project) return {};
        if (contentHash !== undefined)
          return versionFacts(p.project, p.folder, file, contentHash, path, this.same);
        const at = versionAtPath(p.project, p.folder, file, path, this.same);
        return at
          ? versionFacts(p.project, p.folder, file, at.version.contentHash, path, this.same)
          : {};
      };
      let f = facts();
      if (!f.version && !f.replaced && !p.newer) {
        await this.mergeLateSidecar(p, file);
        f = facts();
      }
      const ref = f.version;
      const project = p.project;
      const out: {
        notes: string | null;
        listed: boolean;
        hasMarks: boolean;
        unlinked?: true;
        parent?: VersionInfo;
        newer?: VersionInfo;
        replaced?: VersionInfo;
        otherMarkers?: { id: string; name: string }[];
      } = { notes: null, listed: ref !== undefined, hasMarks: false };
      if (f.parent) out.parent = await this.infoOf(p, f.parent);
      if (f.newer) out.newer = await this.infoOf(p, f.newer);
      if (f.replaced) out.replaced = await this.infoOf(p, f.replaced);
      // Every marker of the project, also the shown ones: one deleted here may still be held by
      // another version, so its name stays taken (the window counts the ones it lists as its own).
      if (project) out.otherMarkers = otherMarkers(project, []);
      if (!ref || !project) return out;
      if (ref.version.unlinked) out.unlinked = true;
      const marks = await this.marksOf(p, ref.version.id);
      out.hasMarks = marks !== null;
      const notes = versionNotes(project, ref, marks, p.folder, path);
      if (!notes) return out;
      const key = this.idKey(file, ref.version.contentHash);
      this.shownComments.set(key, new Set(notes.comments.map((c) => c.id)));
      // The ids the window used for this file before (same ids while the app runs).
      out.notes = formatJson(notes);
      return out;
    });
  }

  /** Another version for the window: where it is, whether the project has notes for it. */
  private async infoOf(p: Loaded, ref: VersionRef): Promise<VersionInfo> {
    const file = versionFile(p.folder, ref.version, this.deps.path);
    const commented = p.project?.comments.some((c) => c.modelId === ref.part.id) ?? false;
    return {
      path: file,
      name: this.deps.path.basename(file) || ref.version.path,
      contentHash: ref.version.contentHash,
      hasNotes: commented || (await this.marksOf(p, ref.version.id)) !== null,
    };
  }

  /**
   * `file` with these contents becomes a version made from `parent` (both listed afterwards).
   */
  link(
    file: string,
    contentHash: string,
    parent: { readonly file: string; readonly contentHash: string },
  ): Promise<LinkResult> {
    return this.run(async () => {
      const { path } = this.deps;
      const p = await this.projectFor(parent.file);
      if (p !== this.current) await this.makeCurrent(p);
      if (p.newer) throw new Error(p.readOnly ?? 'Made by a newer app');
      await this.prime(p, file);
      await this.prime(p, parent.file);
      const opts = {
        folder: p.folder,
        path,
        now: this.deps.now(),
        same: this.same,
        ...(this.deps.random ? { random: this.deps.random } : {}),
      };
      // An earlier version the project doesn't list yet (no notes so far) comes in as a part.
      let project = addFileAsPart(
        p.project,
        { file: parent.file, contentHash: parent.contentHash, format: formatOfName(parent.file) },
        opts,
      );
      const r = linkAsNewer(
        project,
        { file, contentHash, format: formatOfName(file) },
        parent,
        opts,
      );
      project = r.project;
      if (project !== p.project) {
        p.project = project;
        p.dirty = true;
        await this.persist(p);
      }
      if (r.outcome.kind !== 'linked') return r.outcome;
      const { before, removedLinks } = r.outcome;
      return {
        kind: 'linked',
        ...(before ? { before: await this.infoOf(p, before) } : {}),
        ...(removedLinks ? { removedLinks } : {}),
      };
    });
  }

  /** The folder of the project each file belongs to (the one that lists it, else the nearest). */
  projectFolders(files: readonly string[]): Promise<string[]> {
    return this.run(async () => {
      const out: string[] = [];
      for (const f of files) out.push((await this.projectFor(f)).folder);
      return out;
    });
  }

  /** `maybe` is `of` or one of the versions `of` was made from. */
  isEarlier(
    maybe: { readonly file: string; readonly contentHash: string },
    of: { readonly file: string; readonly contentHash: string },
  ): Promise<boolean> {
    return this.run(async () => {
      const p = await this.projectFor(of.file);
      await this.prime(p, maybe.file);
      await this.prime(p, of.file);
      return p.project
        ? isEarlierVersion(p.project, p.folder, maybe, of, this.deps.path, this.same)
        : false;
    });
  }

  /** Save the window's notes of `file`. `backupFirst`: copy the files first (the load dropped data). */
  save(file: string, text: string, backupFirst: boolean): Promise<SaveResult> {
    return this.run(async () => {
      try {
        return await this.saveNow(file, text, backupFirst);
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    });
  }

  /**
   * The window can't use the notes of the version of `file` with these contents: its marks file
   * is moved aside to a `.bak.json`. Returns the backup's file name, or null when there were none.
   */
  backup(file: string, contentHash: string): Promise<string | null> {
    return this.run(async () => {
      const p = await this.projectFor(file);
      await this.prime(p, file);
      const ref = p.project
        ? findVersion(p.project, p.folder, file, contentHash, this.deps.path, this.same)
        : undefined;
      return ref ? this.marksAside(p, ref.version.id) : null;
    });
  }

  /** A version's marks file moved aside (with a copy of `project.json`); null = none / read-only. */
  private async marksAside(p: Loaded, versionId: string): Promise<string | null> {
    if (!p.files || p.readOnly) return null;
    const marksFile = p.files.marks(versionId);
    if ((await this.deps.fs.size(marksFile)) === undefined) return null;
    // Comments live in project.json: a copy too, so replaced notes can be found again.
    await copyAside(this.deps.fs, p.files.project, this.deps.now(), this.deps.path).catch(
      () => undefined,
    );
    const to = await moveAside(this.deps.fs, marksFile, this.deps.now(), this.deps.path);
    p.marks.set(versionId, null);
    return this.deps.path.basename(to);
  }

  /**
   * `file` was saved over in place: its version with `oldHash` now has `newHash` (one file name =
   * one version). Its marks stay until the window saves the paint it moved onto the new geometry
   * (or moves them aside with {@link backup}).
   */
  replaceContents(file: string, oldHash: string, newHash: string): Promise<void> {
    return this.run(async () => {
      const { path } = this.deps;
      const p = await this.projectFor(file);
      if (p !== this.current) await this.makeCurrent(p);
      if (p.newer) throw new Error(p.readOnly ?? 'Made by a newer app');
      await this.prime(p, file);
      if (!p.project) throw new Error('The file is not in the project');
      const r = replaceContents(p.project, p.folder, file, oldHash, newHash, path, this.same);
      // The comments the window was shown stay the window's under the new contents.
      const oldKey = this.idKey(file, oldHash);
      const shown = this.shownComments.get(oldKey);
      if (shown) this.shownComments.set(this.idKey(file, newHash), shown);
      p.project = r.project;
      p.dirty = true;
      await this.persist(p);
    });
  }

  /**
   * Add file… with no model shown: the newest version of a part of the current project whose
   * name makes `file` look like a version of it (`bracket_v2` ↔ `bracket`); the most recently
   * added one when several match. Undefined: none (or `file` is listed already).
   */
  namedPart(file: string): Promise<VersionInfo | undefined> {
    return this.run(async () => {
      const { path } = this.deps;
      const p = this.current;
      if (!p?.project) return undefined;
      await this.prime(p, file);
      const project = p.project;
      if (versionAtPath(project, p.folder, file, path, this.same)) return undefined;
      const name = path.basename(file);
      let best: { ref: VersionRef; added: number } | undefined;
      for (const part of project.models) {
        const first = part.versions[0];
        if (!first) continue;
        const f = versionFile(p.folder, first, path);
        const rows = partVersions(project, p.folder, f, first.contentHash, path, this.same)?.rows;
        const newest = rows?.[0];
        if (!newest || !sameModelName(newest.name, name)) continue;
        const version = part.versions.find((v) => v.id === newest.id);
        if (!version || version.unlinked) continue;
        const added = Date.parse(newest.added) || 0;
        if (!best || added > best.added) best = { ref: { part, version }, added };
      }
      return best ? this.infoOf(p, best.ref) : undefined;
    });
  }

  /**
   * Add file… → Separate part (or an empty project's first model): `file` with these contents is
   * listed at once as a part of its own (nothing when it is listed already).
   */
  addPart(file: string, contentHash: string): Promise<void> {
    return this.run(async () => {
      const { path } = this.deps;
      const p = await this.projectFor(file);
      if (p !== this.current) await this.makeCurrent(p);
      if (p.newer) return;
      await this.prime(p, file);
      const before = p.project;
      p.project = addFileAsPart(
        p.project,
        { file, contentHash, format: formatOfName(file) },
        {
          folder: p.folder,
          path,
          now: this.deps.now(),
          same: this.same,
          ...(this.deps.random ? { random: this.deps.random } : {}),
        },
      );
      if (p.project === before) return;
      p.dirty = true;
      await this.persist(p);
    });
  }

  /** The project folder and part of the version of `file` with these contents, if listed. */
  partOf(file: string, contentHash: string): Promise<{ folder: string; partId: string } | null> {
    return this.run(async () => {
      const p = await this.projectFor(file);
      await this.prime(p, file);
      const ref = p.project
        ? findVersion(p.project, p.folder, file, contentHash, this.deps.path, this.same)
        : undefined;
      return ref ? { folder: p.folder, partId: ref.part.id } : null;
    });
  }

  /** Versions ▾: all versions of the part of the shown file (these contents), newest first. */
  versions(file: string, contentHash: string): Promise<PartVersionList | undefined> {
    return this.run(async () => {
      const p = await this.projectFor(file);
      await this.prime(p, file);
      return p.project
        ? partVersions(p.project, p.folder, file, contentHash, this.deps.path, this.same)
        : undefined;
    });
  }

  /**
   * Parts ▾: the current project's parts, each with its newest version; `shown` (the shown model
   * with these contents) marks its part. Empty with no project or nothing listed yet.
   */
  parts(shown?: { readonly file: string; readonly contentHash: string }): Promise<PartRow[]> {
    return this.run(() => {
      const p = this.current;
      if (!p?.project) return Promise.resolve([]);
      const { path } = this.deps;
      const ref = shown
        ? findVersion(p.project, p.folder, shown.file, shown.contentHash, path, this.same)
        : undefined;
      return Promise.resolve(projectParts(p.project, p.folder, path, ref?.part.id));
    });
  }

  /**
   * Remove from versions…: `versionId` (another version of the shown file's part) leaves the part.
   */
  removeVersion(file: string, contentHash: string, versionId: string): Promise<void> {
    return this.changeVersion(file, contentHash, versionId, (p, loaded) =>
      removeFromVersions(
        p,
        versionId,
        this.deps.now(),
        loaded.folder,
        this.deps.path,
        this.deps.random,
      ),
    );
  }

  /** Locate…: `versionId`'s file is at `moved` now (the caller checked its contents). */
  locateVersion(
    file: string,
    contentHash: string,
    versionId: string,
    moved: string,
  ): Promise<void> {
    return this.changeVersion(file, contentHash, versionId, async (p, loaded) => {
      await this.prime(loaded, moved);
      return relocateVersion(p, versionId, moved, loaded.folder, this.deps.path, this.same);
    });
  }

  /** A change to another version of the shown file's part. */
  private changeVersion(
    file: string,
    contentHash: string,
    versionId: string,
    change: (project: Project, loaded: Loaded) => Project | Promise<Project>,
  ): Promise<void> {
    return this.run(async () => {
      const { path } = this.deps;
      const p = await this.projectFor(file);
      if (p !== this.current) await this.makeCurrent(p);
      if (p.newer) throw new Error(p.readOnly ?? 'Made by a newer app');
      await this.prime(p, file);
      const shown = p.project
        ? findVersion(p.project, p.folder, file, contentHash, path, this.same)
        : undefined;
      if (!shown || !p.project) throw new Error('The shown file is not in the project yet');
      if (shown.version.id === versionId) throw new Error('That is the shown version');
      if (!shown.part.versions.some((v) => v.id === versionId))
        throw new Error('Not a version of the shown part');
      p.project = await change(p.project, p);
      p.dirty = true;
      await this.persist(p);
    });
  }

  /** When the project has notes (marks) for the file at this path: a time (ms) for sorting; else undefined. */
  notesTime(file: string): Promise<number | undefined> {
    return this.run(async () => {
      const p = await this.projectFor(file);
      await this.prime(p, file);
      const ref = p.project
        ? versionAtPath(p.project, p.folder, file, this.deps.path, this.same)
        : undefined;
      if (ref && (await this.marksOf(p, ref.version.id))) return Date.parse(ref.version.added) || 0;
      if (!ref && (await this.deps.fs.size(`${file}${SIDECAR_SUFFIX}`)) !== undefined) return 0;
      return undefined;
    });
  }

  /**
   * File ▸ Make this folder its own project…: the shown model's folder gets its own project. The model's
   * part (all its versions, its comments, its markers and their paint) moves over from the parent
   * project; the chat stays there. Asks first.
   */
  newProjectHere(file: string): Promise<ProjectState | undefined> {
    return this.run(async () => {
      const { path } = this.deps;
      const from = await this.projectFor(file);
      const folder = await this.spelled(path.dirname(file));
      if (from.folder === folder && (from.onDisk || from.dirty)) {
        this.deps.notice(`${path.basename(folder)} is already its own project.`);
        return this.stateOf(from);
      }
      if (from.readOnly && from.folder !== folder) {
        this.deps.notice(
          `The project "${this.stateOf(from).name}" is read-only, so nothing can move out of it.`,
        );
        return this.stateOf(from);
      }
      await this.prime(from, file);
      const ref = from.project
        ? versionAtPath(from.project, from.folder, file, path, this.same)
        : undefined;
      const parentName = this.stateOf(from).name;
      const ok = await this.deps.confirm(
        `Make "${path.basename(folder) || folder}" its own project?`,
        ref
          ? `${path.basename(file)} and its versions, comments and markers move from the project "${parentName}" into a new .thirdwheel folder here. The chat stays in "${parentName}".`
          : `A new .thirdwheel folder is made here. From now on, models in this folder use it instead of "${parentName}".`,
        'Make its own project',
        true,
      );
      if (!ok) return undefined;
      const target = await this.load(folder);
      if (target.onDisk) {
        this.deps.notice(`${path.basename(folder)} already has a project.`);
        return this.stateOf(from);
      }
      // Old notes files of this folder may have come in when it was looked at: kept.
      target.project ??= newProject(folder, this.deps.now(), path, this.deps.random);
      target.dirty = true;
      const moved: string[] = [];
      if (ref && from.project) {
        const part = ref.part;
        const versions = part.versions.map((v) => {
          const abs = versionFile(from.folder, v, path);
          const stored = toStoredPath(folder, abs, path);
          const rest = { ...v };
          delete rest.outside;
          return { ...rest, ...stored };
        });
        const comments = from.project.comments.filter((c) => c.modelId === part.id);
        const markerIds = new Set(comments.flatMap((c) => c.markerIds));
        for (const v of part.versions) {
          const marks = await this.marksOf(from, v.id);
          if (!marks) continue;
          target.marks.set(v.id, marks);
          target.pendingMarks.add(v.id);
          moved.push(v.id);
          for (const m of marks.markers) markerIds.add(m.id);
        }
        target.project = {
          ...target.project,
          ...(from.project.tessellation ? { tessellation: from.project.tessellation } : {}),
          models: [...target.project.models, { ...part, versions }],
          markers: [
            ...target.project.markers,
            ...from.project.markers.filter((m) => markerIds.has(m.id)),
          ],
          comments: [...target.project.comments, ...comments],
        };
        const stillUsed = new Set(
          from.project.comments.filter((c) => c.modelId !== part.id).flatMap((c) => c.markerIds),
        );
        from.project = {
          ...from.project,
          models: from.project.models.filter((m) => m.id !== part.id),
          comments: from.project.comments.filter((c) => c.modelId !== part.id),
          markers: from.project.markers.filter((m) => !markerIds.has(m.id) || stillUsed.has(m.id)),
        };
        from.dirty = true;
      }
      // The new project first (all of it), then the old one; old marks files go last.
      await this.makeCurrent(target);
      if (!this.onDiskNow(target))
        throw new Error(target.readOnly ?? 'The new project could not be saved');
      if (from.dirty && from.files && from.onDisk) {
        const wasLocked = from.locked;
        if (await this.writable(from)) {
          await this.persist(from);
          for (const id of moved) {
            await this.deps.fs.remove(from.files.marks(id)).catch(() => undefined);
            from.marks.delete(id);
          }
        }
        if (!wasLocked) await this.unlock(from);
      }
      this.loaded.delete(from.folder); // read again when needed (other parts stay there)
      return this.stateOf(target);
    });
  }

  /**
   * File ▸ Save project as…: a copy of the shown project in another folder (a read-only folder, or
   * to keep a copy). The model files stay where they are; the copy points to them. It becomes
   * the shown project. Refused when the folder already has a project.
   */
  saveAs(folder: string): Promise<ProjectState> {
    return this.run(async () => {
      const { fs, path } = this.deps;
      const from = this.current;
      if (!from?.project) throw new Error('There is nothing to save yet: make a change first.');
      if (await fs.isDirectory(path.join(folder, PROJECT_DIR)))
        throw new Error(`${folder} already has a project. Pick another folder.`);
      const target = await this.load(folder);
      if (target.readOnly) throw new Error(target.readOnly);
      const at = this.deps.now();
      const copy = newProject(target.folder, at, path, this.deps.random);
      target.project = {
        ...from.project,
        id: copy.id,
        name: copy.name,
        created: copy.created,
        models: from.project.models.map((m) => ({
          ...m,
          versions: m.versions.map((v) => {
            const rest = { ...v };
            delete rest.outside;
            return { ...rest, ...toStoredPath(folder, versionFile(from.folder, v, path), path) };
          }),
        })),
      };
      for (const v of from.project.models.flatMap((m) => m.versions)) {
        const marks = await this.marksOf(from, v.id);
        if (!marks) continue;
        target.marks.set(v.id, marks);
        target.pendingMarks.add(v.id);
      }
      target.dirty = true;
      await this.makeCurrent(target);
      if (!this.onDiskNow(target))
        throw new Error(target.readOnly ?? 'The project could not be saved there');
      // Chats go along (copied as they are).
      if (from.files && target.files) {
        for (const c of from.project.chats) {
          const text = await fs.readText(from.files.chat(c.id)).catch(() => undefined);
          if (text === undefined) continue;
          await fs.makeDir(target.files.chatsDir);
          await writeAtomic(fs, target.files.chat(c.id), text, this.deps.random);
        }
      }
      return this.stateOf(target);
    });
  }

  /**
   * The model to show for a project folder (File ▸ Open folder…, Open Recent): `last` when the
   * project still lists it and it exists, else its newest version on disk. Undefined: no project
   * or nothing found.
   */
  modelOf(folder: string, last: string | undefined): Promise<string | undefined> {
    return this.run(async () => {
      const { fs, path } = this.deps;
      const found = (await fs.isDirectory(path.join(folder, PROJECT_DIR)))
        ? folder
        : await findProjectFolder(fs, folder, this.deps.home, path);
      if (!found) return undefined;
      const p = await this.load(found);
      if (!p.project) return undefined;
      const exists = async (f: string): Promise<boolean> => (await fs.size(f)) !== undefined;
      if (last && (await exists(last))) {
        await this.prime(p, last);
        if (versionAtPath(p.project, p.folder, last, path, this.same)) return last;
      }
      const all = p.project.models
        .flatMap((m) => m.versions)
        .filter((v) => !v.overwritten)
        .sort((a, b) => (Date.parse(b.added) || 0) - (Date.parse(a.added) || 0));
      for (const v of all) {
        const f = versionFile(p.folder, v, path);
        if (await exists(f)) return f;
      }
      return undefined;
    });
  }

  /**
   * File ▸ New project folder…: `folder` gets its `.thirdwheel/` now (an explicit New writes at
   * once, so models added later find it) and becomes the current project, with no model shown yet.
   * Never a second project in one folder: one that has a project is left as it is (`existing`,
   * with what's in it; `shown` = it is the current project). Refused (`parent`) when a project
   * further up lists models in this folder: those would silently change project.
   */
  newFolderProject(folder: string): Promise<
    | { readonly state: ProjectState }
    | { readonly parent: ProjectState }
    | {
        readonly existing: ProjectState;
        readonly models: number;
        readonly comments: number;
        readonly shown: boolean;
      }
  > {
    return this.run(async () => {
      const { fs, path } = this.deps;
      if (await fs.isDirectory(path.join(folder, PROJECT_DIR))) {
        const p = await this.load(folder);
        return {
          existing: this.stateOf(p),
          models: p.project?.models.length ?? 0,
          comments: p.project?.comments.length ?? 0,
          shown: p === this.current,
        };
      }
      const up = await findProjectFolder(fs, path.dirname(folder), this.deps.home, path);
      if (up && up !== folder) {
        const parent = await this.load(up);
        const inside = (parent.project?.models ?? []).some((m) =>
          m.versions.some((v) => within(folder, versionFile(parent.folder, v, path), path)),
        );
        if (inside) return { parent: this.stateOf(parent) };
      }
      const p = await this.load(folder);
      p.project ??= newProject(p.folder, this.deps.now(), path, this.deps.random);
      p.dirty = true;
      await this.makeCurrent(p);
      if (!this.onDiskNow(p)) throw new Error(p.readOnly ?? 'The project could not be saved');
      return { state: this.stateOf(p) };
    });
  }

  /**
   * File ▸ Open folder… on a folder with no model to show: its project (or the folder, until the
   * first change) becomes the current one, so Add file… adds to it.
   */
  openEmpty(folder: string): Promise<ProjectState> {
    return this.run(async () => {
      const { fs, path } = this.deps;
      const found = (await fs.isDirectory(path.join(folder, PROJECT_DIR)))
        ? folder
        : ((await findProjectFolder(fs, folder, this.deps.home, path)) ?? folder);
      const p = await this.load(found);
      await this.makeCurrent(p);
      return this.stateOf(p);
    });
  }

  /**
   * File ▸ Add file…: where a picked file stands. `inside` = in the current project's folder (or
   * listed by it); `other` = in a folder under it that has its own project; `outside` = anywhere
   * else (it opens its own project). Adding writes: a current project not on disk yet is made
   * now, so the new model finds it from a subfolder too.
   */
  placeOf(file: string): Promise<ModelPlace> {
    return this.run(async () => {
      const cur = this.current;
      if (!cur) return { place: 'outside' };
      const place = await this.placeIn(cur, file);
      if (place.place === 'inside' && !cur.onDisk && !cur.readOnly && !cur.newer) {
        cur.project ??= newProject(cur.folder, this.deps.now(), this.deps.path, this.deps.random);
        cur.dirty = true;
        await this.makeCurrent(cur);
      }
      return place;
    });
  }

  /**
   * `load_model` (the AI works inside the project folder): refused when `file` is outside the
   * current project's folder (or in a folder under it with its own project), or when it comes as
   * a new version (`newVersion` = `revisionOf` given) under a file name the project lists with
   * other contents (saved over). No other folder is searched for a project or written; the only
   * write is the one any open does: a file's own old notes file is merged into the project first
   * (so a stale one counts as listed). With no project shown, any file passes (the window's load
   * opens its folder's).
   * `saveNextAs` = a free name for the next export, next to `file`.
   */
  checkAiLoad(file: string, contentHash: string, newVersion: boolean): Promise<AiLoadCheck> {
    return this.run(async () => {
      const { path } = this.deps;
      const name = path.basename(file);
      const cur = this.current;
      if (cur) {
        const place = await this.placeIn(cur, file);
        if (place.place !== 'inside') {
          const suggest = await this.freePath(cur, path.join(cur.folder, name), false);
          return {
            ok: false,
            message:
              place.place === 'other'
                ? otherProjectText(name, place.project.folder, cur.folder, suggest)
                : outsideProjectText(name, cur.folder, suggest),
          };
        }
      }
      const p = cur ?? (await this.projectFor(file));
      await this.prime(p, file);
      if (newVersion) {
        // An old notes file of its own lists it (older contents) once it is merged in.
        if (!p.newer && !(p.project && versionAtPath(p.project, p.folder, file, path, this.same)))
          await this.mergeLateSidecar(p, file);
        const project = p.project;
        if (
          project &&
          versionAtPath(project, p.folder, file, path, this.same) &&
          !findVersion(project, p.folder, file, contentHash, path, this.same)
        ) {
          return { ok: false, message: savedOverText(name, await this.freePath(p, file, true)) };
        }
      }
      return { ok: true, saveNextAs: await this.freePath(p, file, true) };
    });
  }

  /** Where `file` stands to the current project `cur` (see {@link placeOf}); writes nothing. */
  private async placeIn(cur: Loaded, file: string): Promise<ModelPlace> {
    const { fs, path } = this.deps;
    await this.prime(cur, file);
    const listed = cur.project
      ? versionAtPath(cur.project, cur.folder, file, path, this.same) !== undefined
      : false;
    const real = this.real.get(file) ?? file;
    const curReal = await this.deps.realpath(cur.folder).catch(() => cur.folder);
    if (!listed && !within(curReal, real, path) && !within(cur.folder, file, path)) {
      return { place: 'outside' };
    }
    if (!listed) {
      const found = await findProjectFolder(fs, path.dirname(file), this.deps.home, path);
      const nearest = found && (await this.spelled(found));
      if (nearest && nearest !== cur.folder && within(cur.folder, nearest, path)) {
        const other = await this.load(nearest);
        return { place: 'other', project: this.stateOf(other) };
      }
    }
    return { place: 'inside', listed };
  }

  /**
   * A path in `start`'s folder that is neither a file on disk nor listed by `p`: `start` itself
   * (`next` false) or its next version names (`part_v2.step`, `part_v3.step`, …).
   */
  private async freePath(p: Loaded, start: string, next: boolean): Promise<string> {
    const { fs, path } = this.deps;
    const dir = path.dirname(start);
    let name = path.basename(start);
    if (next) name = nextVersionName(name);
    for (let i = 0; i < 100; i++) {
      const candidate = path.join(dir, name);
      const onDisk = (await fs.size(candidate).catch(() => undefined)) !== undefined;
      const listed =
        p.project !== undefined &&
        versionAtPath(p.project, p.folder, candidate, path, this.same) !== undefined;
      if (!onDisk && !listed) return candidate;
      name = nextVersionName(name);
    }
    return path.join(dir, name);
  }

  // --- chats (ADR 004 § 6; `chat-store.ts` turns them into window entries) --------------------

  /** The shown project's chats index (another project's: empty, chats go with the shown one). */
  chatIndex(folder: string): Promise<readonly ChatInfo[]> {
    return this.run(() => {
      const p = this.current;
      return Promise.resolve(p?.folder === folder ? (p.project?.chats ?? []) : []);
    });
  }

  /** Every line of a chat of the shown project, oldest first. */
  chatLines(folder: string, chatId: string): Promise<readonly ChatLine[]> {
    return this.run(async () => {
      const p = this.current;
      if (p?.folder !== folder || !p.files || !p.project?.chats.some((c) => c.id === chatId))
        return [];
      const r = await readChat(this.deps.fs, p.files, chatId);
      return r.kind === 'ok' ? r.data.entries : [];
    });
  }

  /**
   * Append chat lines to a project's chat (a chat is listed with its first lines; `project.json`
   * keeps the index's time and line count). The first chat line makes a project on disk, like a
   * first note. `read-only`: it can't be written (read-only, made by a newer app). A project not
   * shown now (the agent answered a message asked there) is written on its own, see
   * {@link appendElsewhere}.
   */
  appendChatLines(
    folder: string,
    chatId: string,
    lines: readonly ChatLine[],
    title: string,
    summary?: string,
  ): Promise<ChatAppendResult> {
    return this.run(async () => {
      const p = this.current;
      if (lines.length === 0) return 'saved';
      if (p?.folder !== folder) return this.appendElsewhere(folder, chatId, lines, title, summary);
      if (p.newer || !p.files || !(await this.writable(p))) return 'read-only';
      const { fs, path } = this.deps;
      const now = this.deps.now();
      p.project ??= newProject(p.folder, now, path, this.deps.random);
      // The index first: lines are never in a file the index doesn't list (if saving the index
      // fails, nothing is appended and the caller tries the lines again later).
      const before = p.project;
      p.project = withChatLines(p.project, chatId, {
        count: lines.length,
        at: now.toISOString(),
        title,
        ...(summary === undefined ? {} : { summary }),
      });
      p.dirty = true;
      let r: SaveResult;
      try {
        r = await this.persist(p);
      } catch (e) {
        p.project = before;
        throw e;
      }
      if (!r.ok || 'readOnly' in r) return 'read-only';
      for (const line of lines) await appendChatEntry(fs, p.files, chatId, line);
      return 'saved';
    });
  }

  /**
   * Chat lines for a project that isn't shown: read its `project.json` afresh, take its lock only
   * if it is free (never asks to take over), write, release. `not-shown`: it is open elsewhere (or
   * holds changes not saved yet): the lines wait until it is shown. `read-only`: no project there
   * that this app may write (gone, made by a newer app, unreadable, folder not writable).
   */
  private async appendElsewhere(
    folder: string,
    chatId: string,
    lines: readonly ChatLine[],
    title: string,
    summary: string | undefined,
  ): Promise<ChatAppendResult> {
    if (this.loaded.get(folder)?.dirty) return 'not-shown';
    const { fs, path, self } = this.deps;
    let files: ProjectFiles;
    try {
      files = projectFiles(folder, path);
    } catch {
      return 'read-only';
    }
    const r = await readProject(fs, files);
    if (r.kind !== 'ok') return 'read-only';
    const now = this.deps.now();
    try {
      const lock = await acquireLock(fs, files, self, now);
      if (lock.kind !== 'acquired') return 'not-shown';
    } catch (e) {
      if (NOT_WRITABLE.has(errorCode(e) ?? '')) return 'read-only';
      throw e;
    }
    try {
      const project = withChatLines(r.data, chatId, {
        count: lines.length,
        at: now.toISOString(),
        title,
        ...(summary === undefined ? {} : { summary }),
      });
      await saveProject(fs, files, { project }, this.deps.random);
      for (const line of lines) await appendChatEntry(fs, files, chatId, line);
    } catch (e) {
      if (NOT_WRITABLE.has(errorCode(e) ?? '')) return 'read-only';
      throw e;
    } finally {
      await releaseLock(fs, files, self).catch(() => undefined);
      // A copy read before is out of date now.
      this.loaded.delete(folder);
    }
    return 'saved';
  }

  /**
   * What a new agent connection is told about the shown project (the catch-up): its name; per part
   * the newest file, versions added after `since` (ms) and open comments; the agent's latest
   * summary — of topic `chatId` ("this topic") or else of an earlier one.
   */
  chatFacts(
    folder: string,
    since: number | undefined,
    chatId: string | undefined,
  ): Promise<ChatProjectFacts | undefined> {
    return this.run((): Promise<ChatProjectFacts | undefined> => {
      const p = this.current;
      if (p?.folder !== folder) return Promise.resolve(undefined);
      const { path } = this.deps;
      const project = p.project;
      if (!project) return Promise.resolve({ name: path.basename(folder), parts: [] });
      const parts: ChatProjectFacts['parts'][number][] = [];
      for (const part of project.models.slice(0, MAX_CATCH_UP_PARTS)) {
        const newest = newestVersionOf(project, p.folder, part.id, path);
        if (!newest) continue;
        const name = (v: ProjectVersion): string =>
          path.basename(versionFile(p.folder, v, path)) || v.path;
        const added =
          since === undefined ? [] : part.versions.filter((v) => Date.parse(v.added) > since);
        added.sort((a, b) => Date.parse(a.added) - Date.parse(b.added));
        parts.push({
          file: name(newest),
          ...(added.length ? { newVersions: added.map(name) } : {}),
          openComments: project.comments.filter((c) => c.modelId === part.id && c.status === 'open')
            .length,
        });
      }
      const own = project.chats.find((c) => c.id === chatId)?.summary;
      const earlier = project.chats.filter((c) => c.id !== chatId && c.summary).at(-1)?.summary;
      const summary =
        own !== undefined
          ? { of: 'this topic' as const, text: own }
          : earlier !== undefined
            ? { of: 'earlier topic' as const, text: earlier }
            : undefined;
      return Promise.resolve({ name: project.name, parts, ...(summary ? { summary } : {}) });
    });
  }

  /** The version (and part) a model file stands for in the shown project. */
  versionPlace(
    folder: string,
    file: string,
  ): Promise<{ partId: string; versionId: string } | undefined> {
    return this.run(() => {
      const p = this.current;
      const ref =
        p?.folder === folder && p.project
          ? versionAtPath(p.project, p.folder, file, this.deps.path, this.same)
          : undefined;
      return Promise.resolve(ref ? { partId: ref.part.id, versionId: ref.version.id } : undefined);
    });
  }

  /** A part's newest version file in the shown project. */
  partLink(folder: string, partId: string): Promise<{ path: string; name: string } | undefined> {
    return this.run(() => {
      const p = this.current;
      const { path } = this.deps;
      const v =
        p?.folder === folder && p.project
          ? newestVersionOf(p.project, p.folder, partId, path)
          : undefined;
      if (!v || !p) return Promise.resolve(undefined);
      const file = versionFile(p.folder, v, path);
      return Promise.resolve({ path: file, name: path.basename(file) || v.path });
    });
  }

  /**
   * The lock file this app holds, if any (released on quit). Also one being released: quitting
   * closes the window first, whose release may not finish before the app exits.
   */
  heldLock(): string | undefined {
    return this.current?.locked ? this.current.files?.lock : this.releasing;
  }

  /** Release the lock (window closed). */
  close(): Promise<void> {
    return this.run(async () => {
      if (this.current) await this.unlock(this.current);
      this.current = undefined;
    });
  }

  // --- loading -----------------------------------------------------------------------------------

  private readonly same = (a: string, b: string): boolean =>
    (this.real.get(a) ?? a) === (this.real.get(b) ?? b);

  /** Real paths of the file and of the project's versions, for `same`. */
  private async prime(p: Loaded, file: string): Promise<void> {
    const want = [
      file,
      ...(p.project?.models.flatMap((m) =>
        m.versions.map((v) => versionFile(p.folder, v, this.deps.path)),
      ) ?? []),
    ];
    for (const f of want) {
      if (this.real.has(f)) continue;
      this.real.set(f, await this.deps.realpath(f).catch(() => f));
    }
  }

  private idKey(file: string, hash: string): string {
    return `${this.real.get(file) ?? file}\n${hash}`;
  }

  /** The project a model file belongs to: the current one if it lists the file, else the nearest. */
  private async projectFor(file: string): Promise<Loaded> {
    const { path } = this.deps;
    const cur = this.current;
    if (cur?.project) {
      await this.prime(cur, file);
      if (versionAtPath(cur.project, cur.folder, file, path, this.same)) return cur;
    }
    const start = path.dirname(file);
    const folder = (await findProjectFolder(this.deps.fs, start, this.deps.home, path)) ?? start;
    return this.load(folder);
  }

  /**
   * One spelling per project folder for the whole session: on Windows `C:\Work` and `c:\work`
   * are the same folder, and folders are compared as strings (here and in the window:
   * `projectFolders`). The first spelling seen wins; a linked folder (symlink, junction, `subst`)
   * first seen under its link name still stores paths relative to that name.
   */
  private async spelled(folder: string): Promise<string> {
    const real = await this.deps.realpath(folder).catch(() => folder);
    const known = this.spelling.get(real);
    if (known !== undefined) return known;
    this.spelling.set(real, folder);
    return folder;
  }

  private async load(given: string): Promise<Loaded> {
    const folder = await this.spelled(given);
    const known = this.loaded.get(folder);
    if (known) return known;
    const { fs, path } = this.deps;
    let files: ProjectFiles | undefined;
    let readOnly: string | undefined;
    try {
      files = projectFiles(folder, path);
    } catch (e) {
      if (!(e instanceof ProjectPathError)) throw e;
      readOnly = `Read-only: ${e.message}`;
      this.deps.notice(readOnly);
    }
    const p: Loaded = {
      folder,
      files,
      project: undefined,
      onDisk: false,
      marks: new Map(),
      dirty: false,
      pendingMarks: new Set(),
      readOnly,
      newer: false,
      locked: false,
    };
    this.loaded.set(folder, p);
    if (files) {
      const r = await readProject(fs, files);
      if (r.kind === 'ok') {
        p.project = r.data;
        p.onDisk = true;
        const strays = await strayProjectFiles(fs, files).catch(() => []);
        if (strays.length > 0) {
          this.deps.notice(
            `Ignored in the project folder (.thirdwheel): ${strays.slice(0, 5).join(', ')}${strays.length > 5 ? ', …' : ''}. These may be copies made by a sync service (OneDrive, Dropbox, iCloud); the app does not read them.`,
          );
        }
      } else if (r.kind === 'newer') {
        p.newer = true;
        p.readOnly =
          'This project was made by a newer version of Third Wheel. Update the app to see and change its notes.';
        this.deps.notice(p.readOnly);
        return p;
      } else if (r.kind === 'unreadable') {
        let where = '';
        try {
          where = path.basename(await moveAside(fs, files.project, this.deps.now(), path));
        } catch {
          p.readOnly = 'The project file could not be read or moved aside; nothing is saved.';
        }
        this.deps.notice(
          `The project file could not be read (${r.errors.slice(0, 2).join('; ')}).${where ? ` It was moved to .thirdwheel/${where}.` : ''} Notes start again from the old notes files, if there are any.`,
        );
      }
    }
    if (!p.project) await this.migrateFolder(p);
    this.uniqueNames(p);
    return p;
  }

  /** Old projects (or notes files moved in) may have two markers with one name: renamed once. */
  private uniqueNames(p: Loaded): void {
    if (!p.project || p.newer) return;
    const r = uniqueMarkerNames(p.project);
    if (r.renamed.length === 0) return;
    p.project = r.project;
    p.dirty = true;
    this.deps.notice(renamedMarkersText(r.renamed));
  }

  /** First open of a folder without a project: every `*.thirdwheel.json` in it moves in. */
  private async migrateFolder(p: Loaded): Promise<void> {
    const { fs, path } = this.deps;
    const found = await collectSidecars(fs, p.folder, path).catch(() => ({
      sidecars: [],
      unreadable: [],
    }));
    if (found.unreadable.length > 0) {
      this.deps.notice(
        `Could not read ${found.unreadable
          .map((u) => path.basename(u.file))
          .slice(0, 3)
          .join(', ')} (${found.unreadable[0]?.errors[0] ?? 'unreadable'}); it was left as it is.`,
      );
    }
    if (found.sidecars.length === 0) return;
    const r = migrateSidecars({
      folder: p.folder,
      sidecars: found.sidecars,
      path,
      now: this.deps.now(),
      ...(this.deps.random ? { random: this.deps.random } : {}),
    });
    p.project = r.project;
    for (const m of r.marks) {
      p.marks.set(m.versionId, m);
      p.pendingMarks.add(m.versionId);
    }
    p.dirty = true;
    const n = r.report.sidecars;
    this.deps.notice(
      `Your notes moved into the project (the .thirdwheel folder): ${String(n)} notes file${n === 1 ? '' : 's'}, ${String(r.project.models.length)} part${r.project.models.length === 1 ? '' : 's'}, ${String(r.project.comments.length)} comment${r.project.comments.length === 1 ? '' : 's'}. The old .thirdwheel.json files are left as they were.`,
    );
  }

  /** A model the project doesn't list, with its own old notes file: merged once. */
  private async mergeLateSidecar(p: Loaded, file: string): Promise<void> {
    const { fs, path } = this.deps;
    const sidecar = `${file}${SIDECAR_SUFFIX}`;
    const size = await fs.size(sidecar).catch(() => undefined);
    if (size === undefined) return;
    const parsed = parseAnnotationsJson(await fs.readText(sidecar));
    if (!parsed.ok) {
      this.deps.notice(
        `Could not read ${path.basename(sidecar)} (${parsed.errors[0] ?? 'unreadable'}); it was left as it is.`,
      );
      return;
    }
    if (!p.project) await this.migrateFolder(p);
    // The folder's first migration took this file's notes in.
    if (p.project && versionAtPath(p.project, p.folder, file, path, this.same)) return;
    const r = migrateSidecars({
      folder: p.folder,
      sidecars: [{ modelPath: file, data: parsed.data }],
      path,
      now: this.deps.now(),
      ...(this.deps.random ? { random: this.deps.random } : {}),
      ...(p.project ? { existing: p.project } : {}),
    });
    if (r.report.sidecars === 0) return;
    p.project = r.project;
    for (const m of r.marks) {
      p.marks.set(m.versionId, m);
      p.pendingMarks.add(m.versionId);
    }
    p.dirty = true;
    this.uniqueNames(p);
    this.deps.notice(
      `The notes of ${path.basename(file)} moved into the project; ${path.basename(sidecar)} is left as it was.`,
    );
    if (p === this.current) await this.persist(p);
  }

  private async marksOf(p: Loaded, versionId: string): Promise<VersionMarks | null> {
    if (p.marks.has(versionId)) return p.marks.get(versionId) ?? null;
    if (!p.files || !p.onDisk) return null;
    const r = await readMarks(this.deps.fs, p.files, versionId);
    let marks: VersionMarks | null = null;
    if (r.kind === 'ok') marks = r.data;
    else if (r.kind === 'newer') {
      p.newer = true;
      p.readOnly =
        'Some notes of this project were made by a newer version of Third Wheel. Update the app to change them.';
      this.deps.notice(p.readOnly);
    } else if (r.kind === 'unreadable' && !p.readOnly) {
      const { path } = this.deps;
      const to = await moveAside(
        this.deps.fs,
        p.files.marks(versionId),
        this.deps.now(),
        path,
      ).catch(() => undefined);
      this.deps.notice(
        `The marks of this version could not be read (${r.errors.slice(0, 2).join('; ')}).${to ? ` They were moved to .thirdwheel/marks/${path.basename(to)}.` : ''} The comments are kept.`,
      );
    }
    p.marks.set(versionId, marks);
    return marks;
  }

  // --- current project, lock ---------------------------------------------------------------------

  private stateOf(p: Loaded): ProjectState {
    return {
      name: p.project?.name ?? (this.deps.path.basename(p.folder) || p.folder),
      folder: p.folder,
      exists: p.onDisk,
      ...(p.readOnly ? { readOnly: p.readOnly } : {}),
    };
  }

  private async makeCurrent(p: Loaded): Promise<void> {
    if (this.current !== p) {
      if (this.current) await this.unlock(this.current);
      this.current = p;
    }
    // A project on disk is locked while shown; a new one only when something is written.
    if (p.onDisk || p.dirty) await this.writable(p);
    if (p.dirty) await this.persist(p);
    this.deps.stateChanged(this.stateOf(p));
  }

  /** Everything of `p` is written (`makeCurrent` / `persist` clear `dirty`). */
  private onDiskNow(p: Loaded): boolean {
    return !p.dirty;
  }

  /** The lock file still names this app (another computer may have taken over meanwhile). */
  private async stillMine(p: Loaded): Promise<boolean> {
    if (!p.files) return false;
    const text = await this.deps.fs.readText(p.files.lock).catch(() => '');
    return lockState(parseLock(text), this.deps.self).kind === 'mine';
  }

  private async unlock(p: Loaded): Promise<void> {
    if (!p.locked || !p.files) return;
    p.locked = false;
    const lock = p.files.lock;
    this.releasing = lock;
    try {
      await releaseLock(this.deps.fs, p.files, this.deps.self).catch(() => undefined);
    } finally {
      if (this.releasing === lock) this.releasing = undefined;
    }
  }

  private setReadOnly(p: Loaded, why: string): void {
    p.readOnly = why;
    this.deps.notice(why);
    if (p === this.current) this.deps.stateChanged(this.stateOf(p));
  }

  /** Whether the project may be written now (takes the lock first). */
  private async writable(p: Loaded): Promise<boolean> {
    if (p.readOnly || !p.files) return false;
    if (p.locked) return true;
    const { fs, self } = this.deps;
    try {
      let r = await acquireLock(fs, p.files, self, this.deps.now());
      if (r.kind === 'busy' || r.kind === 'other-host') {
        const take = await this.deps.askTakeOver({
          folder: p.folder,
          host: r.lock.host,
          since: r.lock.started,
          otherHost: r.kind === 'other-host',
        });
        if (!take) {
          this.setReadOnly(
            p,
            r.kind === 'other-host'
              ? `Read-only: this project is open on ${r.lock.host}. Changes are not saved (File ▸ Save project as… keeps them in another folder).`
              : 'Read-only: this project is open in another Third Wheel. Changes are not saved (File ▸ Save project as… keeps them in another folder).',
          );
          return false;
        }
        r = await acquireLock(fs, p.files, self, this.deps.now(), true);
      }
      if (r.kind !== 'acquired') {
        this.setReadOnly(p, 'Read-only: the project is open elsewhere. Changes are not saved.');
        return false;
      }
      p.locked = true;
      return true;
    } catch (e) {
      if (NOT_WRITABLE.has(errorCode(e) ?? '')) {
        this.setReadOnly(
          p,
          "Read-only: this folder can't be written. Changes are kept until you close the app; File ▸ Save project as… saves them in another folder.",
        );
        return false;
      }
      throw e;
    }
  }

  /** Write what changed (project + pending marks). */
  private async persist(p: Loaded, backupOf: readonly string[] = []): Promise<SaveResult> {
    if (!p.files || !p.project || !(await this.writable(p))) {
      return p.readOnly
        ? { ok: true, readOnly: p.readOnly }
        : { ok: false, error: 'Nothing to save' };
    }
    const { fs, path } = this.deps;
    let backup: string | undefined;
    try {
      for (const f of backupOf) {
        if ((await fs.size(f)) === undefined) continue;
        const to = await copyAside(fs, f, this.deps.now(), path);
        backup ??= path.basename(to);
      }
      const marks = [...p.pendingMarks]
        .map((id) => p.marks.get(id))
        .filter((m): m is VersionMarks => !!m);
      await saveProject(fs, p.files, { project: p.project, marks }, this.deps.random);
    } catch (e) {
      if (NOT_WRITABLE.has(errorCode(e) ?? '')) {
        p.locked = false;
        this.setReadOnly(
          p,
          "Read-only: this folder can't be written. Changes are kept until you close the app; File ▸ Save project as… saves them in another folder.",
        );
        return { ok: true, readOnly: p.readOnly as string };
      }
      throw e;
    }
    p.pendingMarks.clear();
    p.dirty = false;
    const created = !p.onDisk;
    p.onDisk = true;
    if (created && p === this.current) this.deps.stateChanged(this.stateOf(p));
    return backup ? { ok: true, backup } : { ok: true };
  }

  // --- saving ------------------------------------------------------------------------------------

  private async saveNow(file: string, text: string, backupFirst: boolean): Promise<SaveResult> {
    const parsed = parseAnnotationsJson(text);
    if (!parsed.ok) throw new Error(`Notes not valid: ${parsed.errors[0] ?? ''}`);
    const notes = parsed.data;
    const p = await this.projectFor(file);
    if (p !== this.current) await this.makeCurrent(p);
    if (p.newer) return { ok: false, error: p.readOnly ?? 'Made by a newer app' };
    await this.prime(p, file);
    const { path } = this.deps;
    const before = p.project
      ? findVersion(p.project, p.folder, file, notes.model.contentHash, path, this.same)
      : undefined;
    const oldMarks = before ? ((await this.marksOf(p, before.version.id)) ?? undefined) : undefined;
    const key = this.idKey(file, notes.model.contentHash);
    const r = applyNotes({
      project: p.project,
      folder: p.folder,
      path,
      file,
      notes,
      now: this.deps.now(),
      ...(this.deps.random ? { random: this.deps.random } : {}),
      same: this.same,
      oldMarks,
      windowComments: this.shownComments.get(key) ?? new Set(),
    });
    // The window now holds these comments (it may delete them later).
    const shown = this.shownComments.get(key) ?? new Set<string>();
    for (const c of notes.comments) shown.add(c.id);
    this.shownComments.set(key, shown);
    let project = r.project;
    if (r.droppedMarkers.length > 0) {
      const part = project.models.find((m) => m.id === r.partId);
      const held = new Set<string>();
      for (const v of part?.versions ?? []) {
        if (v.id === r.versionId) continue;
        for (const m of (await this.marksOf(p, v.id))?.markers ?? []) held.add(m.id);
      }
      project = forgetMarkers(
        project,
        r.droppedMarkers.filter((id) => !held.has(id)),
      );
    }
    p.project = project;
    p.marks.set(r.versionId, r.marks);
    p.pendingMarks.add(r.versionId);
    p.dirty = true;
    const backupOf = backupFirst && p.files ? [p.files.project, p.files.marks(r.versionId)] : [];
    return this.persist(p, backupOf);
  }
}
