import { readFileSync } from 'node:fs';
import { OcctKernel } from 'occt-wasm';
import { describe, expect, it } from 'vitest';
import { importMesh, meshFormatOf, parse3mf, parseStl } from './mesh-import.js';
import { importStep } from './step-import.js';

/** Two triangles forming a unit square in z = 0, plus one on a 90° wall (sharp edge). */
const TRIS = [
  [0, 0, 0, 1, 0, 0, 1, 1, 0],
  [0, 0, 0, 1, 1, 0, 0, 1, 0],
  [1, 0, 0, 1, 1, 1, 1, 1, 0],
];

function binaryStl(tris: number[][]): ArrayBuffer {
  const buf = new ArrayBuffer(84 + 50 * tris.length);
  const v = new DataView(buf);
  v.setUint32(80, tris.length, true);
  tris.forEach((t, i) => {
    t.forEach((x, k) => {
      v.setFloat32(84 + i * 50 + 12 + k * 4, x, true);
    });
  });
  return buf;
}

function asciiStl(tris: number[][]): ArrayBuffer {
  const facets = tris.map(
    (t) =>
      `facet normal 0 0 1\n outer loop\n` +
      [0, 1, 2].map((c) => `  vertex ${t.slice(c * 3, c * 3 + 3).join(' ')}\n`).join('') +
      ` endloop\nendfacet\n`,
  );
  return new TextEncoder().encode(`solid test\n${facets.join('')}endsolid test\n`).buffer;
}

/** Minimal zip writer: entries deflated (`deflate`) or stored. */
async function zip(files: Record<string, string>, deflate = true): Promise<ArrayBuffer> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const data = deflate
      ? new Uint8Array(
          await new Response(
            new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw')),
          ).arrayBuffer(),
        )
      : raw;
    const nameBytes = enc.encode(name);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, deflate ? 8 : 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const cen = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cen.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, deflate ? 8 : 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cen.set(nameBytes, 46);
    locals.push(local);
    central.push(cen);
    offset += local.length;
  }
  const cenSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cenSize, true);
  ev.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...locals, ...central, end]).arrayBuffer()).buffer;
}

const RELS = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

const TRIANGLE_OBJECT = (id: number, name: string): string =>
  `<object id="${String(id)}" name="${name}" type="model"><mesh><vertices>` +
  `<vertex x="0" y="0" z="0"/><vertex x="1" y="0" z="0"/><vertex x="0" y="1" z="0"/>` +
  `</vertices><triangles><triangle v1="0" v2="1" v3="2"/></triangles></mesh></object>`;

describe('meshFormatOf', () => {
  it('reads the extension in any case', () => {
    expect(meshFormatOf('a.STL')).toBe('stl');
    expect(meshFormatOf('b.3mf')).toBe('3mf');
    expect(meshFormatOf('c.step')).toBeUndefined();
  });
});

describe('parseStl', () => {
  it('reads binary and ASCII to the same triangles', () => {
    const b = parseStl(binaryStl(TRIS));
    const a = parseStl(asciiStl(TRIS));
    expect([...b]).toEqual(TRIS.flat());
    expect([...a]).toEqual(TRIS.flat());
  });

  it('reads a binary file whose header starts with "solid"', () => {
    const buf = binaryStl(TRIS);
    new Uint8Array(buf).set(new TextEncoder().encode('solid exported'), 0);
    expect(parseStl(buf).length).toBe(27);
  });

  it('refuses an empty file and a non-finite corner', () => {
    expect(() => parseStl(binaryStl([]))).toThrow(/no triangles/);
    expect(() => parseStl(binaryStl([[0, 0, 0, 1, 0, 0, NaN, 1, 0]]))).toThrow(/damaged/);
  });

  it('refuses a cut-off binary file', () => {
    expect(() => parseStl(binaryStl(TRIS).slice(0, 120))).toThrow(/damaged/);
  });
});

describe('importMesh', () => {
  it('one body, one face, no edges or vertices; triangles in file order', async () => {
    const m = await importMesh(binaryStl(TRIS), 'stl', 'bracket');
    expect(m.meshFormat).toBe('stl');
    expect(m.bodyCount).toBe(1);
    expect(m.bodyNames).toEqual(['bracket']);
    expect([...m.faceBody]).toEqual([0]);
    expect(m.faceTypes).toEqual(['mesh']);
    expect([...m.triangleFace]).toEqual([0, 0, 0]);
    expect(m.edgeRanges.length).toBe(0);
    expect(m.vertexPositions.length).toBe(0);
    expect([...m.positions]).toEqual(TRIS.flat());
  });

  it('smooths shading on the flat square but keeps the 90° edge sharp', async () => {
    const m = await importMesh(binaryStl(TRIS), 'stl');
    const n = (c: number): number[] =>
      [...m.normals.slice(c * 3, c * 3 + 3)].map((x) => +x.toFixed(6));
    expect(n(0)).toEqual([0, 0, 1]); // square corner
    expect(n(4)).toEqual([0, 0, 1]); // shared corner (1, 1, 0) seen from the square
    expect(n(8)).toEqual([-1, 0, 0]); // same point seen from the wall (wound to face −x)
  });
});

