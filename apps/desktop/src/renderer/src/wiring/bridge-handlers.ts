/**
 * App bridge: requests from the MCP server (the AI's tools) that the window answers.
 */
import {
  type StatusResult,
  parseParams,
  annotationsParamsSchema,
  requestReviewParamsSchema,
  type RequestReviewResult,
  waitReviewParamsSchema,
  setCommentStatusParamsSchema,
  type SetCommentStatusResult,
  replyCommentParamsSchema,
  type ReplyCommentResult,
  type CommentStatus,
  type ReviewModelCount,
  type LoadResult,
  modelIdOf,
  nextVersionName,
  type RenderResult,
  renderParamsSchema,
  type RenderView,
  searchPartsParamsSchema,
  customBodyNames,
  lostBodyNames,
  lostBodyNamesWarning,
} from '@third-wheel/core';
import { getCatalogue } from '../library/catalogue-load.js';
import { searchParts } from '../library/search.js';
import type { LoadRequest, ModelFile } from '../../../shared/ipc.js';
import {
  reviewPayloadText,
  filterReviewPayload,
  type StepModel,
  type ReviewPayload,
  reviewPayload,
  meshFormatOf,
} from '@third-wheel/geometry';
import type { ReviewModel } from '../review-request.js';
import { toAnnotations } from '../sidecar.js';
import {
  savedOverText,
  otherProjectParentText,
  changedOnDiskHint,
} from '../../../shared/load-rules.js';
import type { RegionImage, ContactSheet } from '../viewport.js';
import {
  annotationsReady,
  comments,
  ipcErrorText,
  linkWarning,
  listAsPart,
  loadModel,
  markers,
  modelStatus,
  noteAgentReply,
  openCommentCount,
  paint,
  renderContactSheet,
  renderRegion,
  reviews,
  revisionInfo,
  setLoadingForAgent,
  shownFile,
  shownModel,
  showNotice,
  shownProject,
  versionHint,
} from '../main.js';

// --- App bridge: requests from the MCP server that the window answers ----------
window.thirdWheel?.onBridgeRequest((method, params) => {
  switch (method) {
    case 'status': {
      // Also answers get_open_model (bridge method open_model): what is open, and how much waits.
      const model = shownModel;
      if (!shownFile || !model) return { model: shownFile } satisfies StatusResult;
      const byStatus: Record<CommentStatus, number> = { open: 0, resolved: 0, wontfix: 0 };
      for (const c of comments.list()) byStatus[c.status]++;
      return {
        model: shownFile,
        summary: {
          bodies: model.bodyCount,
          markers: markers.list().length,
          comments: byStatus,
          ...(model.meshFormat ? { mesh: model.meshFormat } : {}),
        },
      } satisfies StatusResult;
    }
    case 'search_parts':
      return getCatalogue().then((catalogue) =>
        searchParts(catalogue, parseParams(searchPartsParamsSchema, params, method)),
      );
    case 'load':
      return bridgeLoad(params as LoadRequest);
    case 'annotations': {
      const p = parseParams(annotationsParamsSchema, params, method);
      const statuses = p.statuses ?? ['open'];
      const kept = shownFile?.modelId === p.modelId ? undefined : sessionModels.get(p.modelId);
      // The file's path goes along: the AI edits the file or writes the next version beside it.
      const withPath = (payload: ReviewPayload): ReviewPayload => {
        const path = sessionModels.get(p.modelId)?.model.path ?? shownFile?.path;
        if (!path) return payload;
        const { model, ...rest } = payload;
        return { model, path, ...rest };
      };
      if (kept?.payload) return keptAnnotations(kept.model, withPath(kept.payload), statuses);
      return reviewPayloadText(withPath(shownReview(modelFor(p.modelId), statuses)));
    }
    case 'request_review': {
      const p = parseParams(requestReviewParamsSchema, params, method);
      modelFor(p.modelId);
      const others = (p.alsoModelIds ?? []).map((id) => {
        const known = sessionModels.get(id);
        if (!known)
          throw new Error(
            `Model "${id}" was not opened in this app session — call load_model on it first`,
          );
        return known.model;
      });
      const shown = sessionModels.get(p.modelId)?.model;
      if (!shown) throw new Error(NO_MODEL);
      return {
        reviewId: reviews.request([shown, ...others], p.message).id,
      } satisfies RequestReviewResult;
    }
    case 'wait_review': {
      const p = parseParams(waitReviewParamsSchema, params, method);
      return reviews.wait(p.reviewId, p.timeoutSec * 1000);
    }
    case 'render':
      return bridgeRender(params);
    case 'set_comment_status': {
      const p = parseParams(setCommentStatusParamsSchema, params, method);
      modelFor(p.modelId); // comment ids repeat across models (c1, c2, …)
      if (!shownFile) throw new Error(NO_MODEL);
      if (!comments.get(p.commentId))
        throw new Error(`No comment "${p.commentId}" on ${shownFile.name}`);
      // Part results first: an unknown part id is an error and nothing is changed.
      const partsUpdated = p.partResults
        ? comments.setPartResults(p.commentId, p.partResults)
        : undefined;
      const before = comments.get(p.commentId)?.replies?.length ?? 0;
      const changed = comments.setStatus(p.commentId, p.status, p.note, 'ai');
      const c = comments.get(p.commentId);
      const replies = c?.replies ?? [];
      const reply = replies.length > before ? replies[replies.length - 1] : undefined;
      if (reply) noteAgentReply(p.commentId, reply.text);
      return {
        commentId: p.commentId,
        status: c?.status ?? p.status,
        ...(reply ? { replyId: reply.id } : {}),
        changed: changed || (partsUpdated ?? 0) > 0,
        ...(partsUpdated === undefined ? {} : { partsUpdated }),
      } satisfies SetCommentStatusResult;
    }
    case 'reply_comment': {
      const p = parseParams(replyCommentParamsSchema, params, method);
      modelFor(p.modelId);
      if (!shownFile) throw new Error(NO_MODEL);
      const c = comments.get(p.commentId);
      if (!c) throw new Error(`No comment "${p.commentId}" on ${shownFile.name}`);
      const partsUpdated = p.partResults
        ? comments.setPartResults(p.commentId, p.partResults)
        : undefined;
      const reply = comments.reply(p.commentId, p.text, 'ai');
      if (!reply)
        throw new Error(`Could not reply to "${p.commentId}" (empty text or thread full)`);
      noteAgentReply(p.commentId, reply.text);
      return {
        commentId: p.commentId,
        replyId: reply.id,
        status: c.status,
        ...(partsUpdated === undefined ? {} : { partsUpdated }),
      } satisfies ReplyCommentResult;
    }
    default:
      throw new Error(`The window does not answer "${method}"`);
  }
});

