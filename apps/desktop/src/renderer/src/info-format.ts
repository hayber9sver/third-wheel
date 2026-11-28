/**
 * Text for the Info panel and the hover readout, pure. Numbers come from
 * `@third-wheel/geometry` (`entityInfo`, `measure`); this file only words and formats them.
 * Lengths in mm, angles in degrees; "≈" marks values taken from the mesh. Exact values from
 * OpenCascade ("Exact values" button) replace them via {@link ExactValues}.
 */
import {
  entityDimension,
  entityInfo,
  faceAreas,
  measure,
  pairDimension,
  type Dimension,
  pairKey,
  type EntityInfo,
  type EntityRef,
  type ExactRequest,
  type ExactResult,
  type InfoModel,
  type Measurement,
  type V3,
} from '@third-wheel/geometry';
import type { DimensionSpec } from './dimension-overlay.js';
import type { SelectionItem } from './selection.js';

export interface InfoRow {
  readonly label: string;
  readonly value: string;
}
export interface InfoBlock {
  readonly title: string;
  readonly rows: readonly InfoRow[];
  /** Small grey line under the rows (e.g. why a value stays "≈"). */
  readonly note?: string;
}

/** OpenCascade returned no exact distance (NaN): the "≈" stays and this says why. */
export const EXACT_DISTANCE_FAILED_NOTE =
  "Exact distance not available for these two (OpenCascade couldn't compute it); ≈ is measured on the mesh.";

/** Round, drop trailing zeros, never "-0". */
export function num(x: number, decimals = 3): string {
  const f = 10 ** decimals;
  const r = Math.round(x * f) / f + 0;
  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: decimals,
    useGrouping: false,
  }).format(r);
}
export const mm = (x: number): string => `${num(x)} mm`;
export const degrees = (x: number): string => `${num(x, 2)}°`;
const approx = (exact: boolean): string => (exact ? '' : '≈ ');
const area = (x: number, exact = false): string => `${approx(exact)}${num(x, 2)} mm²`;
const point = (p: V3): string => `(${p.map((c) => num(c)).join(', ')})`;
const direction = (d: V3): string => `(${d.map((c) => num(c, 4)).join(', ')})`;

const TYPE_NAMES: Record<string, string> = {
  bspline: 'B-spline',
  bezier: 'Bézier',
  revolution: 'Revolved surface',
  extrusion: 'Extruded surface',
};
function typeName(info: EntityInfo): string {
  if (info.type === 'circle' && info.arcAngle !== undefined && info.arcAngle < 359.99) return 'Arc';
  const t = info.type ?? info.kind;
  return TYPE_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
}
const FORM_NAMES = { hole: 'hole', shaft: 'shaft / boss', hollow: 'hollow', ball: 'ball' } as const;

/** Title of an entity's block, e.g. "Face 12 · Cylinder (hole)", "Edge 3 · Arc", "Vertex 7". */
export function infoTitle(info: EntityInfo): string {
  if (info.kind === 'body') return info.name ?? `Body ${String(info.id + 1)}`;
  const kind = info.kind.charAt(0).toUpperCase() + info.kind.slice(1);
  const head = `${kind} ${String(info.id)}`;
  if (info.kind === 'vertex') return head;
  return `${head} · ${typeName(info)}${info.form ? ` (${FORM_NAMES[info.form]})` : ''}`;
}

/**
 * Exact values computed so far for the shown model, by entity id / {@link pairKey}.
 * Filled from {@link ExactResult}s; cleared when another model loads.
 */
export class ExactValues {
  readonly faceArea = new Map<number, number>();
  readonly bodyArea = new Map<number, number>();
  readonly bodyBox = new Map<number, { readonly min: V3; readonly max: V3 }>();
  /** NaN: OpenCascade could not compute it (not asked again). */
  readonly distance = new Map<string, number>();

