/**
 * A loaded model's notes: mesh-only mode, reading the project's notes, moving notes over from an
 * earlier version (revision), the version questions, and the notes as sidecar JSON.
 */
import { DialogQuestion } from '../dialog-question.js';
import {
  type StepModel,
  meshHash,
  type TransferResult,
  transferMeshAnnotations,
  transferAnnotations,
  meshFormatOf,
  bodyFingerprints,
  entityFingerprints,
} from '@third-wheel/geometry';
import { modelEventText } from '../chat-display.js';
import {
  modelIdOf,
  type Annotations,
  type MeshCoverage,
  type TransferSummary,
  sameOverallSize,
  differentPartReason,
  parseAnnotationsJson,
  type VersionCandidate,
  earlierVersions,
  type BodyFingerprint,
  formatJson,
} from '@third-wheel/core';
import type { OpenedVersion, ModelFile, ModelVersionFile } from '../../../shared/ipc.js';
import {
  type SidecarCheck,
  checkSidecar,
  fromAnnotations,
  applyPaint,
  type SidecarInput,
  toAnnotations,
} from '../sidecar.js';
import { PaintLayer } from '../paint.js';
import {
  type PreviousAnnotations,
  revisionResult,
  hasNotes,
  keptOwnText,
  matchFacts,
  matchMarkersByName,
  matchText,
  type MatchedMarkers,
  ownMarkersQuestion,
  withoutMarkersOf,
  mergeMarkers,
  keptAlsoText,
  sameGeometry,
  carriedText,
  transferSummary,
  meshMovedText,
  movedText,
  placedAndLost,
  differentPartNote,
  waitingText,
  meshQuestion,
  versionQuestionText,
} from '../revision.js';
import { stepTreeOf } from '../body-list.js';
import { ModelLoader } from '../model-loader.js';
import {
  applyFilterButtons,
  askChoice,
  bodyFolders,
  byId,
  chatPanel,
  comments,
  commentsPanel,
  count,
  droppedFieldsText,
  filterButtons,
  forgetShownPart,
  markers,
  markersPanel,
  paint,
  previousVersion,
  sessionModels,
  setBackupBeforeWrite,
  setLinkWarning,
  setPaint,
  setPartMayChange,
  setPreviousVersion,
  setRevisionInfo,
  setVersionHint,
  addNotice,
  noticeMark,
  showAlert,
  showNotice,
  viewport,
} from '../main.js';

// --- Mesh-only mode -------------------------------------------------------
const meshBanner = byId('mesh-banner');
byId('mesh-banner-close').addEventListener('click', () => {
  meshBanner.hidden = true;
});
/** STL / 3MF: banner on, selection filter off (paint, smart fill and comments work as usual). */
export function applyMeshMode(model: StepModel): void {
  const format = model.meshFormat;
  meshBanner.hidden = format === undefined;
  markersPanel.setMeshOnly(format !== undefined);
  byId('mesh-banner-text').textContent = format
    ? `Mesh file (${format.toUpperCase()}): brush, smart fill and comments only. ` +
      'Entity selection needs STEP: export one from your CAD to pick faces, edges and corners.'
    : '';
  for (const btn of filterButtons.values()) {
    btn.disabled = format !== undefined;
    if (format) btn.title = 'Entity selection needs STEP (this is a mesh file)';
  }
  if (!format) applyFilterButtons();
}

/** Mesh hash per model, worked out once; written to the sidecar, compared on revisions. */
const meshHashes = new WeakMap<StepModel, string>();
async function meshHashOf(model: StepModel): Promise<string> {
  let h = meshHashes.get(model);
  if (!h) {
    h = await meshHash(model);
    meshHashes.set(model, h);
  }
  return h;
}

/** Error text without Electron's "Error invoking remote method …" prefix. */
export function ipcErrorText(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(
    /^Error invoking remote method '[^']+': (Error: )?/,
    '',
  );
}

/** The agent's `load_model` is loading a model now (the chat's event line says so). */
export let loadingForAgent = false;
/** Sets `loadingForAgent` from another module (an import can't be assigned). */
export function setLoadingForAgent(value: typeof loadingForAgent): void {
  loadingForAgent = value;
}
/**
 * A grey line in the chat: "Opened bracket_v2.step — new version of bracket.step". Nothing when
 * the same file with the same contents was shown again. Main saves it with the next message.
 */
export function postModelEvent(
  file: { readonly path: string; readonly name: string; readonly contentHash: string },
  before: { readonly path: string; readonly contentHash: string } | undefined,
): void {
  const same = before?.path === file.path;
  if (same && before.contentHash === file.contentHash) return;
  const prev = previousVersion;
  const versionOf = !same && prev && prev.path !== file.path ? prev.name : undefined;
  const text = modelEventText(
    file.name,
    same ? 'reloaded' : loadingForAgent ? 'agent' : 'opened',
    versionOf,
  );
  void window.thirdWheel
    ?.chatPost({ kind: 'event', text, path: file.path, modelId: modelIdOf(file.contentHash) })
    .then((entry) => {
      if (entry) chatPanel.added(entry);
    })
    .catch(() => undefined);
}

