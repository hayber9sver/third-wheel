/**
 * Loading a new revision of a model. Pure: decides whether the previous version's
 * annotations fit the new file as they are, and words what the app tells the user.
 *
 * A revision is the same file with new contents (Reload from disk, or opened / loaded again), or
 * another file the AI names with `load_model({ revisionOf })`. Same mesh hash → the annotations are
 * carried over exactly; otherwise they are kept for the transfer and the model starts empty.
 */
import type {
  Annotations,
  MeshCoverage,
  RevisionAnnotations,
  TransferSummary,
  TransferredMarker,
} from '@third-wheel/core';
import { markerNameKey } from '@third-wheel/core';
import { MARKER_COLORS, nextMarkerColor } from './markers.js';

/** Where the previous version's annotations come from. */
export interface PreviousAnnotations {
  readonly doc: Annotations;
  /** Fields this app doesn't know (lost on the next save). */
  readonly droppedFields: readonly string[];
  /** Model file the sidecar belongs to. */
  readonly path: string;
  readonly name: string;
  /** The sidecar next to the newly loaded file (it gets replaced), not another file's. */
  readonly own: boolean;
}

/**
 * True when the annotations fit the new model as they are: the mesh hash saved with them (or the
 * previous model's, still in memory) equals the new one, with the same mesh settings.
 */