  add(request: ExactRequest, result: ExactResult): void {
    request.faceAreas.forEach((id, i) => {
      this.set(this.faceArea, id, result.faceAreas[i]);
    });
    request.bodyAreas.forEach((id, i) => {
      this.set(this.bodyArea, id, result.bodyAreas[i]);
    });
    request.bodyBoxes.forEach((id, i) => {
      this.set(this.bodyBox, id, result.bodyBoxes[i]);
    });
    request.distances.forEach(([a, b], i) => {
      this.set(this.distance, pairKey(a, b), result.distances[i]);
    });
  }

  private set<K, V>(map: Map<K, V>, key: K, value: V | undefined): void {
    if (value !== undefined) map.set(key, value);
  }
}

/** Which values of an entity's rows are exact (default: the mesh ones are not). */
export interface ExactFlags {
  readonly area?: boolean;
  readonly box?: boolean;
}

/** Detail rows of one entity, in reading order. */
export function infoRows(info: EntityInfo, exact: ExactFlags = {}): InfoRow[] {
  const rows: InfoRow[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) rows.push({ label, value });
  };
  const opt = <T>(v: T | undefined, f: (v: T) => string): string | undefined =>
    v === undefined ? undefined : f(v);
  if (info.position) {
    add('X', mm(info.position[0]));
    add('Y', mm(info.position[1]));
    add('Z', mm(info.position[2]));
  }
  if (info.radius !== undefined && info.type !== 'torus') {
    add('Diameter', `Ø ${mm(info.radius * 2)}`);
    add('Radius', mm(info.radius));
  }
  if (info.type === 'torus') {
    add('Major radius', opt(info.radius, mm));
    add('Minor radius', opt(info.minorRadius, mm));
  }
  add('Half-angle', opt(info.halfAngle, degrees));
  add('Length', opt(info.length, mm));
  if (info.arcAngle !== undefined && info.arcAngle < 359.99)
    add('Arc angle', degrees(info.arcAngle));
  add('Centre', opt(info.centre, point));
  add('Apex', opt(info.apex, point));
  add('Axis', opt(info.axis, direction));
  add('Direction', opt(info.direction, direction));
  add('Normal', opt(info.normal, direction));
  if (info.kind === 'body') {
    add('Assembly', info.path);
    add('Faces', opt(info.faceCount, String));
    add('Edges', opt(info.edgeCount, String));
    if (info.bboxMin && info.bboxMax) {
      const size = [0, 1, 2].map((i) => num((info.bboxMax?.[i] ?? 0) - (info.bboxMin?.[i] ?? 0)));
      add('Size X × Y × Z', `${approx(exact.box === true)}${size.join(' × ')} mm`);
    }
  }
  add(
    'Area',
    opt(info.area, (a) => area(a, exact.area === true)),
  );
  return rows;
}

const ANGLE_LABELS: Record<NonNullable<Measurement['angleBetween']>, string> = {
  lines: 'Angle',
  planes: 'Angle',
  'edge-plane': 'Edge to plane',
  'axis-plane': 'Axis to plane',
};
const SKIPPED_TEXT: Record<NonNullable<Measurement['distanceSkipped']>, string> = {
  'too-large': '— (too large to compare)',
  'no-geometry': '— (no shape to measure)',
};

/** Rows for a measurement between two entities. */
export function measurementRows(r: Measurement): InfoRow[] {
  const rows: InfoRow[] = [];
  if (r.distance)
    rows.push({
      label: 'Shortest distance',
      value: `${r.distance.exact ? '' : '≈ '}${mm(r.distance.value)}`,
    });
  if (r.centreDistance !== undefined) {
    rows.push({ label: 'Centre to centre', value: mm(r.centreDistance) });
    if (r.delta)
      rows.push({ label: 'ΔX, ΔY, ΔZ', value: `${r.delta.map((c) => num(c)).join(', ')} mm` });
  }
  if (r.axisDistance !== undefined) rows.push({ label: 'To axis', value: mm(r.axisDistance) });
  if (r.planeDistance !== undefined)
    rows.push({ label: 'Perpendicular to plane', value: mm(r.planeDistance) });
  if (r.angle !== undefined)
    rows.push({ label: ANGLE_LABELS[r.angleBetween ?? 'lines'], value: degrees(r.angle) });
  if (r.distanceSkipped)
    rows.unshift({ label: 'Shortest distance', value: SKIPPED_TEXT[r.distanceSkipped] });
  return rows;
}