/** An earlier version a file is (or becomes) made from. `contentHash` unknown: its file is gone. */
interface EarlierVersion {
  readonly path: string;
  readonly name: string;
  readonly contentHash: string | undefined;
}

/** The shown file's notes checked against the model; undefined = none (or unusable, backed up). */
async function ownNotes(
  opened: OpenedVersion,
  file: ModelFile,
  model: StepModel,
  name: string,
): Promise<Extract<SidecarCheck, { ok: true }> | undefined> {
  if (opened.notes === null) return undefined;
  const check = checkSidecar(opened.notes, file.contentHash, model);
  if (check.ok) return check;
  await backupUnusable(file.path, file.contentHash, name, check.detail);
  return undefined;
}

type NotesFrom = {
  readonly before:
    { path: string; name: string; contentHash: string; model: StepModel } | undefined;
  readonly revisionOf: { readonly path: string; readonly name: string } | undefined;
  readonly askVersion: boolean;
};
type AfterLoad = { removedLinks?: string; differentPart?: DifferentPart };

/**
 * The user added a new version (STEP → STEP) that looks like another part: asked once the model
 * is shown, before the moved markers are saved (`askDifferentPart`).
 */
export interface DifferentPart {
  readonly reason: string;
  readonly file: { readonly path: string; readonly name: string; readonly contentHash: string };
  readonly parent: { readonly path: string; readonly name: string; readonly contentHash: string };
}

/** The loaded notes: `save` = save now (carried / moved over); `differentPart` = ask first. */
export interface LoadedNotes {
  readonly save: boolean;
  readonly differentPart?: DifferentPart;
}

/**
 * The shown file's notes from its project (one that can't be read is moved aside and the
 * model starts empty), and the version it is made from: named by `revisionOf` (the AI, Add
 * new version), the file's own older contents (saved over), a guess the user confirmed, or
 * the project's list. A new link goes into the project first (one earlier version per file, no
 * circles). Paint the version has of its own is kept; else the earlier version's notes come
 * over — as they are when the geometry is the same (returns true: save now), else moved by
 * matching geometry. Comments belong to the part, so they are the same on every version.
 */
export async function loadAnnotations(
  file: ModelFile,
  model: StepModel,
  layer: PaintLayer,
  from: NotesFrom,
): Promise<LoadedNotes> {
  const mark = noticeMark();
  // Said after the load's own notice: links that went when two parts became one.
  const after: AfterLoad = {};
  const save = await loadNotes(file, model, layer, from, after);
  if (after.removedLinks) addNotice(after.removedLinks, mark);
  return { save, ...(save && after.differentPart ? { differentPart: after.differentPart } : {}) };
}

