/**
 * Opening a model: start page, progress, body list, and `loadModel` (the one path every open
 * takes: menu, double-click, the AI's `load_model`).
 */
import { shortcutLabel, listClickMode } from '../../../shared/shortcuts.js';
import { ModelLoader } from '../model-loader.js';
import { BodyFolders, type FolderEditKind } from '../body-folders.js';
import { BodyList, stepTreeOf } from '../body-list.js';
import { PerfProbe, perfModeFromUrl } from '../perf-probe.js';
import { type Annotations, type RevisionInfo, modelIdOf } from '@third-wheel/core';
import type { StepModel } from '@third-wheel/geometry';
import type { ModelFile } from '../../../shared/ipc.js';
import { ExactValues } from '../info-format.js';
import { PaintLayer } from '../paint.js';
import {
  applyGhosts,
  applyMeshMode,
  askDifferentPart,
  autosave,
  byId,
  closeDifferentPartQuestion,
  closeVersionQuestion,
  comments,
  commentsPanel,
  contextMenu,
  endCompare,
  hideNotice,
  history,
  ipcErrorText,
  isMac,
  keepLeavingReview,
  loadAnnotations,
  markers,
  modelStatus,
  postModelEvent,
  queuePins,
  refreshStartPage,
  renderInfo,
  renderSaveStatus,
  renderSendToAi,
  renderStatus,
  renderTitle,
  renderVersionsButton,
  reviews,
  selection,
  sessionModels,
  setActiveTool,
  setAnnotationsReady,
  setBodyVisible,
  setCompareDiff,
  setCompareFile,
  setExactError,
  setExactValues,
  setLastLoadMs,
  setLastSave,
  setLoadFinished,
  setModelStatus,
  setPaint,
  setPartMayChange,
  setPendingCommentSelection,
  setProject,
  setShownFile,
  setShownModel,
  setShownPath,
  setStrokeRecord,
  shownFile,
  shownModel,
  showNotice,
  sidecarText,
  viewport,
} from '../main.js';

// --- Model loading ----------------------------------------------------------
export const openButton = byId('open-model');
/** The start page in the middle of the view while no model is open. */
export const emptyView = byId('empty-view');
byId('empty-open').addEventListener('click', () => {
  openButton.click();
});
const progressBox = byId('load-progress');
const progressBar = byId('load-progress-bar') as HTMLProgressElement;
const progressLabel = byId('load-progress-label');
openButton.title = `Open a folder: its project (${shortcutLabel('o', isMac)})`;
export const loader = new ModelLoader();
// User folders in the body list: undoable, saved in the sidecar.
export const bodyFolders = new BodyFolders();
const FOLDER_EDIT_LABELS: Record<FolderEditKind, string> = {
  'new-folder': 'New folder',
  move: 'Move in body list',
  'rename-folder': 'Rename folder',
  'delete-folder': 'Delete folder',
};
bodyFolders.onEdit = (edit) => {
  history.push({
    label: FOLDER_EDIT_LABELS[edit.kind],
    undo: () => {
      bodyFolders.restore(edit.before);
    },
    redo: () => {
      bodyFolders.restore(edit.after);
    },
  });
};
export const bodyList = new BodyList(
  byId('bodies'),
  (visible) => {
    viewport.setBodyVisibility(visible); // re-anchors the pins too
    setBodyVisible([...visible]);
    applyGhosts();
  },
  (bodies) => {
    viewport.frameBodies(bodies);
  },
  (bodies, mode) => {
    if (shownModel?.meshFormat) return; // no selection on a mesh (show / hide / zoom stay)
    const items = bodies.map((id) => ({ kind: 'body' as const, id }));
    if (mode === 'toggle') selection.toggleAll(items);
    else selection.addAll(items);
  },
  (e) => listClickMode(e),
  (bodies) => {
    viewport.setListHover(bodies.map((id) => ({ kind: 'body' as const, id })));
  },
  { arrangement: bodyFolders, menu: contextMenu },
);
export const count = new Intl.NumberFormat('en-US');
const perfProbe = new PerfProbe(
  viewport,
  perfModeFromUrl(location.search),
  (text) => {
    setModelStatus(text);
    renderStatus();
  },
  (radiusMm) => {
    autosave.setTarget(undefined); // bench paint is never saved next to the model
    markers.add();
    setActiveTool('brush');
    viewport.setBrushRadius(radiusMm);
  },
);

