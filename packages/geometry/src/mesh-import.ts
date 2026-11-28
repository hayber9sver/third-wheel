/**
 * Mesh-only import: STL (binary / ASCII) and 3MF → a {@link StepModel} with one "face" per
 * body and no edges or vertices, so brush, smart fill, markers and comments work unchanged while
 * entity selection stays off. No kernel: plain parsing, testable in Node.
 *
 * Units: STL has none (mm, like every slicer); 3MF names its unit, converted to mm.
 * Triangle numbers are the file's order (bodies in build order), so paint stays put on reload.
 */
import { DEFAULT_TESSELLATION, FACE_GEOMETRY_STRIDE, type StepModel } from './model.js';

export type MeshFormat = 'stl' | '3mf';

/** A body read from a mesh file: 9 floats (3 corners) per triangle, mm. */
export interface MeshBody {
  readonly name: string;
  readonly triangles: Float32Array;
}

/** Surface type given to mesh "faces" (one per body). */
export const MESH_FACE_TYPE = 'mesh';

/** Shading normals are smoothed across edges flatter than this (sharp edges stay sharp). */
const CREASE_ANGLE_DEG = 30;

/** `.stl` / `.3mf` by file name (any case), else undefined (STEP or unknown). */
export function meshFormatOf(fileName: string): MeshFormat | undefined {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.stl')) return 'stl';
  if (lower.endsWith('.3mf')) return '3mf';
  return undefined;
}

/** Read a mesh file into a model. `name` (file name without extension) names a single-body file. */
export async function importMesh(
  data: ArrayBuffer,
  format: MeshFormat,
  name = 'Body 1',
): Promise<StepModel> {
  const t0 = performance.now();
  const bodies = format === 'stl' ? [{ name, triangles: parseStl(data) }] : await parse3mf(data);
  const read = performance.now() - t0;
  const t1 = performance.now();
  const model = meshModel(bodies, format);
  const mesh = performance.now() - t1;
  return { ...model, stats: { ...model.stats, timings: { ...model.stats.timings, read, mesh } } };
}

// --- STL ---

/** Triangles of an STL file (binary or ASCII), 9 floats each. */
export function parseStl(data: ArrayBuffer): Float32Array {
  const tris = readStl(data);
  if (tris.length === 0) throw new Error('This STL file has no triangles in it.');
  if (!tris.every(Number.isFinite))
    throw new Error('This STL file looks damaged (a triangle has a bad corner).');
  return tris;
}

function readStl(data: ArrayBuffer): Float32Array {
  const view = new DataView(data);
  if (data.byteLength >= 84) {
    const n = view.getUint32(80, true);
    // Binary files say how many triangles follow; some writers add a few trailing bytes.
    if (84 + 50 * n <= data.byteLength && (84 + 50 * n === data.byteLength || !looksAscii(data)))
      return parseBinaryStl(view, n);
  }
  if (looksAscii(data)) return parseAsciiStl(new TextDecoder().decode(data));
  throw new Error('This STL file looks damaged (too short for its triangle count).');
}

function looksAscii(data: ArrayBuffer): boolean {
  const head = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(data.byteLength, 1000)));
  return /^\s*solid\b/.test(head) && /\bfacet\b/.test(head);
}

function parseBinaryStl(view: DataView, n: number): Float32Array {
  const out = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) {
    const at = 84 + t * 50 + 12; // skip the stored normal (often wrong; we compute our own)
    for (let k = 0; k < 9; k++) out[t * 9 + k] = view.getFloat32(at + k * 4, true);
  }
  return out;
}

function parseAsciiStl(text: string): Float32Array {
  const values: number[] = [];
  const re = /vertex\s+(\S+)\s+(\S+)\s+(\S+)/g;
  for (let m = re.exec(text); m; m = re.exec(text))
    values.push(Number(m[1]), Number(m[2]), Number(m[3]));
  if (values.length % 9 !== 0 || values.some((v) => !Number.isFinite(v)))
    throw new Error('This STL file looks damaged (a triangle has a bad corner).');
  return new Float32Array(values);
}

// --- 3MF ---

/** mm per 3MF unit. */
const UNIT_MM: Readonly<Record<string, number>> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

type Matrix = readonly number[]; // 12 numbers, 3MF order (row vectors: p' = [x y z 1] · M)
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