async function loadNotes(
  file: ModelFile,
  model: StepModel,
  layer: PaintLayer,
  from: NotesFrom,
  after: AfterLoad,
): Promise<boolean> {
  const name = `the notes of ${file.name}`; // kept in the project (.thirdwheel folder)
  setBackupBeforeWrite(undefined);
  setLinkWarning(undefined);
  await meshHashOf(model); // for the notes (sync `build`) and the revision check
  const api = window.thirdWheel;
  if (!api) return false;
  // Read now, after the previous model's last save (`flushSync`): reopening the same file must
  // see what was just written, not a copy read when the import started.
  let opened: OpenedVersion;
  try {
    opened = await api.openVersion(file.path, file.contentHash);
  } catch (err) {
    const why = ipcErrorText(err);
    // Keep it safe from the first auto-save: it may still be fine (e.g. only too big to read here).
    let backup: string | null = null;
    try {
      backup = await api.backupSidecar(file.path, file.contentHash);
    } catch (e) {
      console.error('Could not back up the notes', e);
    }
    showAlert(
      'Annotations not loaded',
      backup
        ? `Could not read ${name} (${why}). It was moved to ${backup}; the model starts without annotations.`
        : `Could not read ${name} (${why}). The model starts without annotations; changes you make will try to replace it.`,
    );
    return false;
  }
  // Names are unique in the project: the markers of its other parts / versions take theirs.
  markers.setOthers(opened.otherMarkers ?? []);
  let own = await ownNotes(opened, file, model, name);
  const showOwn = (): void => {
    if (own) applyAnnotations(own.doc, own.droppedFields, name, model, layer, file.path);
  };
  const newerNotice = (): void => {
    if (opened.newer)
      showNotice(`There's a newer version: ${opened.newer.name}. Open it from Versions ▾.`);
  };
  // Saved over in place since: one file name = one version, so its listed version takes the new
  // contents. Its paint (read first) belongs to the old geometry: moved onto the new one below
  // (the save then replaces it), else moved aside to a backup (`dropOldPaint`).
  let selfPrev: PreviousAnnotations | undefined;
  let oldPaint = false;
  const dropOldPaint = async (): Promise<string | null> => {
    if (!oldPaint) return null;
    oldPaint = false;
    let backup: string | null = null;
    try {
      backup = await api.backupSidecar(file.path, file.contentHash);
      opened = await api.openVersion(file.path, file.contentHash);
      own = await ownNotes(opened, file, model, name);
    } catch (err) {
      console.error('Could not move the old paint aside', err);
    }
    return backup;
  };
  if (opened.replaced) {
    const old = opened.replaced;
    const read = old.hasNotes ? await readPreviousSidecar(old, old.contentHash) : undefined;
    try {
      await api.replaceVersionContents(file.path, old.contentHash, file.contentHash);
      opened = await api.openVersion(file.path, file.contentHash);
    } catch (err) {
      console.warn(`Could not give ${file.name}'s version its new contents`, err);
      showAlert(
        'Annotations not loaded',
        `${file.name} changed on disk, but its notes could not be updated (${ipcErrorText(err)}). The model starts without annotations; they stay with the earlier contents.`,
      );
      return false;
    }
    oldPaint = opened.hasMarks;
    // Its stored paint is the old contents' (moved below, or moved aside): never read as its own.
    if (read && !model.meshFormat) selfPrev = { ...read, own: true };
    else if (!oldPaint) own = await ownNotes(opened, file, model, name);
    else {
      const backup = await dropOldPaint();
      if (backup && model.meshFormat)
        showNotice(
          `${file.name} changed on disk. Paint can't move onto a changed mesh, so it starts without paint (the earlier paint was kept as ${backup}); comments stay.`,
        );
    }
  }
  if (model.meshFormat) {
    // A mesh shows its own notes; notes never move onto a mesh.
    showOwn();
    if (!opened.replaced) newerNotice();
    return false;
  }

  // Which version is it made from?
  let parent: EarlierVersion | undefined;
  /** The earlier version's notes, when already read (the "new version of …?" question). */
  let prevNotes: PreviousAnnotations | undefined;
  const named = from.revisionOf && from.revisionOf.path !== file.path ? from.revisionOf : undefined;
  const namedHash = named ? await contentsOf(named, from.before) : undefined;
  /** The user kept its listed earlier version; with contents saved over, those move on. */
  let keptOwnParent = false;
  const ownParent = opened.parent;
  if (
    named &&
    namedHash &&
    ownParent &&
    (ownParent.path !== named.path || ownParent.contentHash !== namedHash)
  ) {
    // A file has one earlier version. The user picks; for the AI the new link wins.
    if (from.askVersion) {
      if (await askKeepParent(file, named, { name: ownParent.name })) {
        if (!selfPrev) {
          showOwn();
          newerNotice();
          return false; // a plain open: nothing of the named file
        }
        keptOwnParent = true; // its own paint (saved over) still moves onto the new contents
      }
    } else
      setLinkWarning(
        `${file.name} was linked as a newer version of ${ownParent.name}; it is now a newer version of ${named.name} instead.`,
      );
  }
  const prevInMemory =
    from.before?.path === file.path && from.before.contentHash !== file.contentHash
      ? from.before.model
      : undefined;
  if (selfPrev && (!named || keptOwnParent)) {
    // Its own paint onto its new contents; nothing to link (the same version).
    return useRevision(selfPrev, file, model, layer, {
      prevPath: file.path,
      prevName: file.name,
      prevModel: prevInMemory,
      before: from.before,
      onFail: dropOldPaint,
    });
  }
  await dropOldPaint(); // its own paint doesn't move (another earlier version was named)
  if (named && !keptOwnParent) {
    parent = { ...named, contentHash: namedHash };
  } else if (from.before && prevInMemory) {
    // Reloaded with new contents and nothing to move: the same version (if listed), compare in memory.
    showOwn();
    newerNotice();
    setPreviousVersion({ path: file.path, name: file.name, carried: false, model: prevInMemory });
    return false;
  } else if (opened.replaced) {
    showOwn(); // saved over, its old contents had no paint: the part's comments, if any
    newerNotice();
    return false;
  } else if (!opened.listed && !own) {
    // A new file name. The user is asked about a likely earlier version; the AI gets a hint.
    if (from.askVersion) {
      prevNotes = await askEarlierVersion(file, model);
      if (prevNotes)
        parent = {
          path: prevNotes.path,
          name: prevNotes.name,
          contentHash: prevNotes.doc.model.contentHash,
        };
    } else {
      const session = await sessionEarlierVersion(file, model);
      const mesh = session ? undefined : await sameSizeMesh(file, model);
      setVersionHint(session ?? (mesh ? { modelId: mesh.modelId, name: mesh.name } : undefined));
    }
  } else if (!opened.hasMarks && opened.parent?.hasNotes) {
    parent = opened.parent; // linked before, its notes never came over (e.g. the app closed)
  }
  if (!parent) {
    showOwn();
    newerNotice();
    if (from.revisionOf) {
      setPreviousVersion({ ...from.revisionOf, carried: false });
      setRevisionInfo(revisionResult(from.revisionOf, own ? 'own' : 'none'));
    }
    return false;
  }

  // The link goes into the project first; it may join another part (its comments then show).
  const isParent =
    opened.parent?.path === parent.path && opened.parent.contentHash === parent.contentHash;
  if (parent.contentHash !== undefined && !isParent) {
    try {
      const r = await api.linkProjectVersion(file.path, file.contentHash, {
        path: parent.path,
        contentHash: parent.contentHash,
      });
      if (r.kind === 'circle') {
        setLinkWarning(
          `${file.name} is an earlier version of ${parent.name}, so it was not linked as a newer one (that would make a circle).`,
        );
        console.warn('Version link refused (circle)', file.path, parent.path);
        showOwn();
        newerNotice();
        return false;
      }
      if (r.kind === 'linked') {
        if (r.removedLinks) after.removedLinks = removedLinksNotice(r.removedLinks);
        setPartMayChange(true);
        forgetShownPart(); // parts may have joined: a lookup in flight has the old one
        opened = await api.openVersion(file.path, file.contentHash);
        own = await ownNotes(opened, file, model, name);
      }
    } catch (err) {
      console.warn(`Could not link ${file.name} to ${parent.name}`, err);
      showNotice(
        `Couldn't list ${file.name} as a newer version of ${parent.name}: ${ipcErrorText(err)}`,
      );
      showOwn();
      return false; // nothing moved: it would land in a part of its own
    }
  }
  const prevModel = from.before?.path === parent.path ? from.before.model : undefined;
  const read = prevNotes ?? (await readPreviousSidecar(parent, parent.contentHash, !named));
  // Its own older contents (saved over): the notices say "changed on disk".
  const previous = read ? { ...read, own: parent.path === file.path } : undefined;
  // Markers of its own (its comments are the part's, shared with the earlier version): the user
  // picks whose markers to use (its own / the earlier version's / both) when the earlier version
  // has markers too; the AI is never asked (its own are kept).
  let merge: Annotations | undefined;
  let match: MatchedMarkers | undefined;
  let backup: string | null = null;
  if (own && hasNotes({ ...own.doc, comments: [] })) {
    const ownBefore = own.doc;
    const both = previous !== undefined && hasNotes({ ...previous.doc, comments: [] });
    const answer = both && from.askVersion ? await askOwnMarkers(file.name, previous) : 'keep';
    if (answer !== 'replace') {
      // Its own markers stay; one named like a marker of the part is that marker.
      match = matchMarkersByName(own.doc, previous?.doc.markers ?? []);
      own = { ...own, doc: match.doc };
    }
    if (answer === 'keep') {
      // The earlier version's markers a shared comment names are listed too (faded when empty).
      showOwn();
      setPreviousVersion({
        path: parent.path,
        name: parent.name,
        carried: false,
        ...(prevModel ? { model: prevModel } : {}),
      });
      setRevisionInfo({ ...revisionResult(parent, 'own'), ...matchFacts(match) });
      if (named && from.askVersion) showNotice(keptOwnText(file.name, parent.name, match));
      return match !== undefined && match.doc !== ownBefore; // matched / recoloured markers are saved
    }
    if (answer === 'merge') merge = own.doc;
    else {
      // Replace: its own paint is moved aside first (a backup copy of the project too).
      try {
        backup = await api.backupSidecar(file.path, file.contentHash);
      } catch (err) {
        console.error('Could not back up the markers', err);
        showAlert(
          'Markers not replaced',
          `Could not keep a backup of the markers of ${file.name} (${ipcErrorText(err)}), so they were left as they are.`,
        );
        showOwn();
        return false;
      }
    }
  }
  if (!previous) {
    showOwn(); // the part's comments, if any
    setPreviousVersion({
      path: parent.path,
      name: parent.name,
      carried: false,
      ...(prevModel ? { model: prevModel } : {}),
    });
    setRevisionInfo(revisionResult(parent, 'none'));
    return false;
  }
  return useRevision(previous, file, model, layer, {
    prevPath: parent.path,
    prevName: parent.name,
    prevModel,
    before: from.before,
    merge,
    match,
    backup,
    ...(parent.contentHash !== undefined && from.askVersion
      ? { ask: { contentHash: parent.contentHash, after } }
      : {}),
  });
}