const PLURAL: Record<SelectionItem['kind'], string> = {
  vertex: 'vertices',
  edge: 'edges',
  face: 'faces',
  body: 'bodies',
};

/** Mesh distance is exact only between vertices / straight edges (as in `meshDistance`). */
function meshDistanceExact(m: InfoModel, r: EntityRef): boolean {
  return r.kind === 'vertex' || (r.kind === 'edge' && m.edgeTypes[r.id] === 'line');
}

/** The entity with exact values from `exact` swapped in, and which ones are exact. */
function withExact(info: EntityInfo, exact: ExactValues): { info: EntityInfo; flags: ExactFlags } {
  if (info.kind === 'face') {
    const a = exact.faceArea.get(info.id);
    return a === undefined
      ? { info, flags: {} }
      : { info: { ...info, area: a }, flags: { area: true } };
  }
  if (info.kind !== 'body') return { info, flags: {} };
  const a = exact.bodyArea.get(info.id);
  const box = exact.bodyBox.get(info.id);
  return {
    info: {
      ...info,
      ...(a === undefined ? {} : { area: a }),
      ...(box === undefined ? {} : { bboxMin: box.min, bboxMax: box.max }),
    },
    flags: { area: a !== undefined, box: box !== undefined },
  };
}

/** A measurement with the exact shortest distance swapped in (if known and computable). */
function measurementWithExact(r: Measurement, exact: number | undefined): Measurement {
  if (exact === undefined || !Number.isFinite(exact)) return r;
  const out: Measurement = { ...r, distance: { value: exact, exact: true } };
  delete (out as { distanceSkipped?: unknown }).distanceSkipped;
  return out;
}

/**
 * Blocks for the Info panel: one entity → its details; two → both plus a "Between" block;
 * more → counts, total edge length and face area. Values found in `exact` replace the mesh ones.
 */
export function describeSelection(
  m: InfoModel,
  items: readonly SelectionItem[],
  exact: ExactValues = new ExactValues(),
): InfoBlock[] {
  if (items.length === 0) return [];
  const faces = items.flatMap((i) => (i.kind === 'face' ? [i.id] : []));
  const areas = faceAreas(
    m,
    faces.filter((id) => !exact.faceArea.has(id)),
  );
  for (const id of faces) {
    const a = exact.faceArea.get(id);
    if (a !== undefined) areas.set(id, a);
  }
  if (items.length <= 2) {
    const blocks = items.map((item) => {
      const { info, flags } = withExact(entityInfo(m, item, areas), exact);
      return { title: infoTitle(info), rows: infoRows(info, flags) };
    });
    const [a, b] = items;
    if (a && b) {
      const exactDistance = exact.distance.get(pairKey(a, b));
      const r = measurementWithExact(measure(m, a, b), exactDistance);
      const failed =
        exactDistance !== undefined && Number.isNaN(exactDistance) && r.distance?.exact === false;
      blocks.push({
        title: 'Between',
        rows: measurementRows(r),
        ...(failed ? { note: EXACT_DISTANCE_FAILED_NOTE } : {}),
      });
    }
    return blocks;
  }
  const rows: InfoRow[] = [];
  for (const kind of ['vertex', 'edge', 'face', 'body'] as const) {
    const n = items.filter((i) => i.kind === kind).length;
    if (n > 0)
      rows.push({
        label: PLURAL[kind].charAt(0).toUpperCase() + PLURAL[kind].slice(1),
        value: String(n),
      });
  }
  const edgeLength = items.reduce(
    (sum, i) => (i.kind === 'edge' ? sum + (entityInfo(m, i).length ?? 0) : sum),
    0,
  );
  if (items.some((i) => i.kind === 'edge'))
    rows.push({ label: 'Total edge length', value: mm(edgeLength) });
  if (faces.length > 0) {
    let total = 0;
    for (const a of areas.values()) total += a;
    rows.push({
      label: 'Total face area',
      value: area(
        total,
        faces.every((id) => exact.faceArea.has(id)),
      ),
    });
  }
  return [{ title: `${String(items.length)} selected`, rows }];
}