describe('parse3mf', () => {
  it('one body per build item, transforms and units applied', async () => {
    const model =
      `<?xml version="1.0"?><model unit="centimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>` +
      TRIANGLE_OBJECT(1, 'Lid') +
      TRIANGLE_OBJECT(2, 'Box &amp; base') +
      `</resources><build><item objectid="1"/><item objectid="2" transform="1 0 0 0 1 0 0 0 1 10 0 0"/></build></model>`;
    const bodies = await parse3mf(await zip({ '_rels/.rels': RELS, '3D/3dmodel.model': model }));
    expect(bodies.map((b) => b.name)).toEqual(['Lid', 'Box & base']);
    expect([...(bodies[0]?.triangles ?? [])]).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 0]);
    expect([...(bodies[1]?.triangles ?? [])]).toEqual([100, 0, 0, 110, 0, 0, 100, 10, 0]);
  });

  it('follows components into other model files (slicer projects)', async () => {
    const root =
      `<model unit="millimeter" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"><resources>` +
      `<object id="5" name="Plate part" type="model"><components>` +
      `<p:component p:path="/3D/Objects/object_1.model" objectid="1" transform="2 0 0 0 2 0 0 0 2 0 0 5"/>` +
      `</components></object></resources><build><item objectid="5"/></build></model>`;
    const part = `<model unit="millimeter"><resources>${TRIANGLE_OBJECT(1, '')}</resources><build/></model>`;
    const bodies = await parse3mf(
      await zip(
        { '_rels/.rels': RELS, '3D/3dmodel.model': root, '3D/Objects/object_1.model': part },
        false,
      ),
    );
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.name).toBe('Plate part');
    expect([...(bodies[0]?.triangles ?? [])]).toEqual([0, 0, 5, 2, 0, 5, 0, 2, 5]);
  });

  it('a mirroring transform keeps the outside facing out (winding swapped)', async () => {
    const model =
      `<model><resources>${TRIANGLE_OBJECT(1, 'M')}</resources>` +
      `<build><item objectid="1" transform="-1 0 0 0 1 0 0 0 1 0 0 0"/></build></model>`;
    const m = await importMesh(await zip({ '3D/3dmodel.model': model }), '3mf');
    // (0,0,0) (0,1,0) (-1,0,0): still faces +z like the unmirrored triangle.
    expect([...m.positions]).toEqual([0, 0, 0, 0, 1, 0, -1, 0, 0]);
    expect(m.normals[2]).toBeCloseTo(1);
  });

  it('skips support objects', async () => {
    const model =
      `<model><resources>${TRIANGLE_OBJECT(1, 'Part')}` +
      TRIANGLE_OBJECT(2, 'S').replace('type="model"', 'type="solidsupport"') +
      `</resources><build><item objectid="1"/><item objectid="2"/></build></model>`;
    const bodies = await parse3mf(await zip({ '3D/3dmodel.model': model }));
    expect(bodies.map((b) => b.name)).toEqual(['Part']);
  });

  it('names duplicate bodies apart', async () => {
    const model =
      `<model><resources>${TRIANGLE_OBJECT(1, 'Pin')}</resources>` +
      `<build><item objectid="1"/><item objectid="1"/></build></model>`;
    const buf = await zip({ '3D/3dmodel.model': model });
    const m = await importMesh(buf, '3mf');
    expect(m.bodyNames).toEqual(['Pin [1]', 'Pin [2]']);
    expect([...m.triangleFace]).toEqual([0, 1]);
    expect([...m.faceBody]).toEqual([0, 1]);
  });

  it('refuses a file that is not a zip', async () => {
    await expect(parse3mf(binaryStl(TRIS))).rejects.toThrow(/not a 3MF/);
  });
});

// A real STL: the test bracket's own tessellation written as binary STL (our own models only),
// copied side by side to about the size of a printed part's STL (~90k triangles) for the speed check.
describe('STL of the test bracket', () => {
  it('reads it quickly, every triangle in place', async () => {
    const k = await OcctKernel.init();
    const dir = new URL('../test-data/revisions/', import.meta.url);
    const step = importStep(k, readFileSync(new URL('base.step', dir), 'utf8'));
    const n = step.triangleFace.length;
    const copies = Math.ceil(90_000 / n);
    const tris: number[][] = [];
    for (let c = 0; c < copies; c++)
      for (let t = 0; t < n; t++)
        tris.push(
          [0, 1, 2].flatMap((v) => {
            const i = step.indices[t * 3 + v] ?? 0;
            return [
              (step.positions[i * 3] ?? 0) + c * 200,
              step.positions[i * 3 + 1] ?? 0,
              step.positions[i * 3 + 2] ?? 0,
            ];
          }),
        );
    const t0 = performance.now();
    const m = await importMesh(binaryStl(tris), 'stl', 'bracket');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(m.triangleFace.length).toBe(copies * n);
    expect(m.bodyNames).toEqual(['bracket']);
    expect(m.positions[5]).toBeCloseTo(tris[0]?.[5] ?? NaN, 4);
  }, 60_000);

  it('reads the committed bracket.stl (hand checks use it)', async () => {
    const data = readFileSync(new URL('../test-data/bracket.stl', import.meta.url));
    const m = await importMesh(
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength),
      'stl',
    );
    expect(m.triangleFace.length).toBeGreaterThan(100);
    expect(m.meshFormat).toBe('stl');
  });
});