/** "Removed 2 links between versions of bracket." */
function removedLinksNotice(r: { readonly count: number; readonly partName: string }): string {
  return `Removed ${count.format(r.count)} ${r.count === 1 ? 'link' : 'links'} between versions of ${r.partName}.`;
}

/** A new version with markers of its own: use them / the earlier version's / both. */
async function askOwnMarkers(
  name: string,
  prev: PreviousAnnotations,
): Promise<'keep' | 'replace' | 'merge'> {
  const q = ownMarkersQuestion(name, prev.name);
  const answer = await askChoice(q.title, q.text, q.keep, q.replace, q.merge, {
    first: q.tips.keep,
    second: q.tips.replace,
    third: q.tips.merge,
  });
  return answer === 'second' ? 'replace' : answer === 'third' ? 'merge' : 'keep';
}

/**
 * The previous version's annotations onto the new model: carried over as they are
 * when the geometry is the same, else moved by matching geometry (`transferAnnotations`). The
 * earlier version keeps its own paint either way (a mesh too). True = save now.
 */
async function useRevision(
  previous: PreviousAnnotations,
  file: ModelFile,
  model: StepModel,
  layer: PaintLayer,
  at: {
    readonly prevPath: string;
    readonly prevName: string;
    readonly prevModel: StepModel | undefined;
    readonly before: { contentHash: string; model: StepModel } | undefined;
    /** Merge: the new file's own notes, kept; only the earlier version's other markers move. */
    readonly merge?: Annotations | undefined;
    /** Merge: which of its markers were matched by name / recoloured (for the notice). */
    readonly match?: MatchedMarkers | undefined;
    /** Replace: where its own markers went. */
    readonly backup?: string | null;
    /** Saved over in place: moving failed — its old paint is moved aside (the backup's name). */
    readonly onFail?: () => Promise<string | null>;
    /** The user loaded it (questions may be asked): a likely other part goes into `after`. */
    readonly ask?: { readonly contentHash: string; readonly after: AfterLoad };
  },
): Promise<boolean> {
  const { prevPath, prevName, prevModel, merge } = at;
  const backup = at.backup ?? null;
  if (merge) previous = { ...previous, doc: withoutMarkersOf(previous.doc, merge) };
  const result = (doc: Annotations): Annotations => (merge ? mergeMarkers(merge, doc) : doc);
  const keptNote = merge ? ` ${keptAlsoText(file.name, merge)}${matchText(at.match)}` : '';
  const name = `the notes of ${file.name}`; // kept in the project (.thirdwheel folder)
  const newHash = await meshHashOf(model);
  // Older notes have no mesh hash: the previous model, if it is still in memory and
  // the notes were made for it, gives one.
  const oldHash =
    prevModel && previous.doc.model.contentHash === at.before?.contentHash
      ? await meshHashOf(prevModel)
      : undefined;
  const same = sameGeometry(previous.doc, newHash, model.tessellation, oldHash);
  setPreviousVersion({
    path: prevPath,
    name: prevName,
    doc: previous.doc,
    carried: same,
    ...(prevModel ? { model: prevModel } : {}),
  });
  setRevisionInfo(revisionResult(previous, same ? 'carried' : 'waiting', previous.doc));
  if (same) {
    applyAnnotations(result(previous.doc), previous.droppedFields, name, model, layer, file.path);
    showNotice(`${carriedText(previous, file.name, backup)}${keptNote}`);
    return true;
  }
  // Notes of a mesh file (STL / 3MF) go onto the STEP after lining the files up; the
  // mesh's own triangles help (read again when it's no longer in memory).
  const fromMesh = previous.doc.model.format !== 'step';
  const mesh = fromMesh ? await meshOfPrevious(prevPath, prevModel) : undefined;
  // Move them onto the new geometry. Every marker and comment comes over (lost ones with
  // their old place); a failure leaves the model empty and the annotations where they were.
  try {
    const t0 = performance.now();
    let coverage: MeshCoverage | undefined;
    let moved: TransferResult;
    if (fromMesh) {
      const r = transferMeshAnnotations(previous.doc, model, mesh);
      coverage = r.coverage;
      moved = r;
    } else moved = transferAnnotations(previous.doc, model);
    // Another file named as a new version: does it look like another part? (A mesh has its own
    // warning; the same file saved over is that version, whatever it shows.)
    const looksDifferent =
      fromMesh || previous.own
        ? undefined
        : differentPartReason(
            previous.doc.bodies ?? (prevModel ? fingerprintsOf(prevModel).bodies : undefined),
            fingerprintsOf(model).bodies,
            placedAndLost(previous.doc, moved.status),
          );
    const sum: TransferSummary = {
      ...transferSummary(previous.doc, moved.status),
      ...(coverage ? { fromMesh: coverage } : {}),
      ...(looksDifferent ? { looksDifferent } : {}),
    };
    console.info(
      `Revision: annotations moved in ${(performance.now() - t0).toFixed(0)} ms`,
      sum.flagged,
      coverage ?? '',
    );
    applyAnnotations(
      result(moved.annotations),
      previous.droppedFields,
      name,
      model,
      layer,
      file.path,
    );
    setRevisionInfo(revisionResult(previous, 'moved', previous.doc, sum));
    showNotice(
      `${
        coverage
          ? meshMovedText(previous, file.name, sum, coverage, backup)
          : movedText(previous, file.name, sum, backup)
      }${keptNote}${
        looksDifferent && !at.ask ? differentPartNote(file.name, prevName, looksDifferent) : ''
      }`,
    );
    if (looksDifferent && at.ask)
      at.ask.after.differentPart = {
        reason: looksDifferent,
        file: { path: file.path, name: file.name, contentHash: file.contentHash },
        parent: { path: prevPath, name: prevName, contentHash: at.ask.contentHash },
      };
    return true;
  } catch (err) {
    console.error('Revision: moving the annotations failed', err);
    // Nothing half-loaded: the model starts empty, as the pop-up says.
    markers.reset(true); // same project: its other markers' names stay taken
    comments.reset();
    commentsPanel.reset();
    bodyFolders.reset(stepTreeOf(model));
    setPaint(new PaintLayer(model.triangleFace.length, model));
    viewport.setPaint(paint);
  }
  setRevisionInfo(revisionResult(previous, 'waiting', previous.doc));
  const kept = (await at.onFail?.()) ?? null;
  showAlert('New version of the model', waitingText(previous, file.name, '', backup ?? kept));
  console.warn('Revision: annotations kept, not moved', previous.path);
  return false;
}