export function sameGeometry(
  doc: Annotations,
  meshHash: string,
  tessellation: { readonly linearDeflection: number; readonly angularDeflection: number },
  previousMeshHash?: string,
): boolean {
  const old = doc.model.meshHash ?? previousMeshHash;
  const tess = doc.tessellation;
  return (
    old === meshHash &&
    tess?.linearDeflection === tessellation.linearDeflection &&
    tess.angularDeflection === tessellation.angularDeflection
  );
}

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? '' : 's'}`;

/** "2 markers and 3 comments" (or "no annotations"). */
export function annotationCounts(doc: Annotations): string {
  const m = doc.markers.length;
  const c = doc.comments.length;
  if (m === 0 && c === 0) return 'no annotations';
  if (c === 0) return plural(m, 'marker');
  if (m === 0) return plural(c, 'comment');
  return `${plural(m, 'marker')} and ${plural(c, 'comment')}`;
}

/**
 * Notice after carrying annotations over to a new version with the same geometry. `ownBackup` =
 * where the new file's own older sidecar went (when another file's annotations were used).
 */
export function carriedText(
  prev: PreviousAnnotations,
  newName: string,
  ownBackup: string | null = null,
): string {
  const what = annotationCounts(prev.doc);
  if (prev.own)
    return `${newName} changed on disk, but its geometry is the same: ${what} carried over.`;
  const old = ownBackup ? ` Its own older annotations were moved to ${ownBackup}.` : '';
  return `${newName} has the same geometry as ${prev.name}: ${what} carried over.${old}`;
}

/** The question when a STEP looks like the same part as a mesh with notes (sizes match). */
export function meshQuestion(
  newName: string,
  prev: PreviousAnnotations,
): { title: string; text: string } {
  return {
    title: `Is ${newName} the same part as ${prev.name}?`,
    text: `${prev.name} has ${annotationCounts(prev.doc)}. Bring them onto ${newName}? The two files are lined up and the paint goes onto the nearest STEP faces; ${prev.name} and its notes stay as they are.`,
  };
}

/** The question "Is part_v2.step a new version of part.step?" — its explanation. */
export function versionQuestionText(newName: string, prev: PreviousAnnotations): string {
  return `${prev.name} has ${annotationCounts(prev.doc)}. Bring them over to ${newName}? They are moved onto the new geometry; ${prev.name} and its notes stay as they are.`;
}

/**
 * Pop-up text when the geometry changed and moving the annotations failed: they are kept,
 * not shown. `backup` = file name the new file's own sidecar was moved to (null: none).
 */
export function waitingText(
  prev: PreviousAnnotations,
  newName: string,
  detail: string,
  backup: string | null,
): string {
  const what = annotationCounts(prev.doc);
  const later = 'They could not be moved onto the new geometry.';
  if (!prev.own) {
    const old = backup ? ` Its own older annotations were moved to ${backup}.` : '';
    return `${newName} is a new version of ${prev.name}. Its ${what} stay saved with ${prev.name}; ${newName} starts without annotations.${old} ${later}`;
  }
  const where = backup
    ? `were moved to ${backup}; the model starts without annotations.`
    : `were left as they are; changes you make now will replace them.`;
  return `${newName} is a new version (${detail}). Its ${what} ${where} ${later}`;
}

/** What `load_model` tells the AI about the previous version (bridge `LoadResult.revision`). */
export function revisionResult(
  prev: { readonly name: string; readonly path: string },
  annotations: RevisionAnnotations,
  doc?: Annotations,
  transfer?: TransferSummary,
): {
  of: string;
  path: string;
  annotations: RevisionAnnotations;
  markers: number;
  comments: number;
  transfer?: TransferSummary;
} {
  return {
    of: prev.name,
    path: prev.path,
    annotations,
    markers: doc?.markers.length ?? 0,
    comments: doc?.comments.length ?? 0,
    ...(transfer ? { transfer } : {}),
  };
}

/** For the AI's `load_model` result: which of its own markers were matched by name / recoloured. */
export function matchFacts(match: MatchedMarkers | undefined): {
  matched?: readonly string[];
  recoloured?: MatchedMarkers['recoloured'];
} {
  return {
    ...(match?.matched.length ? { matched: match.matched } : {}),
    ...(match?.recoloured.length ? { recoloured: match.recoloured } : {}),
  };
}

/** Counts per status and the markers not found where they were. */
export function transferSummary(
  doc: Annotations,
  status: Readonly<Record<string, 'found' | 'changed' | 'lost' | 'check'>>,
): TransferSummary {
  const flagged: TransferredMarker[] = [];
  const n = { found: 0, changed: 0, lost: 0, check: 0 };
  for (const m of doc.markers) {
    const s = status[m.id] ?? 'lost';
    n[s]++;
    if (s !== 'found') flagged.push({ id: m.id, name: m.name, status: s });
  }
  return { ...n, flagged };
}

/**
 * Notice after moving annotations onto changed geometry. `backup` = where the new file's
 * own older sidecar went (null: none).
 */
export function movedText(
  prev: PreviousAnnotations,
  newName: string,
  sum: TransferSummary,
  backup: string | null,
): string {
  const total = sum.found + sum.changed + sum.lost + sum.check;
  const head = prev.own
    ? `${newName} changed on disk: ${plural(total, 'marker')} moved onto the new geometry`
    : `${newName} is a new version of ${prev.name}: ${plural(total, 'marker')} moved over`;
  const parts = [
    sum.changed ? `${String(sum.changed)} changed` : '',
    sum.lost ? `${String(sum.lost)} lost` : '',
    sum.check ? `${String(sum.check)} to check (mirrored)` : '',
  ].filter(Boolean);
  const how =
    parts.length === 0
      ? total === 0
        ? '.'
        : ', all found.'
      : ` — ${String(sum.found)} found, ${parts.join(', ')}. Look for ⚠ in Markers.`;
  const kept = !backup
    ? ''
    : prev.own
      ? ` The old file was kept as ${backup}.`
      : ` Its own older annotations were moved to ${backup}.`;
  // Saved over in place: one file name = one version, so the earlier geometry is gone.
  const gone = prev.own ? " Its earlier geometry isn't kept." : '';
  return `${head}${how}${gone}${kept}`;
}

/** "97 %" (rounded down, so 99.6 % never reads as 100 %). */
const percent = (share: number): string => `${String(Math.floor(share * 100))} %`;

/**
 * Notice after moving a mesh's notes (STL / 3MF) onto a STEP: how many markers, how much of
 * the paint matched within the tolerance, and a warning when the files only partly match.
 */
export function meshMovedText(
  prev: PreviousAnnotations,
  newName: string,
  sum: TransferSummary,
  cov: MeshCoverage,
  backup: string | null,
): string {
  const total = sum.found + sum.changed + sum.lost + sum.check;
  const head = `Notes from ${prev.name} moved onto ${newName}: ${plural(total, 'marker')}`;
  const share = cov.points > 0 ? cov.matched / cov.points : 1;
  const tol = `${String(Math.round(cov.toleranceMm * 100) / 100)} mm`;
  const parts = [
    sum.changed ? `${String(sum.changed)} changed` : '',
    sum.lost ? `${String(sum.lost)} lost` : '',
    sum.check ? `${String(sum.check)} to check (mirrored)` : '',
  ].filter(Boolean);
  const paint =
    cov.points === 0 ? '' : `, ${percent(share)} of the paint matched a STEP face within ${tol}`;
  const how = parts.length === 0 ? '.' : ` (${parts.join(', ')}). Look for ⚠ in Markers.`;
  const fit = cov.mirrored
    ? ' The mesh only fits the STEP as a mirror image: its paint is kept as ghosts to check.'
    : cov.surface >= 0.9
      ? ''
      : cov.meshRead
        ? ` Only ${percent(cov.surface)} of the mesh lies on the STEP surface: the files may be different parts or versions.`
        : ` The mesh file couldn't be read, so the files were lined up from the paint alone: check where it landed.`;
  const kept = backup ? ` Its own older annotations were moved to ${backup}.` : '';
  return `${head}${paint}${how}${fit}${kept}`;
}

