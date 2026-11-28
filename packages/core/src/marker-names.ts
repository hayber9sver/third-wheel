/**
 * Marker names are unique in a project (case and extra spaces ignored): the user and the AI talk
 * about markers by name, so two markers called "Marker 2" would leave them guessing which one is
 * meant. The hidden id stays the link (comments name markers by id), so a rename is always safe.
 *
 * Pure: no I/O.
 */
import type { Project } from './project-schema.js';
import { MAX_NAME_LENGTH } from './schema.js';

/** The form two names are compared in: spaces collapsed, ends trimmed, lower case. */
export function markerNameKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** `name` is used by one of `names` (case and extra spaces ignored). */
export function isMarkerNameTaken(name: string, names: Iterable<string>): boolean {
  const key = markerNameKey(name);
  for (const n of names) if (markerNameKey(n) === key) return true;
  return false;
}

/**
 * "Name (2)", "Name (3)", … : the first that no name in `taken` (keys from {@link markerNameKey})
 * uses. The base is shortened when the result would be longer than a name may be.
 */
export function copyMarkerName(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/\s+/g, ' ').trim();
  for (let n = 2; ; n++) {
    const tail = ` (${String(n)})`;
    const next = `${base.slice(0, MAX_NAME_LENGTH - tail.length).trimEnd()}${tail}`;
    if (!taken.has(markerNameKey(next))) return next;
  }
}

/**
 * The project's markers the window doesn't show (other parts, other versions): a new or
 * renamed marker must not take one of them.
 */
export function otherMarkers(
  project: Project,
  shown: readonly { readonly id: string }[],
): { id: string; name: string }[] {
  const ids = new Set(shown.map((m) => m.id));
  return project.markers.filter((m) => !ids.has(m.id)).map((m) => ({ id: m.id, name: m.name }));
}

/** A marker renamed because its name was taken. */
export interface RenamedMarker {
  readonly from: string;
  readonly to: string;
}

/**
 * Projects made before names had to be unique may have two markers with one name: the first (in
 * the project's list) keeps it, each later one becomes "Name (2)", "Name (3)", …. Same project
 * when all names are unique.
 */
export function uniqueMarkerNames(project: Project): {
  readonly project: Project;
  readonly renamed: readonly RenamedMarker[];
} {
  const taken = new Set(project.markers.map((m) => markerNameKey(m.name)));
  const seen = new Set<string>();
  const renamed: RenamedMarker[] = [];
  const markers = project.markers.map((m) => {
    const key = markerNameKey(m.name);
    if (!seen.has(key)) {
      seen.add(key);
      return m;
    }
    const name = copyMarkerName(m.name, taken);
    taken.add(markerNameKey(name));
    seen.add(markerNameKey(name));
    renamed.push({ from: m.name, to: name });
    return { ...m, name };
  });
  return renamed.length === 0
    ? { project, renamed }
    : { project: { ...project, markers }, renamed };
}

/** The notice after {@link uniqueMarkerNames} renamed markers (at most three named). */
export function renamedMarkersText(renamed: readonly RenamedMarker[]): string {
  const n = renamed.length;
  const list = renamed
    .slice(0, 3)
    .map((r) => `"${r.from}" → "${r.to}"`)
    .join(', ');
  return `${String(n)} marker${n === 1 ? ' was' : 's were'} renamed so you and the AI can tell them apart (marker names are unique in a project now): ${list}${n > 3 ? ', …' : ''}.`;
}