/** Reads mesh files again to move their notes onto a STEP (not kept: only their triangles are needed, once). */
const meshLoader = new ModelLoader();

/**
 * The mesh whose notes go onto a STEP — in memory when it was the shown model, else read
 * again (files opened this session can be). Undefined: gone or unreadable (the notes alone are
 * then lined up, from their paint points and body boxes).
 */
async function meshOfPrevious(
  path: string,
  inMemory: StepModel | undefined,
): Promise<StepModel | undefined> {
  if (inMemory?.meshFormat) return inMemory;
  const api = window.thirdWheel;
  if (!api) return undefined;
  try {
    const file = await api.rereadModelFile(path);
    if (!meshFormatOf(file.name)) return undefined;
    return (await meshLoader.load(file, () => undefined))?.model;
  } catch (err) {
    console.warn('Mesh → STEP: could not read the mesh again; lining up from its notes only', err);
    return undefined;
  } finally {
    meshLoader.release();
  }
}

/**
 * A mesh file of this session (latest first) with notes whose parts have the same overall
 * size as `model` — likely the same part, exported as STL / 3MF before the STEP existed. File
 * names usually differ, so the file-name rules (versions.ts) can't tell.
 */
async function sameSizeMesh(
  file: ModelFile,
  model: StepModel,
): Promise<(PreviousAnnotations & { readonly modelId: string }) | undefined> {
  if (model.meshFormat || separateParts.has(file.path)) return undefined;
  const mine = fingerprintsOf(model).bodies;
  const meshes = [...sessionModels]
    .reverse()
    .map(([modelId, { model: m }]) => ({ path: m.path, modelId, m }))
    .filter(({ m }) => m.path !== file.path && meshFormatOf(m.name));
  for (const { modelId, m } of await inOwnProject(file, meshes)) {
    const prev = await readPreviousSidecar(m, undefined, true);
    if (!prev || prev.doc.markers.length + prev.doc.comments.length === 0) continue;
    if (prev.unlinked) continue; // removed from its versions by the user
    if (prev.doc.bodies && sameOverallSize(prev.doc.bodies, mine)) return { ...prev, modelId };
  }
  return undefined;
}