/** Bumped per `loadModel`: an older load stops after an await when a newer one started. */
let loadTicket = 0;
/**
 * The version the shown model replaced in this session: its annotations (the revision transfer moves them
 * when the geometry changed) and its mesh while it was the shown one (the compare overlay shows it). Undefined
 * when the shown model is no new version of anything.
 */
export let previousVersion:
  | {
      readonly path: string;
      readonly name: string;
      readonly doc?: Annotations;
      readonly model?: StepModel;
      readonly carried: boolean;
    }
  | undefined;
/** Sets `previousVersion` from another module (an import can't be assigned). */
export function setPreviousVersion(value: typeof previousVersion): void {
  previousVersion = value;
}
/** What the AI is told about a link that was moved or refused (a circle). */
export let linkWarning: string | undefined;
/** Sets `linkWarning` from another module (an import can't be assigned). */
export function setLinkWarning(value: typeof linkWarning): void {
  linkWarning = value;
}
/** What `load_model` tells the AI about the previous version. */
export let revisionInfo: RevisionInfo | undefined;
/** Sets `revisionInfo` from another module (an import can't be assigned). */
export function setRevisionInfo(value: typeof revisionInfo): void {
  revisionInfo = value;
}
/**
 * The AI loaded a file that looks like a newer copy of a model of this session without
 * naming it in `revisionOf`.
 */
export let versionHint: { readonly modelId: string; readonly name: string } | undefined;
/** Sets `versionHint` from another module (an import can't be assigned). */
export function setVersionHint(value: typeof versionHint): void {
  versionHint = value;
}
/**
 * Show a model file. `revisionOf`: an earlier model this file is a new version of (the AI
 * names it); the same file with new contents is found by itself. `askVersion` (the user loaded
 * it, so questions may be asked): a file without notes that looks like a newer version of
 * another asks to bring that one's notes over; a file linked to another earlier version
 * asks which one is right.
 */