const NO_MODEL = 'No model is open in Third Wheel — call load_model first';

/**
 * The review kept for a model opened earlier — unless it is now a version of the shown model's
 * part (another version of it, or parts that joined since): comments belong to the part, so the
 * kept copy may be out of date.
 */
async function keptAnnotations(
  model: ReviewModel,
  payload: ReviewPayload,
  statuses: readonly CommentStatus[],
): Promise<string> {
  const shown = shownFile;
  if (shown && (await isVersionOfShownPart(model.path))) {
    throw new Error(
      `${model.name} is a version of the same part as the shown model ${shown.name}, so its comments are the shown model's: call get_annotations with modelId "${shown.modelId}", or load_model ${model.name} to see its own markers.`,
    );
  }
  return reviewPayloadText(filterReviewPayload(payload, statuses));
}

/** `path` is one of the shown part's version files (the project says so). */
async function isVersionOfShownPart(path: string): Promise<boolean> {
  const api = window.thirdWheel;
  const shown = shownFile;
  if (!api || !shown) return false;
  try {
    const list = await api.projectVersions(shown.path, shown.contentHash);
    return list?.rows.some((r) => r.path === path) ?? false;
  } catch (err) {
    console.warn('Could not read the versions of the shown part', err);
    return false;
  }
}

/** The shown model, if `modelId` names it. */
function modelFor(modelId: string): StepModel {
  if (!shownModel || !shownFile) throw new Error(NO_MODEL);
  if (modelId !== shownFile.modelId) {
    const kept = sessionModels.get(modelId);
    const was = kept?.payload
      ? ` (${kept.model.name} was open earlier: get_annotations still reads it)`
      : '';
    throw new Error(
      `Model "${modelId}" is not shown${was}; the app shows ${shownFile.name} (modelId "${shownFile.modelId}"). Call load_model.`,
    );
  }
  return shownModel;
}

/**
 * Models opened in this window, by modelId: where to open them again and, once another
 * model is shown, their review payload with every status (the mesh is gone by then). Its markers
 * can't change while it isn't shown; its comments are its part's, so `get_annotations` doesn't
 * use it once the model is a version of the shown part.
 */
export const sessionModels = new Map<
  string,
  { model: ReviewModel; payload?: ReviewPayload; bodyNames?: readonly string[] }
>();

/** Review payload of the shown model, live. */
export function shownReview(model: StepModel, statuses?: readonly CommentStatus[]): ReviewPayload {
  if (!paint || !shownFile) throw new Error('No paint layer');
  const doc = toAnnotations({
    fileName: shownFile.name,
    contentHash: shownFile.contentHash,
    model,
    markers: markers.list(),
    comments: comments.list(),
    paint,
  });
  return reviewPayload(model, doc, statuses ? { statuses } : {});
}