/**
 * Only the candidates in `file`'s own project: a model never becomes a version of one in another
 * project (opened by double-click, drag or Open folder…, it starts in its own).
 */
async function inOwnProject<T extends { readonly path: string }>(
  file: ModelFile,
  list: readonly T[],
): Promise<T[]> {
  const api = window.thirdWheel;
  if (!api || list.length === 0) return [];
  try {
    const [mine, ...theirs] = await api.projectFolders([file.path, ...list.map((c) => c.path)]);
    return mine ? list.filter((_, i) => theirs[i] === mine) : [];
  } catch (err) {
    console.warn('Could not check which project the files belong to', err);
    return [];
  }
}

/** The contents (hash) of `file`: the shown model from memory, else read on disk; undefined = gone. */
async function contentsOf(
  file: { readonly path: string },
  before: { path: string; contentHash: string } | undefined,
): Promise<string | undefined> {
  if (before?.path === file.path) return before.contentHash;
  try {
    const [state] = (await window.thirdWheel?.versionFileStates([file.path])) ?? [];
    return state?.contentHash ?? undefined;
  } catch (err) {
    console.warn('Could not check the earlier version', err);
    return undefined;
  }
}

/** "Which file is X a newer version of?" — true = keep its own earlier version. */
async function askKeepParent(
  file: ModelFile,
  earlier: { readonly name: string },
  ownParent: { readonly name: string },
): Promise<boolean> {
  const answer = await askChoice(
    `Which file is ${file.name} a newer version of?`,
    `${file.name} is already linked as a newer version of ${ownParent.name}. A file has one earlier version, so pick the right one. Both files keep their notes; only the link moves.`,
    earlier.name,
    `${ownParent.name} (keep)`,
  );
  return answer !== 'first';
}