/**
 * For "does the new version look like another part?": the markers placed on the earlier version
 * (paint or entities; one already lost there is no sign) and how many of those were lost now.
 */
export function placedAndLost(
  doc: Annotations,
  status: Readonly<Record<string, 'found' | 'changed' | 'lost' | 'check'>>,
): { held: number; lost: number } {
  let held = 0;
  let lost = 0;
  for (const m of doc.markers) {
    const placed =
      m.entities.length > 0 || m.paint.faces.length > 0 || (m.paint.samples?.length ?? 0) > 0;
    if (!placed) continue;
    held++;
    if ((status[m.id] ?? 'lost') === 'lost') lost++;
  }
  return { held, lost };
}

const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The user added a "new version" that looks like another part: asked once it is shown, before the
 * moved markers are saved. New version (default, Esc) keeps it; Separate part takes it out again.
 */
export function differentPartQuestion(
  newName: string,
  prevName: string,
  reason: string,
): {
  title: string;
  text: string;
  version: string;
  separate: string;
  tips: { first: string; second: string };
} {
  return {
    title: 'The files look very different',
    text: `Is ${newName} really a new version of ${prevName}? ${capital(reason)}.`,
    version: 'New version',
    separate: 'Separate part',
    tips: {
      first: `Keep ${newName} as the newer version of ${prevName}, with the markers that moved over.`,
      second: `Take ${newName} out of the versions of ${prevName} and open it on its own, without these markers. ${prevName} keeps its notes; the file stays on disk.`,
    },
  };
}

/** Added to the notice when the AI loaded such a version (it is never asked; it is told too). */
export function differentPartNote(newName: string, prevName: string, reason: string): string {
  return ` The files look very different (${reason}): if ${newName} is not a version of ${prevName}, open ${prevName} and remove ${newName} under Versions ▾.`;
}

/**
 * Notes worth keeping: a comment, or a marker that holds something (paint, entities, or
 * parts a transfer couldn't place). An empty notes file, or only an empty "Marker 1", counts as none.
 */
export function hasNotes(doc: Annotations): boolean {
  return doc.comments.length > 0 || doc.markers.some(holdsSomething);
}

/** A marker with paint, picked entities or an unplaced part (an empty one is only listed). */
export function holdsSomething(m: Annotations['markers'][number]): boolean {
  return (
    m.entities.length > 0 ||
    m.paint.faces.length > 0 ||
    (m.paint.samples?.length ?? 0) > 0 ||
    m.transfer?.ghost !== undefined
  );
}

/**
 * A new version that already has markers of its own (projects): the question. The buttons name
 * whose markers to use, so none has a hidden subject ("keep" what? "replace" by what?): the new
 * file's own (default, Esc: nothing moves), the earlier version's (moved over, the new file's go to
 * a backup), or both (its own stay, the earlier version's other markers move over). The details
 * are in each button's hover text.
 */