/**
 * Before another model replaces the shown one: keep its payload for `get_annotations` — not while
 * its sidecar is still being read (a quick switch), which would keep too few comments.
 */
export function keepLeavingReview(): void {
  if (!shownModel || !shownFile) return;
  const entry = sessionModels.get(shownFile.modelId);
  if (!entry) return;
  if (!annotationsReady) {
    delete entry.payload;
    return;
  }
  try {
    entry.payload = shownReview(shownModel);
  } catch (err) {
    delete entry.payload;
    console.warn('Could not keep the review of', shownFile.name, err);
  }
}

/** Open comments per model of the open request: shown one live, the others as kept. */
export function requestCounts(): ReviewModelCount[] {
  return (reviews.open()?.models ?? []).map((m) => ({
    modelId: m.modelId,
    name: m.name,
    openComments:
      m.modelId === shownFile?.modelId
        ? openCommentCount()
        : (sessionModels.get(m.modelId)?.payload?.comments.filter((c) => c.status === 'open')
            .length ?? 0),
  }));
}

/**
 * Other model files opened in this window (not the shown file), one per name, latest first: a
 * comment links to a file by name, so a newer export under the same name replaces the older one.
 */
export function otherSessionModels(): ReviewModel[] {
  const byName = new Map<string, ReviewModel>();
  for (const { model } of [...sessionModels.values()].reverse())
    if (model.path !== shownFile?.path && !byName.has(model.name)) byName.set(model.name, model);
  return [...byName.values()];
}