/** An unreadable sidecar: renamed to a backup, pop-up, the model starts empty. */
async function backupUnusable(
  modelPath: string,
  contentHash: string,
  name: string,
  detail: string,
): Promise<void> {
  let backup: string | null = null;
  try {
    backup = (await window.thirdWheel?.backupSidecar(modelPath, contentHash)) ?? null;
  } catch (err) {
    console.error('Could not back up the sidecar', err);
  }
  const kept = backup
    ? `They were moved to ${backup}; the model starts without annotations.`
    : `It was left as it is; changes you make now will replace it.`;
  showAlert('Annotations not loaded', `Could not read ${name} (${detail}). ${kept}`);
  console.warn('Sidecar not used:', detail);
}

/**
 * The notes of an earlier version (to bring over), if usable. `contentHash`: exactly that version
 * (else the one its path stands for now). `unlinked`: the user took it out of its versions.
 */
async function readPreviousSidecar(
  prev: { readonly path: string; readonly name: string },
  contentHash?: string,
  quiet = false,
): Promise<(PreviousAnnotations & { readonly unlinked: boolean }) | undefined> {
  let opened: OpenedVersion | undefined;
  try {
    opened = await window.thirdWheel?.openVersion(prev.path, contentHash);
  } catch (err) {
    if (!quiet) showNotice(`Couldn't read the annotations of ${prev.name}: ${ipcErrorText(err)}`);
    return undefined;
  }
  if (!opened?.notes) return undefined;
  const parsed = parseAnnotationsJson(opened.notes);
  if (!parsed.ok) {
    if (!quiet)
      showNotice(
        `Couldn't read the annotations of ${prev.name} (${parsed.errors[0] ?? 'unknown'}).`,
      );
    return undefined;
  }
  return {
    doc: parsed.data,
    droppedFields: parsed.droppedFields,
    ...prev,
    own: false,
    unlinked: opened.unlinked === true,
  };
}

/** Files the user said are separate parts, not new versions: not asked again this session. */
const separateParts = new Set<string>();

/** Models of this session (and files in the folder) that may be earlier versions of `file`. */
function versionCandidates(
  file: ModelFile,
  folder: readonly ModelVersionFile[],
): VersionCandidate[] {
  const byPath = new Map<string, VersionCandidate>();
  let order = 0;
  for (const { model, bodyNames } of sessionModels.values()) {
    order++;
    if (model.path === file.path || !bodyNames) continue;
    // Notes don't move between mesh and STEP files (except mesh → STEP, above).
    if (meshFormatOf(model.name) || meshFormatOf(file.name)) continue;
    byPath.set(model.path, { path: model.path, name: model.name, session: { bodyNames, order } });
  }
  for (const f of folder) byPath.set(f.path, { ...byPath.get(f.path), ...f });
  return [...byPath.values()];
}

/**
 * The user opened a file without notes. When it looks like a newer version of a file with
 * notes (versioned name in its folder or this session, or same body names), ask whether to bring
 * them over. The answer's annotations, or undefined (nothing fits, or "Separate part").
 */
async function askEarlierVersion(
  file: ModelFile,
  model: StepModel,
): Promise<PreviousAnnotations | undefined> {
  const api = window.thirdWheel;
  if (!api || separateParts.has(file.path)) return undefined;
  let folder: ModelVersionFile[] = [];
  try {
    folder = await api.listModelVersions(file.path);
  } catch (err) {
    console.warn('Could not look for other versions', err);
  }
  const found = earlierVersions(
    { path: file.path, name: file.name, bodyNames: model.bodyNames },
    versionCandidates(file, folder),
  );
  // Folder files without a sidecar have nothing to bring over.
  const withNotes = found.filter((f) => f.session || f.sidecarMtimeMs !== undefined).slice(0, 5);
  for (const c of await inOwnProject(file, withNotes)) {
    const prev = await readPreviousSidecar(c, undefined, true);
    if (!prev || prev.doc.markers.length + prev.doc.comments.length === 0) continue;
    if (prev.unlinked) continue; // removed from its versions by the user
    const answer = await askVersionQuestion(file.name, prev);
    if (answer === 'separate') separateParts.add(file.path);
    return answer === 'bring' ? prev : undefined;
  }
  // A mesh with notes opened this session, same size.
  const mesh = await sameSizeMesh(file, model);
  if (mesh) {
    const answer = await askVersionQuestion(file.name, mesh, meshQuestion(file.name, mesh));
    if (answer === 'separate') separateParts.add(file.path);
    return answer === 'bring' ? mesh : undefined;
  }
  return undefined;
}