export function ownMarkersQuestion(
  newName: string,
  prevName: string,
): {
  title: string;
  text: string;
  keep: string;
  replace: string;
  merge: string;
  tips: { keep: string; replace: string; merge: string };
} {
  return {
    title: `Which markers should ${newName} use?`,
    text: 'Comments are shared by all versions.',
    keep: `${shortName(newName)} (new)`,
    replace: `${shortName(prevName)} (earlier)`,
    merge: 'Both',
    tips: {
      keep: `Use the markers made on ${newName}. One with the name of an earlier marker is that marker (its comments apply). Nothing moves from ${prevName}.`,
      replace: `Move the markers of ${prevName} onto the new shape. The markers of ${newName} are kept in a backup copy.`,
      merge: `Keep the markers of ${newName} and add those of ${prevName} it has no name for. Same name = same marker.`,
    },
  };
}

/** A file name for a button: a long one keeps its start and its end (the version suffix). */
export function shortName(name: string, max = 22): string {
  if (name.length <= max) return name;
  const tail = Math.ceil((max - 1) / 2);
  return `${name.slice(0, max - 1 - tail)}…${name.slice(-tail)}`;
}

/**
 * Merge: the earlier version's notes without the markers the new file holds itself — by id, or by
 * name (same name = same marker: the new file's own paint wins). A marker it only lists, empty,
 * because a shared comment names it, still comes over.
 */
export function withoutMarkersOf(prev: Annotations, own: Annotations): Annotations {
  const held = own.markers.filter(holdsSomething);
  const ids = new Set(held.map((m) => m.id));
  const names = new Set(held.map((m) => nameKey(m.name)));
  return {
    ...prev,
    markers: prev.markers.filter((m) => !ids.has(m.id) && !names.has(nameKey(m.name))),
  };
}

/**
 * Merge: the new file's own notes plus the markers (and comments) moved from the earlier one.
 * Moved markers keep their names and colours: they are the part's markers, shared with the
 * earlier versions (a clash was settled on the new file's side by `matchMarkersByName`).
 */
export function mergeMarkers(own: Annotations, moved: Annotations): Annotations {
  const came = new Set(moved.markers.map((m) => m.id));
  const kept = own.markers.filter((m) => holdsSomething(m) || !came.has(m.id));
  const mine = new Set(kept.map((m) => m.id));
  const said = new Set(own.comments.map((c) => c.id));
  return {
    ...own,
    markers: [...kept, ...moved.markers.filter((m) => !mine.has(m.id))],
    comments: [...own.comments, ...moved.comments.filter((c) => !said.has(c.id))],
  };
}

/** A new version's own markers after `matchMarkersByName`. */
export interface MatchedMarkers {
  readonly doc: Annotations;
  /** Names of its markers that are the part's markers of the same name. */
  readonly matched: readonly string[];
  /** Its markers that got a free colour: `taken` = the colour another marker here has. */
  readonly recoloured: readonly { readonly name: string; readonly taken: string }[];
}

/**
 * A new version that has markers of its own (any answer but "earlier", and the AI's): the user
 * and the AI talk about markers by name, so a marker of the new file whose name (case ignored)
 * matches one of the part's — listed here because a shared comment names it, or one of
 * `earlier` (the earlier version's) — **is** that marker. It takes that marker's id, name, colour
 * and visibility (the project's; its comments follow), and the empty listed row goes. Nothing of
 * an earlier version changes. A marker that matches none and whose colour another one here (or
 * on the earlier version) uses gets the next free colour: the app never makes two markers look
 * alike. Same `doc` when nothing changed.
 */