/**
 * What {@link describeSelection} still shows from the mesh ("≈") for these items: the request
 * for the "Exact values" button. Empty when everything shown is exact.
 */
export function approxRequest(
  m: InfoModel,
  items: readonly SelectionItem[],
  exact: ExactValues,
): ExactRequest {
  const faceAreas = [
    ...new Set(
      items.flatMap((i) => (i.kind === 'face' && !exact.faceArea.has(i.id) ? [i.id] : [])),
    ),
  ];
  if (items.length > 2) return { faceAreas, bodyAreas: [], bodyBoxes: [], distances: [] };
  const bodies = items.flatMap((i) => (i.kind === 'body' ? [i.id] : []));
  const [a, b] = items;
  const distances: [EntityRef, EntityRef][] =
    a &&
    b &&
    !exact.distance.has(pairKey(a, b)) &&
    !(meshDistanceExact(m, a) && meshDistanceExact(m, b))
      ? [[a, b]]
      : [];
  return {
    faceAreas,
    bodyAreas: bodies.filter((id) => !exact.bodyArea.has(id)),
    bodyBoxes: bodies.filter((id) => !exact.bodyBox.has(id)),
    distances,
  };
}

/** Short size hint for the hover readout, e.g. "Ø6 hole", "R3 arc", "40 mm"; "" if none. */
export function sizeHint(info: EntityInfo): string {
  if (info.kind === 'edge') {
    if (info.radius !== undefined)
      return typeName(info) === 'Arc' ? `R${num(info.radius)}` : `Ø${num(info.radius * 2)}`;
    return info.length !== undefined ? mm(info.length) : '';
  }
  if (info.type === 'torus' && info.radius !== undefined) return `R${num(info.radius)}`;
  if (info.radius !== undefined)
    return `Ø${num(info.radius * 2)}${info.form ? ` ${FORM_NAMES[info.form]}` : ''}`;
  if (info.halfAngle !== undefined)
    return `${degrees(info.halfAngle)}${info.form ? ` ${FORM_NAMES[info.form]}` : ''}`;
  return '';
}

/** The value on a drawn dimension: "40 mm", "≈ 2.5 mm", "Ø6 mm", "R5 mm", "90°". */
export function dimensionLabel(d: Pick<Dimension, 'kind' | 'value' | 'exact'>): string {
  const prefix = d.kind === 'diameter' ? 'Ø' : d.kind === 'radius' ? 'R' : '';
  return d.kind === 'angle' ? degrees(d.value) : `${approx(d.exact)}${prefix}${mm(d.value)}`;
}

/**
 * The one dimension drawn for 1–2 entities, with the same numbers Info shows (exact
 * distances from `exact` swapped in); undefined for 0 or 3+ entities or nothing to draw.
 */
export function dimensionOf(
  m: InfoModel,
  items: readonly SelectionItem[],
  exact: ExactValues = new ExactValues(),
): DimensionSpec | undefined {
  const [a, b] = items;
  if (!a || items.length > 2) return undefined;
  const d = b
    ? pairDimension(
        m,
        a,
        b,
        measurementWithExact(measure(m, a, b), exact.distance.get(pairKey(a, b))),
      )
    : entityDimension(m, a);
  return d && { from: d.from, to: d.to, label: dimensionLabel(d) };
}