/** Opens a model opened before in this window again (banner switcher, linked-model chips). */
export async function reopenModel(path: string): Promise<void> {
  const api = window.thirdWheel;
  if (!api) return;
  let file: ModelFile;
  try {
    file = await api.rereadModelFile(path);
  } catch (err) {
    showNotice(`Couldn't open ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  await loadModel(file);
}

/**
 * File ▸ Reload from disk (slicer wording): read the shown file again after the user saved
 * over it. Unchanged → say so and keep everything (undo too); changed → the same version takes
 * the new contents (its markers move over).
 */
export async function reloadFromDisk(): Promise<void> {
  const api = window.thirdWheel;
  const shown = shownFile;
  if (!api) return;
  if (!shown) {
    showNotice('No model is shown: Reload from disk reads the shown model file again.');
    return;
  }
  let file: ModelFile;
  try {
    file = await api.rereadModelFile(shown.path);
  } catch (err) {
    showNotice(`Couldn't reload ${shown.name}: ${ipcErrorText(err)}`);
    return;
  }
  if (shownFile !== shown) return; // another model was opened meanwhile
  if (file.contentHash === shown.contentHash) {
    showNotice(`${shown.name} hasn't changed on disk.`);
    return;
  }
  await loadModel(file);
}

/** `load` (main read the file and checked its place in the project): show it, tell the AI what it got. */
async function bridgeLoad(request: LoadRequest): Promise<LoadResult> {
  const { revisionOf: previousId, saveNextAs, ...file } = request;
  let revisionOf: { path: string; name: string } | undefined;
  if (previousId !== undefined) {
    const prevName =
      shownFile?.modelId === previousId
        ? shownFile.name
        : sessionModels.get(previousId)?.model.name;
    // Notes move from a STEP or a mesh onto a STEP; never onto a mesh.
    if (meshFormatOf(file.name))
      throw new Error(
        `revisionOf needs a STEP file to load: markers and comments are not moved onto STL / 3MF files${prevName ? ` (from ${prevName})` : ''}. Load without revisionOf.`,
      );
    const prev =
      shownFile?.modelId === previousId ? shownFile : sessionModels.get(previousId)?.model;
    if (!prev)
      throw new Error(
        `revisionOf: no model ${previousId} was loaded in this session (load the previous version first)`,
      );
    // A new version saved over its earlier version's file (main refuses it when listed).
    if (prev.path === file.path && previousId !== modelIdOf(file.contentHash))
      throw new Error(savedOverText(file.name, saveNextAs ?? nextVersionName(file.name)));
    const folder = shownProject?.folder;
    const [prevFolder] = (await window.thirdWheel?.projectFolders([prev.path])) ?? [];
    if (folder && prevFolder && prevFolder !== folder)
      throw new Error(otherProjectParentText(prev.name, prevFolder, folder));
    revisionOf = { path: prev.path, name: prev.name };
  }
  // Names of the previous version, before the new one replaces it (to see if a round trip lost them).
  const previousNames =
    previousId === undefined
      ? undefined
      : shownFile?.modelId === previousId
        ? shownModel?.bodyNames
        : sessionModels.get(previousId)?.bodyNames;
  setLoadingForAgent(true);
  try {
    await loadModel(file, revisionOf);
  } finally {
    setLoadingForAgent(false);
  }
  const model = shownModel;
  if (!model || shownFile?.path !== file.path || shownFile.contentHash !== file.contentHash)
    throw new Error(modelStatus || `Could not open ${file.name}`);
  // Project-first: without revisionOf it is a part of the project (listed now, as Add file does).
  if (!revisionOf) await listAsPart(file);
  const byStatus: Record<CommentStatus, number> = { open: 0, resolved: 0, wontfix: 0 };
  for (const c of comments.list()) byStatus[c.status]++;
  return {
    modelId: shownFile.modelId,
    name: shownFile.name,
    path: shownFile.path,
    bodies: model.bodyCount,
    faces: model.faceBody.length,
    ...(model.meshFormat ? { mesh: model.meshFormat } : {}),
    markers: markers.list().length,
    comments: byStatus,
    ...(revisionInfo ? { revision: revisionInfo } : {}),
    ...loadHints(file, saveNextAs),
    ...(shownProject ? { project: { name: shownProject.name, folder: shownProject.folder } } : {}),
    ...(saveNextAs ? { saveNextAs } : {}),
    ...namesLostNote(previousNames, model.bodyNames),
  };
}

/** `namesLost` for the load result: the user's body names the new file no longer has. */
function namesLostNote(
  previous: readonly string[] | undefined,
  next: readonly string[],
): { namesLost?: string } {
  if (!previous) return {};
  const lost = lostBodyNames(previous, next);
  return lost ? { namesLost: lostBodyNamesWarning(lost, customBodyNames(previous).length) } : {};
}

/**
 * `warning` = a version link moved or was refused; `hint` = the file looks like a newer copy
 * of a model of this session and `revisionOf` was not given, or it is a listed file saved over in
 * place (allowed without revisionOf: the same version, like Reload).
 */
function loadHints(
  file: ModelFile,
  saveNextAs: string | undefined,
): Pick<LoadResult, 'hint' | 'warning'> {
  if (linkWarning) return { warning: linkWarning }; // a link moved or refused
  if (revisionInfo && revisionInfo.path === file.path)
    return { hint: changedOnDiskHint(file.name, saveNextAs ?? nextVersionName(file.name)) };
  if (versionHint)
    return {
      hint: meshFormatOf(versionHint.name)
        ? `This has the same size as the mesh ${versionHint.name} (modelId "${versionHint.modelId}"), which has notes. If it is the same part, call load_model again with revisionOf: "${versionHint.modelId}" to bring its paint and comments onto this STEP.`
        : `This looks like a new version of ${versionHint.name} (modelId "${versionHint.modelId}"). If it is, call load_model again with revisionOf: "${versionHint.modelId}" to bring its markers and comments over.`,
    };
  return {};
}

/** `render`: one picture of some markers, or a contact sheet of marker groups. */
async function bridgeRender(params: unknown): Promise<RenderResult> {
  const p = parseParams(renderParamsSchema, params, 'render');
  modelFor(p.modelId);
  const known = new Set(markers.list().map((m) => m.id));
  const asked = p.markerIds ?? (p.groups ?? []).flat();
  const unknown = [...new Set(asked.filter((id) => !known.has(id)))];
  if (unknown.length > 0) throw new Error(`Unknown marker ids: ${unknown.join(', ')}`);
  if (p.markerIds) {
    const img = await renderRegion(p.markerIds, p.size);
    if (!img) throw new Error('Nothing to draw: these markers hold no paint or entities');
    return { png: base64(img.png), width: img.size, height: img.size, view: roundView(img) };
  }
  const sheet = await renderContactSheet(p.groups ?? []);
  if (!sheet || sheet.tiles.length === 0)
    throw new Error('Nothing to draw: these markers hold no paint or entities');
  return {
    png: base64(sheet.png),
    width: sheet.width,
    height: sheet.height,
    tiles: sheet.tiles.map((t) => ({
      ...roundView(t),
      number: t.number,
      group: t.region,
      markerIds: t.markerIds,
      x: t.x,
      y: t.y,
      size: t.size,
    })),
    skipped: sheet.skipped,
  };
}

/** Camera facts rounded for the AI: directions 1e-3, positions 0.01 mm, scale 4 digits. */
function roundView(v: RegionImage | ContactSheet['tiles'][number]): RenderView {
  const r = (x: number, d: number): number => Number(x.toFixed(d)) || 0;
  const v3 = (a: readonly number[], d: number): [number, number, number] => [
    r(a[0] ?? 0, d),
    r(a[1] ?? 0, d),
    r(a[2] ?? 0, d),
  ];
  return {
    viewDir: v3(v.viewDir, 3),
    up: v3(v.up, 3),
    center: v3(v.center, 2),
    mmPerPx: Number(v.mmPerPx.toPrecision(4)),
    ghosted: v.ghosted.map((g) => ({ body: g.body, name: g.name })),
  };
}

function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