export function matchMarkersByName(
  own: Annotations,
  earlier: readonly Annotations['markers'][number][],
): MatchedMarkers {
  type M = Annotations['markers'][number];
  const held = own.markers.filter(holdsSomething);
  const heldIds = new Set(held.map((m) => m.id));
  // Held on the earlier version too: already the same marker. (Only listed there — a shared
  // comment names one of its own — doesn't count.)
  const earlierIds = new Set(earlier.filter(holdsSomething).map((m) => m.id));
  const ownIds = new Set(own.markers.map((m) => m.id));
  // The part's markers it may be: listed ones first (comments name them), then the earlier version's.
  // Two of them with one name (made before names were unique in a project): which one is
  // meant can't be told, so that name matches none (null). Its own markers are none of them.
  const byName = new Map<string, M | null>();
  for (const m of [...own.markers.filter((k) => !holdsSomething(k)), ...earlier]) {
    if (heldIds.has(m.id)) continue;
    const key = nameKey(m.name);
    const had = byName.get(key);
    if (had === undefined) byName.set(key, m);
    else if (had !== null && had.id !== m.id) byName.set(key, null);
  }
  const twinOf = new Map<string, M>(); // its marker's id → the part's marker it is
  for (const m of held) {
    if (earlierIds.has(m.id)) continue; // already the same marker
    const twin = byName.get(nameKey(m.name));
    if (!twin || heldIds.has(twin.id) || [...twinOf.values()].includes(twin)) continue;
    twinOf.set(m.id, twin);
  }
  const taken = new Set([...twinOf.values()].map((t) => t.id));
  let markers: M[] = own.markers
    .filter((m) => heldIds.has(m.id) || !taken.has(m.id)) // a matched empty row goes
    .map((m) => {
      const twin = twinOf.get(m.id);
      return twin
        ? { ...m, id: twin.id, name: twin.name, color: twin.color, visible: twin.visible }
        : m;
    });
  // Its markers that match none: a colour already used here gets a free one.
  const loose = new Set(
    held.filter((m) => !twinOf.has(m.id) && !earlierIds.has(m.id)).map((m) => m.id),
  );
  const recoloured: { name: string; taken: string }[] = [];
  const seen: M[] = [
    ...markers.filter((m) => !loose.has(m.id)),
    ...earlier.filter((m) => !ownIds.has(m.id)),
  ];
  markers = markers.map((m) => {
    if (!loose.has(m.id)) return m;
    const clash = seen.some((k) => sameColor(k.color, m.color));
    const next = clash ? { ...m, color: nextMarkerColor(seen) } : m;
    if (clash) recoloured.push({ name: m.name, taken: m.color });
    seen.push(next);
    return next;
  });
  const matched = [...twinOf.values()].map((t) => t.name);
  if (twinOf.size === 0 && recoloured.length === 0) return { doc: own, matched, recoloured };
  const comments = own.comments.map((c) =>
    c.markerIds.some((id) => twinOf.has(id))
      ? { ...c, markerIds: [...new Set(c.markerIds.map((id) => twinOf.get(id)?.id ?? id))] }
      : c,
  );
  return { doc: { ...own, markers, comments }, matched, recoloured };
}

const nameKey = markerNameKey;

function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Merge: the end of the notice. */
export function keptAlsoText(newName: string, own: Annotations): string {
  return `${newName} kept its own ${plural(own.markers.filter(holdsSomething).length, 'marker')}.`;
}

/**
 * A new version that already has markers of its own uses them (the question's default). Says which
 * of them are the part's markers of the same name and which got a free colour.
 */
export function keptOwnText(newName: string, prevName: string, match?: MatchedMarkers): string {
  return `${newName} uses its own markers; none came from ${prevName}.${matchText(match)}`;
}

/** The end of a notice: markers matched by name, colours changed. Empty when none. */
export function matchText(match: MatchedMarkers | undefined): string {
  if (!match) return '';
  let text = '';
  if (match.matched.length > 0) {
    const names = listText(match.matched);
    text +=
      match.matched.length === 1
        ? ` ${names} has the name of an earlier marker, so it is that marker: its comments apply here.`
        : ` ${names} have the names of earlier markers, so they are those markers: their comments apply here.`;
  }
  for (const r of match.recoloured) {
    const was = MARKER_COLORS.find((c) => sameColor(c.hex, r.taken))?.name.toLowerCase();
    text += ` ${r.name} got a new colour: ${was ?? 'its colour'} was taken.`;
  }
  return text;
}

/** "A", "A and B", "A, B and C". */
function listText(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}