interface Object3mf {
  readonly name: string | undefined;
  readonly type: string;
  readonly vertices: number[];
  readonly triangles: number[];
  readonly components: { path: string; id: string; transform: Matrix }[];
}

interface ModelFile3mf {
  readonly unit: number;
  readonly objects: Map<string, Object3mf>;
  readonly items: { path: string; id: string; transform: Matrix }[];
}

/** Bodies of a 3MF: one per build item (its components joined), in mm. */
export async function parse3mf(data: ArrayBuffer): Promise<MeshBody[]> {
  const zip = readZip(data);
  const rels = zip.get('_rels/.rels');
  const relsText = rels ? new TextDecoder().decode(await rels()) : '';
  const target =
    /Target="([^"]+)"[^>]*Type="[^"]*\/3dmodel"|Type="[^"]*\/3dmodel"[^>]*Target="([^"]+)"/.exec(
      relsText,
    );
  const rootPath = normalPath(target?.[1] ?? target?.[2] ?? '3D/3dmodel.model');

  const files = new Map<string, ModelFile3mf>();
  const load = async (path: string): Promise<ModelFile3mf> => {
    const have = files.get(path);
    if (have) return have;
    const entry = zip.get(path);
    if (!entry) throw new Error(`This 3MF file is missing a part ("${path}").`);
    const parsed = parseModelXml(new TextDecoder().decode(await entry()), path);
    files.set(path, parsed);
    return parsed;
  };
  const root = await load(rootPath);
  // Load every file a component points at (production extension: Bambu / Orca / Prusa projects).
  const pending = [root];
  while (pending.length) {
    const file = pending.pop();
    if (!file) break;
    for (const obj of file.objects.values())
      for (const c of obj.components) if (!files.has(c.path)) pending.push(await load(c.path));
  }
  // Every file uses the root's unit (3MF core spec: only the root model's unit counts).
  const mm = root.unit;

  const bodies: MeshBody[] = [];
  const items = root.items.length
    ? root.items
    : [...root.objects.keys()].map((id) => ({ path: rootPath, id, transform: IDENTITY }));
  for (const item of items) {
    const obj = files.get(item.path)?.objects.get(item.id);
    if (!obj || obj.type === 'support' || obj.type === 'solidsupport') continue;
    const out: number[] = [];
    let partName: string | undefined;
    const add = (o: Object3mf, path: string, m: Matrix, depth: number): void => {
      if (depth > 32) throw new Error('This 3MF file has components nested too deep.');
      partName ??= o.name;
      const v = o.vertices;
      const tris = o.triangles;
      // A mirroring transform (negative determinant) turns the triangles inside out: swap two
      // corners so the outside stays the front side.
      const det =
        (m[0] ?? 0) * ((m[4] ?? 0) * (m[8] ?? 0) - (m[5] ?? 0) * (m[7] ?? 0)) -
        (m[1] ?? 0) * ((m[3] ?? 0) * (m[8] ?? 0) - (m[5] ?? 0) * (m[6] ?? 0)) +
        (m[2] ?? 0) * ((m[3] ?? 0) * (m[7] ?? 0) - (m[4] ?? 0) * (m[6] ?? 0));
      for (let i = 0; i < tris.length; i++) {
        const k = i % 3;
        const t = det < 0 && k > 0 ? (tris[i - k + 3 - k] ?? NaN) : (tris[i] ?? NaN);
        const x = v[t * 3] ?? NaN;
        const y = v[t * 3 + 1] ?? NaN;
        const z = v[t * 3 + 2] ?? NaN;
        out.push(
          (x * (m[0] ?? 0) + y * (m[3] ?? 0) + z * (m[6] ?? 0) + (m[9] ?? 0)) * mm,
          (x * (m[1] ?? 0) + y * (m[4] ?? 0) + z * (m[7] ?? 0) + (m[10] ?? 0)) * mm,
          (x * (m[2] ?? 0) + y * (m[5] ?? 0) + z * (m[8] ?? 0) + (m[11] ?? 0)) * mm,
        );
      }
      for (const c of o.components) {
        const child = files.get(c.path === '' ? path : c.path)?.objects.get(c.id);
        if (!child) throw new Error(`This 3MF file points at a missing object (${c.id}).`);
        add(child, c.path === '' ? path : c.path, multiply(c.transform, m), depth + 1);
      }
    };
    add(obj, item.path, item.transform, 0);
    if (out.some((x) => !Number.isFinite(x)))
      throw new Error('This 3MF file looks damaged (a triangle points at a missing vertex).');
    if (out.length)
      bodies.push({ name: obj.name ?? partName ?? '', triangles: new Float32Array(out) });
  }
  if (!bodies.length) throw new Error('This 3MF file has no mesh in it.');
  return bodies;
}

/** a then b (row vectors): p · a · b. */
function multiply(a: Matrix, b: Matrix): Matrix {
  const r: number[] = [];
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) {
      let s = i === 3 ? (b[9 + j] ?? 0) : 0;
      for (let k = 0; k < 3; k++) s += (a[i * 3 + k] ?? 0) * (b[k * 3 + j] ?? 0);
      r.push(s);
    }
  return r;
}

