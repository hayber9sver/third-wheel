/**
 * Versioned file names: `part.step`, `part_v2.step`, `part-rev3.step`, `part (2).step`,
 * `part copy.step` are versions of one model. Used to guess the earlier version of a file the user
 * opens (always asked, never acted on silently), to hint the AI, and by the Versions list.
 */

/** A model file name split into the name all its versions share and its version number. */
export interface VersionName {
  /** Lower case, without extension, version endings and trailing separators. "" = none left. */
  readonly stem: string;
  /**
   * Comparable version number: 0 = no version ending (the first version). Nested endings count
   * inner first, so a copy of v2 (`part_v2 (1)`) comes after v2.
   */
  readonly version: number;
}

const EXTENSION = /\.(step|stp)$/i;
/** Version endings, tried at the end of the name again and again (`part_v2 (1)`). */
const ENDINGS: readonly RegExp[] = [
  /\s*\((\d{1,4})\)$/, // "part (2)": browsers, Windows Explorer
  /[\s_.-]+(?:v|ver|version|rev|revision|r)[\s_.-]?(\d{1,4})$/i, // part_v2, part-rev3, part r4
  /[\s_.-]+copy(?:[\s_.-]+(\d{1,4}))?$/i, // macOS "part copy 2", Windows "part - Copy"
];

/** Splits a file name (with or without folder-less extension) into stem and version number. */
export function versionName(fileName: string): VersionName {
  let rest = fileName.trim().replace(EXTENSION, '');
  const numbers: number[] = []; // outermost first
  for (let changed = true; changed;) {
    changed = false;
    for (const ending of ENDINGS) {
      const m = ending.exec(rest);
      if (!m || m.index === 0) continue; // "v2.step" alone: its own name, not a version
      numbers.push(m[1] === undefined ? 1 : Number(m[1]));
      rest = rest.slice(0, m.index);
      changed = true;
    }
  }
  // Inner ending first, outer ones as fractions: part_v2 < part_v2 (1) < part_v3.
  let version = 0;
  numbers.reverse().forEach((n, i) => (version += n / 10_000 ** i));
  return { stem: rest.replace(/[\s_.-]+$/, '').toLowerCase(), version };
}

/** True when both names are versions of one model (same stem; not the very same name). */
export function sameModelName(a: string, b: string): boolean {
  if (a.toLowerCase() === b.toLowerCase()) return false;
  const sa = versionName(a).stem;
  return sa !== '' && sa === versionName(b).stem;
}

/**
 * `earlier` looks like an earlier version of `later` by name: same stem and a lower version
 * number (`part.step` → `part_v2.step`; never `part_v3` → `part_v2`).
 */
export function isEarlierVersionName(earlier: string, later: string): boolean {
  return sameModelName(earlier, later) && versionName(earlier).version < versionName(later).version;
}

/** Generic names a STEP exporter gives unnamed bodies: they say nothing about the model. */
const GENERIC_BODY = /^(body|solid|part|shape|component|mesh|default)[\s_-]*\d*$/i;

/**
 * Both models have the same named bodies (as a set; at least one real name, not "Body 1"). A
 * renamed file keeps its body names, so this finds versions saved under another name.
 */
export function sameBodyNames(a: readonly string[], b: readonly string[]): boolean {
  const set = (names: readonly string[]): Set<string> =>
    new Set(names.map((n) => n.trim().toLowerCase()));
  const sa = set(a);
  const sb = set(b);
  if (sa.size !== sb.size || ![...sa].some((n) => n !== '' && !GENERIC_BODY.test(n))) return false;
  return [...sa].every((n) => sb.has(n));
}

/** The name to suggest for the next export (`part.step` → `part_v2.step`, `part-rev3` → `part-rev4`). */
export function nextVersionName(fileName: string): string {
  const ext = EXTENSION.exec(fileName)?.[0] ?? '.step';
  const base = fileName.replace(EXTENSION, '');
  const v = /^(.*[\s_.-](?:v|ver|version|rev|revision|r)[\s_.-]?)(\d{1,4})$/i.exec(base);
  if (v && v[1] !== undefined && v[2] !== undefined)
    return `${v[1]}${String(Number(v[2]) + 1).padStart(v[2].length, '0')}${ext}`;
  const p = /^(.*\()(\d{1,4})\)$/.exec(base);
  if (p && p[1] !== undefined && p[2] !== undefined)
    return `${p[1]}${String(Number(p[2]) + 1)})${ext}`;
  return `${base}_v2${ext}`;
}