/**
 * AI load without `revisionOf`: the model of this session it looks like a newer copy of —
 * not one the user removed from its version chain.
 */
async function sessionEarlierVersion(
  file: ModelFile,
  model: StepModel,
): Promise<{ modelId: string; name: string } | undefined> {
  const found = earlierVersions(
    { path: file.path, name: file.name, bodyNames: model.bodyNames },
    versionCandidates(file, []),
  );
  for (const best of await inOwnProject(file, found.slice(0, 5))) {
    const prev = await readPreviousSidecar(best, undefined, true);
    if (prev?.unlinked) continue;
    for (const [modelId, { model: m }] of sessionModels)
      if (m.path === best.path) return { modelId, name: m.name };
  }
  return undefined;
}

// The question "Is this a new version of …?". Like Google Drive's "Replace / Keep both".
const versionDialog = byId('version-dialog') as HTMLDialogElement;
versionDialog.addEventListener('keydown', (e) => {
  // Tool shortcuts must not fire behind it. Once closed, its button can keep focus until the
  // next frame: keys pressed then (Cmd+I right after an answer) must not be lost.
  if (versionDialog.open) e.stopPropagation();
});
const versionQuestion = new DialogQuestion(versionDialog);
/** Ask; Esc or another load closing it = neither (asked again next time). */
function askVersionQuestion(
  name: string,
  prev: PreviousAnnotations,
  words?: { readonly title: string; readonly text: string },
): Promise<'bring' | 'separate' | 'none'> {
  return versionQuestion
    .ask(() => {
      byId('version-title').textContent =
        words?.title ?? `Is ${name} a new version of ${prev.name}?`;
      byId('version-text').textContent = words?.text ?? versionQuestionText(name, prev);
    })
    .then((v) => (v === 'bring' || v === 'separate' ? v : 'none'));
}
export function closeVersionQuestion(): void {
  if (versionDialog.open) versionDialog.close('');
}

/** A checked sidecar document into the app state; reports what didn't fit. */
function applyAnnotations(
  doc: Annotations,
  droppedFields: readonly string[],
  name: string,
  model: StepModel,
  layer: PaintLayer,
  modelPath: string,
): void {
  const loaded = fromAnnotations(doc, model);
  markers.load(loaded.markers);
  applyPaint(layer, loaded.paint);
  comments.load(loaded.comments);
  const droppedRows = bodyFolders.load(doc.bodyTree);
  viewport.paintChanged();
  if (droppedFields.length > 0 || loaded.dropped + droppedRows > 0) {
    setBackupBeforeWrite(modelPath);
  }
  if (droppedFields.length > 0) {
    showAlert('Some annotation data will be removed', droppedFieldsText(name, droppedFields));
  }
  if (loaded.dropped + droppedRows > 0) {
    const n = count.format(loaded.dropped + droppedRows);
    showNotice(
      `Annotations loaded from ${name}, but ${n} painted triangles or items didn't fit the model and were left out. Your next change keeps a backup copy of the file first.`,
    );
  }
}

/** Body fingerprints per model (one mesh pass; the model never changes once loaded). */
const bodyPrints = new WeakMap<StepModel, BodyFingerprint[]>();
function fingerprintsOf(model: StepModel): NonNullable<SidecarInput['fingerprints']> {
  let bodies = bodyPrints.get(model);
  if (!bodies) {
    bodies = bodyFingerprints(model, model.bodyCount);
    bodyPrints.set(model, bodies);
  }
  return { bodies, entities: (refs) => entityFingerprints(model, refs, bodies) };
}

/** The shown model's annotations as sidecar JSON. */
export function sidecarText(fileName: string, contentHash: string, model: StepModel): string {
  if (!paint) throw new Error('No paint layer');
  return formatJson(
    toAnnotations({
      fileName,
      contentHash,
      meshHash: meshHashes.get(model),
      model,
      markers: markers.list(),
      comments: comments.list(),
      paint,
      bodyTree: bodyFolders.data(),
      fingerprints: fingerprintsOf(model),
    }),
  );
}