export async function loadModel(
  file: ModelFile,
  revisionOf?: { readonly path: string; readonly name: string },
  askVersion = false,
): Promise<void> {
  closeVersionQuestion(); // a question about an earlier load is moot now
  closeDifferentPartQuestion();
  const t0 = performance.now();
  const sizeMB = (file.data.byteLength / 1e6).toFixed(1);
  setModelStatus(`Loading ${file.name} (${sizeMB} MB)…`);
  renderStatus();
  emptyView.hidden = true;
  progressBox.hidden = false;
  progressBar.value = 0;
  progressLabel.textContent = '';
  try {
    const loaded = await loader.load(file, (p) => {
      progressBar.value = p.fraction;
      progressLabel.textContent = `${p.label}…`;
    });
    if (!loaded) return; // a newer load replaced this one
    // Counted only from here: a newer load still importing doesn't stop this one mid-way.
    const ticket = ++loadTicket;
    const { model, ms } = loaded;
    const tBuild = performance.now();
    const before = shownFile && shownModel ? { ...shownFile, model: shownModel } : undefined;
    autosave.flushSync(); // the old model's last changes, before its state goes
    keepLeavingReview(); // the AI can still read it after the switch
    setAnnotationsReady(false);
    setLoadFinished(false);
    autosave.setTarget(undefined); // resetting below is not a change
    hideNotice();
    setLastSave(undefined);
    renderSaveStatus('hidden');
    setShownModel(model);
    setShownPath(file.path);
    const shown = {
      path: file.path,
      name: file.name,
      contentHash: file.contentHash,
      modelId: modelIdOf(file.contentHash),
    };
    setShownFile(shown);
    renderTitle();
    setExactValues(new ExactValues());
    setExactError(undefined);
    setLastLoadMs(ms);
    selection.clear(); // ids belong to the old model
    setStrokeRecord(undefined);
    const layer = new PaintLayer(model.triangleFace.length, model);
    setPaint(layer);
    viewport.setPaint(layer);
    // Its project becomes the current one (lock, moving old notes in) before its notes are read,
    // and before the new model's first marker gets an id (above the project's ones).
    try {
      const state = await window.thirdWheel?.projectShown(file.path);
      if (ticket !== loadTicket) return; // a newer model took over meanwhile
      if (state) setProject(state);
    } catch (err) {
      console.error('Could not open the project', err);
      showNotice(`Could not open the project of ${file.name}: ${ipcErrorText(err)}`);
    }
    markers.reset(); // markers belong to the old model's annotations
    comments.reset();
    commentsPanel.reset();
    sessionModels.delete(shown.modelId); // re-added last: latest first in `otherSessionModels`
    sessionModels.set(shown.modelId, {
      model: { modelId: shown.modelId, name: file.name, path: file.path },
      bodyNames: model.bodyNames,
    });
    // After the reset: the cancel redraws "Send review", which must not count the old comments.
    // Opening another model of the request keeps it.
    if (reviews.open() && !reviews.covers(shown.modelId))
      reviews.cancel(`Another model was opened (${file.name})`);
    bodyFolders.reset(stepTreeOf(model)); // the sidecar may add user folders
    setPendingCommentSelection([]);
    previousVersion = undefined;
    revisionInfo = undefined;
    versionHint = undefined;
    endCompare();
    setCompareDiff(undefined); // lets the older meshes go
    setCompareFile(undefined);
    setBodyVisible([]);
    const notes = await loadAnnotations(file, model, layer, { before, revisionOf, askVersion });
    const carried = notes.save;
    if (ticket !== loadTicket) return; // a newer model took over meanwhile
    setAnnotationsReady(true);
    postModelEvent(file, before);
    renderSendToAi(); // open-comment count of the loaded annotations
    history.clear(); // steps belong to the old model
    const { path, name, contentHash } = file; // not `file`: keep its bytes collectable
    autosave.setTarget({
      modelPath: path,
      build: () => sidecarText(name, contentHash, model),
    });
    // Carried over from the previous version: save now, with this file's hash. A version that
    // looks like another part is saved only once the user says it is one (asked below).
    if (carried && !notes.differentPart) {
      setPartMayChange(true);
      autosave.changed();
    }
    viewport.showModel(model);
    applyMeshMode(model);
    renderInfo(); // mesh files show their own hint
    applyGhosts(); // after showModel: it clears the old model's overlays
    renderVersionsButton();
    queuePins();
    bodyList.setModel(model);
    const buildMs = performance.now() - tBuild;
    setModelStatus(
      [
        file.name,
        ...(model.meshFormat ? [`${model.meshFormat.toUpperCase()} mesh`] : []),
        `${count.format(model.bodyCount)} bodies`,
        ...(model.meshFormat ? [] : [`${count.format(model.faceBody.length)} faces`]),
        `${count.format(model.triangleFace.length)} triangles`,
        `${(ms / 1000).toFixed(1)} s`,
      ].join(' · '),
    );
    console.info('Model loaded', file.path, Math.round(ms), 'ms', model.stats);
    progressBox.hidden = true;
    renderStatus();
    await viewport.afterNextFrame();
    if (ticket === loadTicket) setLoadFinished(true);
    await perfProbe.modelShown({
      file: file.name,
      bodies: model.bodyCount,
      triangles: model.triangleFace.length,
      importMs: Math.round(ms),
      buildMs: Math.round(buildMs),
      firstPictureMs: Math.round(performance.now() - t0),
      stages: model.stats.timings,
    });
    // Asked with the model on screen; the answer saves it or takes it out of the versions.
    if (notes.differentPart && ticket === loadTicket) await askDifferentPart(notes.differentPart);
    return;
  } catch (err) {
    setModelStatus(
      `Could not open ${file.name}: ${err instanceof Error ? err.message : String(err)}`,
    );
    console.error(modelStatus);
    perfProbe.loadFailed(file.name, modelStatus, performance.now() - t0);
  }
  emptyView.hidden = shownModel !== undefined; // a failed first open shows the start view again
  if (!shownModel) void refreshStartPage();
  progressBox.hidden = true;
  renderStatus();
}