/** A file that may be an earlier version of the one being opened. */
export interface VersionCandidate {
  readonly path: string;
  readonly name: string;
  /** Loaded in this app session (its body names known). */
  readonly session?: { readonly bodyNames: readonly string[]; readonly order: number };
  /** Modification time of its sidecar (ms), when it has one on disk. */
  readonly sidecarMtimeMs?: number;
}

/**
 * Files that may be earlier versions of `file`, most likely first (empty: none): by name (lower
 * version number), or — when no file shares its name — a model of this session with the same
 * body names. Best = the highest
 * version number, then the newest sidecar, then the latest opened in this session.
 */
export function earlierVersions(
  file: { readonly path: string; readonly name: string; readonly bodyNames: readonly string[] },
  candidates: readonly VersionCandidate[],
): VersionCandidate[] {
  const others = candidates.filter((c) => c.path !== file.path);
  // Body names are the fallback for a renamed file: not when versions of its own name exist (an
  // older version opened after a newer one stays silent).
  const named = others.some((c) => sameModelName(c.name, file.name));
  const fits = others.filter(
    (c) =>
      isEarlierVersionName(c.name, file.name) ||
      (!named && c.session !== undefined && sameBodyNames(c.session.bodyNames, file.bodyNames)),
  );
  const rank = (c: VersionCandidate): readonly number[] => [
    sameModelName(c.name, file.name) ? versionName(c.name).version : -1,
    c.sidecarMtimeMs ?? -1,
    c.session?.order ?? -1,
  ];
  return fits.sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return (rb[i] ?? 0) - (ra[i] ?? 0);
    return 0;
  });
}

type BodyBox = { readonly size: readonly number[]; readonly centre: readonly number[] };

/** The box around all bodies (from their fingerprints): its sides x, y, z; undefined = no usable box. */
function overallBox(bodies: readonly BodyBox[]): number[] | undefined {
  if (bodies.length === 0) return undefined;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const body of bodies)
    for (let i = 0; i < 3; i++) {
      const c = body.centre[i] ?? 0;
      const h = (body.size[i] ?? 0) / 2;
      lo[i] = Math.min(lo[i] ?? 0, c - h);
      hi[i] = Math.max(hi[i] ?? 0, c + h);
    }
  const box = [0, 1, 2].map((i) => (hi[i] ?? 0) - (lo[i] ?? 0));
  return box.every(Number.isFinite) && Math.max(...box) > 0 ? box : undefined;
}

/** Sorted sides of both boxes within `share` of the larger side (a turned export still fits). */
function sidesFit(a: readonly number[], b: readonly number[], share: number): boolean {
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((s, i) => {
    const t = y[i] ?? 0;
    return Math.abs(s - t) <= share * Math.max(s, t, 1);
  });
}

/**
 * Whether two files' parts have the same overall size — the box around all bodies (from
 * their body fingerprints), sides sorted so a turned export (an STL saved Y-up) still fits; within
 * `share` of the larger side. Used to ask "Is this STEP the same part as that mesh?" (names differ).
 */
export function sameOverallSize(
  a: readonly BodyBox[],
  b: readonly BodyBox[],
  share = 0.05,
): boolean {
  const x = overallBox(a);
  const y = overallBox(b);
  return x !== undefined && y !== undefined && sidesFit(x, y, share);
}

/** "40 × 20 × 8.5 mm": whole mm from 10 mm, one decimal below. */
function boxText(box: readonly number[]): string {
  const mm = (v: number): string => String(v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
  return `${box.map(mm).join(' × ')} mm`;
}

/**
 * Why a "new version" looks like another part, after its notes were moved onto it; undefined =
 * nothing stands out. Either sign is enough: a side of the overall box (sides sorted) differs by
 * more than `share` of the larger one, or more than half of the markers that held something were
 * lost (at least two: one lost marker is often just the feature that was removed).
 * E.g. "6 of 8 markers lost; size 40 × 20 × 10 mm → 120 × 80 × 5 mm".
 */
export function differentPartReason(
  before: readonly BodyBox[] | undefined,
  after: readonly BodyBox[],
  markers: { readonly held: number; readonly lost: number },
  share = 0.25,
): string | undefined {
  const reasons: string[] = [];
  if (markers.held >= 2 && markers.lost * 2 > markers.held)
    reasons.push(`${String(markers.lost)} of ${String(markers.held)} markers lost`);
  const x = before ? overallBox(before) : undefined;
  const y = overallBox(after);
  if (x && y && !sidesFit(x, y, share)) reasons.push(`size ${boxText(x)} → ${boxText(y)}`);
  return reasons.length ? reasons.join('; ') : undefined;
}