function normalPath(p: string): string {
  return p.replace(/^\/+/, '');
}

function parseTransform(s: string | undefined): Matrix {
  if (!s) return IDENTITY;
  const n = s.trim().split(/\s+/).map(Number);
  return n.length === 12 && n.every(Number.isFinite) ? n : IDENTITY;
}

const ATTR = /([\w:]+)\s*=\s*"([^"]*)"/g;
function attrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR.lastIndex = 0;
  for (let m = ATTR.exec(s); m; m = ATTR.exec(s)) out[m[1] ?? 0] = unescapeXml(m[2] ?? '');
  return out;
}

function unescapeXml(s: string): string {
  return s.includes('&')
    ? s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(+d))
        .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, '&')
    : s;
}

/** Element name without namespace prefix (`p:component` → `component`). */
function local(tag: string): string {
  const i = tag.indexOf(':');
  return i < 0 ? tag : tag.slice(i + 1);
}

/** One 3MF model XML part. Only what we need: objects (mesh / components), build items, unit. */
function parseModelXml(xml: string, path: string): ModelFile3mf {
  const objects = new Map<string, Object3mf>();
  const items: ModelFile3mf['items'] = [];
  let unit = 1;
  let obj: Object3mf | undefined;
  // Fast attribute readers for the two tags that make up nearly all of the file.
  const num = (s: string, key: string): number => {
    // The attribute name preceded by any whitespace (not `xv1=`; space, tab or newline).
    let i = s.indexOf(`${key}="`);
    while (i > 0 && !/\s/.test(s.charAt(i - 1))) i = s.indexOf(`${key}="`, i + 1);
    if (i <= 0) return NaN;
    const from = i + key.length + 2;
    return Number(s.slice(from, s.indexOf('"', from)));
  };
  const TAG = /<([\w:]+)([^>]*)>/g;
  for (let m = TAG.exec(xml); m; m = TAG.exec(xml)) {
    const name = local(m[1] ?? '');
    const rest = m[2] ?? '';
    if (name === 'vertex') {
      obj?.vertices.push(num(rest, 'x'), num(rest, 'y'), num(rest, 'z'));
    } else if (name === 'triangle') {
      obj?.triangles.push(num(rest, 'v1'), num(rest, 'v2'), num(rest, 'v3'));
    } else if (name === 'model') {
      const u = attrs(rest).unit;
      unit = (u === undefined ? undefined : UNIT_MM[u]) ?? 1;
    } else if (name === 'object') {
      const a = attrs(rest);
      obj = { name: a.name, type: a.type ?? 'model', vertices: [], triangles: [], components: [] };
      if (a.id !== undefined) objects.set(a.id, obj);
    } else if (name === 'component') {
      const a = attrs(rest);
      if (obj && a.objectid !== undefined)
        obj.components.push({
          path: normalPath(a['p:path'] ?? a.path ?? path),
          id: a.objectid,
          transform: parseTransform(a.transform),
        });
    } else if (name === 'item') {
      const a = attrs(rest);
      if (a.objectid !== undefined)
        items.push({
          path: normalPath(a['p:path'] ?? a.path ?? path),
          id: a.objectid,
          transform: parseTransform(a.transform),
        });
    }
  }
  return { unit, objects, items };
}

// --- Zip (3MF container) ---

/** Entries of a zip by path (case-insensitive lookup is not needed: 3MF names are exact). */
export function readZip(data: ArrayBuffer): Map<string, () => Promise<Uint8Array>> {
  const view = new DataView(data);
  const bytes = new Uint8Array(data);
  let eocd = -1;
  for (let i = data.byteLength - 22; i >= Math.max(0, data.byteLength - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This is not a 3MF file (it is not a zip archive).');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff)
    throw new Error('This 3MF file is too large to read (zip64 is not supported yet).');
  const entries = new Map<string, () => Promise<Uint8Array>>();
  const decoder = new TextDecoder();
  for (let e = 0; e < count; e++) {
    if (at + 46 > data.byteLength || view.getUint32(at, true) !== 0x02014b50)
      throw new Error('This 3MF file looks damaged (zip directory).');
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    entries.set(name, async () => {
      const damaged = new Error('This 3MF file looks damaged (zip entry).');
      if (local + 30 > data.byteLength || view.getUint32(local, true) !== 0x04034b50) throw damaged;
      const start =
        local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      if (start + size > data.byteLength) throw damaged;
      const raw = bytes.subarray(start, start + size);
      if (method === 0) return raw;
      if (method !== 8)
        throw new Error(`This 3MF file uses an unknown compression (${String(method)}).`);
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    });
  }
  return entries;
}

// --- Model ---

/** Bodies → model: one face per body, shading normals smoothed below the crease angle. */
export function meshModel(bodies: readonly MeshBody[], format: MeshFormat): StepModel {
  let triCount = 0;
  for (const b of bodies) triCount += b.triangles.length / 9;
  const positions = new Float32Array(triCount * 9);
  const triangleFace = new Uint32Array(triCount);
  let t0 = 0;
  bodies.forEach((b, i) => {
    positions.set(b.triangles, t0 * 9);
    triangleFace.fill(i, t0, t0 + b.triangles.length / 9);
    t0 += b.triangles.length / 9;
  });
  const indices = new Uint32Array(triCount * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = i;
  const normals = creaseNormals(positions, triangleFace);

  const n = bodies.length;
  const fallback = n === 1 ? 'Body 1' : undefined;
  const names = bodies.map((b, i) => (b.name.trim() || fallback) ?? `Body ${String(i + 1)}`);
  const seen = new Map<string, number>();
  for (const name of names) seen.set(name, (seen.get(name) ?? 0) + 1);
  const nth = new Map<string, number>();
  const bodyNames = names.map((name) => {
    if ((seen.get(name) ?? 0) < 2) return name;
    const k = (nth.get(name) ?? 0) + 1;
    nth.set(name, k);
    return `${name} [${String(k)}]`;
  });

  return {
    tessellation: DEFAULT_TESSELLATION,
    meshFormat: format,
    positions,
    normals,
    indices,
    triangleFace,
    faceBody: Uint32Array.from({ length: n }, (_, i) => i),
    faceTypes: bodies.map(() => MESH_FACE_TYPE),
    faceGeometry: new Float32Array(n * FACE_GEOMETRY_STRIDE).fill(NaN),
    edgePoints: new Float32Array(0),
    edgeRanges: new Uint32Array(0),
    edgeBody: new Uint32Array(0),
    edgeChain: new Uint32Array(0),
    edgeTypes: [],
    edgeGeometry: new Float32Array(0),
    vertexPositions: new Float32Array(0),
    vertexBody: new Uint32Array(0),
    bodyCount: n,
    hasLooseBody: false,
    bodyNames,
    bodyPaths: bodies.map(() => ''),
    assemblies: [],
    bodyAssembly: new Int32Array(n).fill(-1),
    stats: {
      timings: { read: 0, topology: 0, mesh: 0, edges: 0, info: 0 },
      hashCollisions: 0,
      unexplainedEdgesWithoutPolyline: [],
      partNamesMatched: true,
    },
  };
}

/**
 * Per corner: the area-weighted normal of the triangles at that point (same body) whose facet
 * normal is within the crease angle of this triangle's, so curved surfaces look smooth and sharp
 * edges stay sharp. Corners are joined by exact position.
 */
function creaseNormals(positions: Float32Array, triangleFace: Uint32Array): Float32Array {
  const triCount = triangleFace.length;
  const facet = new Float32Array(triCount * 3); // area-weighted (length = 2 × area)
  for (let t = 0; t < triCount; t++) {
    const p = t * 9;
    const ux = (positions[p + 3] ?? 0) - (positions[p] ?? 0);
    const uy = (positions[p + 4] ?? 0) - (positions[p + 1] ?? 0);
    const uz = (positions[p + 5] ?? 0) - (positions[p + 2] ?? 0);
    const vx = (positions[p + 6] ?? 0) - (positions[p] ?? 0);
    const vy = (positions[p + 7] ?? 0) - (positions[p + 1] ?? 0);
    const vz = (positions[p + 8] ?? 0) - (positions[p + 2] ?? 0);
    facet[t * 3] = uy * vz - uz * vy;
    facet[t * 3 + 1] = uz * vx - ux * vz;
    facet[t * 3 + 2] = ux * vy - uy * vx;
  }
  // Weld corners: welded id per corner (3 per triangle).
  const corners = triCount * 3;
  const { weld, count } = weldCorners(positions, triangleFace);
  // Corners per welded point (CSR).
  const start = new Uint32Array(count + 1);
  for (let c = 0; c < corners; c++) {
    const w = (weld[c] ?? 0) + 1;
    start[w] = (start[w] ?? 0) + 1;
  }
  for (let i = 0; i < count; i++) start[i + 1] = (start[i + 1] ?? 0) + (start[i] ?? 0);
  const fill = start.slice(0, count);
  const list = new Uint32Array(corners);
  for (let c = 0; c < corners; c++) {
    const w = weld[c] ?? 0;
    const at = fill[w] ?? 0;
    fill[w] = at + 1;
    list[at] = c;
  }

  const cos = Math.cos((CREASE_ANGLE_DEG * Math.PI) / 180);
  const unitN = new Float32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    const x = facet[t * 3] ?? 0;
    const y = facet[t * 3 + 1] ?? 0;
    const z = facet[t * 3 + 2] ?? 0;
    const l = Math.hypot(x, y, z);
    if (l > 0) {
      unitN[t * 3] = x / l;
      unitN[t * 3 + 1] = y / l;
      unitN[t * 3 + 2] = z / l;
    }
  }
  const normals = new Float32Array(corners * 3);
  for (let c = 0; c < corners; c++) {
    const t = Math.floor(c / 3);
    const ax = unitN[t * 3] ?? 0;
    const ay = unitN[t * 3 + 1] ?? 0;
    const az = unitN[t * 3 + 2] ?? 0;
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const w = weld[c] ?? 0;
    for (let i = start[w] ?? 0; i < (start[w + 1] ?? 0); i++) {
      const o = Math.floor((list[i] ?? 0) / 3);
      const dot =
        ax * (unitN[o * 3] ?? 0) + ay * (unitN[o * 3 + 1] ?? 0) + az * (unitN[o * 3 + 2] ?? 0);
      if (o !== t && dot < cos) continue;
      sx += facet[o * 3] ?? 0;
      sy += facet[o * 3 + 1] ?? 0;
      sz += facet[o * 3 + 2] ?? 0;
    }
    const l = Math.hypot(sx, sy, sz);
    if (l > 0) {
      normals[c * 3] = sx / l;
      normals[c * 3 + 1] = sy / l;
      normals[c * 3 + 2] = sz / l;
    } else {
      [normals[c * 3], normals[c * 3 + 1], normals[c * 3 + 2]] = [ax, ay, az];
    }
  }
  return normals;
}

/** Welded point id per corner: same bits (−0 and +0 apart is fine) and same body. */
function weldCorners(
  positions: Float32Array,
  triangleFace: Uint32Array,
): { weld: Uint32Array; count: number } {
  const bits = new Uint32Array(positions.buffer, positions.byteOffset, positions.length);
  const corners = triangleFace.length * 3;
  const weld = new Uint32Array(corners);
  let size = 1;
  while (size < corners * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1); // first corner of each welded point
  let count = 0;
  const same = (a: number, b: number): boolean =>
    bits[a * 3] === bits[b * 3] &&
    bits[a * 3 + 1] === bits[b * 3 + 1] &&
    bits[a * 3 + 2] === bits[b * 3 + 2] &&
    triangleFace[Math.floor(a / 3)] === triangleFace[Math.floor(b / 3)];
  for (let c = 0; c < corners; c++) {
    let h =
      (Math.imul(bits[c * 3] ?? 0, 0x9e3779b1) ^
        Math.imul(bits[c * 3 + 1] ?? 0, 0x85ebca77) ^
        Math.imul(bits[c * 3 + 2] ?? 0, 0xc2b2ae3d)) &
      mask;
    for (;;) {
      const first = table[h] ?? -1;
      if (first < 0) {
        table[h] = c;
        weld[c] = count++;
        break;
      }
      if (same(first, c)) {
        weld[c] = weld[first] ?? 0;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return { weld, count };
}
