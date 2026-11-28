// Writes the revision test set: one generated part plus before/after STEP pairs and an
// answer key, for annotation transfer.
//   node packages/geometry/scripts/make-revision-set.js [outDir]
// Output (committed, same files every run): base.step, one <pair>.step per pair, revisions.json.
//
// The part: "Bracket" (an L: 80 × 40 × 6 plate + 5 mm wall 30 tall at x = 0, a Ø14 boss at
// (60, 20) on top, Ø6 holes at (30, 12) — off-centre, so a mirror is not a turn — and through the boss) and a separate "Pin" (Ø6 × 20 at
// (130, 20)). Markers are defined by geometry ("the cylinder face at x y z"), never by id: ids
// change between revisions. revisions.json says, per pair, what the annotation transfer should report for each
// marker and where its paint / entities should end up.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OcctKernel } from 'occt-wasm';

const out = process.argv[2] ?? join('packages', 'geometry', 'test-data', 'revisions');
mkdirSync(out, { recursive: true });
const k = await OcctKernel.init();

const BASE = Object.freeze({
  length: 80, // plate along x
  wall: 5, // wall thickness (x)
  hole1R: 3, // hole at (30, 12); 0 = no hole
  endFillet: 0, // radius on the plate's top end edge (x = length, z = 6); 0 = sharp
  rib: false, // 20 × 4 × 14 rib at y = 30…34 between wall and plate
});

/** The Bracket solid for parameters `p` (base values where left out). */
function bracket(over = {}) {
  const p = { ...BASE, ...over };
  let s = k.makeBox(p.length, 40, 6);
  s = k.fuse(s, k.makeBox(p.wall, 40, 30));
  s = k.fuse(s, k.translate(k.makeCylinder(7, 4), 60, 20, 6));
  if (p.rib) s = k.fuse(s, k.translate(k.makeBox(20, 4, 14), p.wall, 30, 6));
  if (p.hole1R > 0) s = k.cut(s, k.translate(k.makeCylinder(p.hole1R, 40), 30, 12, -5));
  s = k.cut(s, k.translate(k.makeCylinder(3, 40), 60, 20, -5));
  const solids = k.getSubShapes(k.unifySameDomain(s), 'solid');
  if (solids.length !== 1) throw new Error(`bracket: ${solids.length} solids`);
  s = solids[0];
  if (p.endFillet > 0) {
    const edge = k.getSubShapes(s, 'edge').filter((e) => {
      const b = k.getBoundingBox(e);
      return near(b.xmin, p.length) && near(b.xmax, p.length) && near(b.zmin, 6) && near(b.zmax, 6);
    });
    if (edge.length !== 1) throw new Error(`end edge: found ${edge.length}`);
    s = k.fillet(s, edge, p.endFillet);
  }
  return s;
}

const near = (a, b) => Math.abs(a - b) < 1e-6;
const pin = () => k.translate(k.makeCylinder(3, 20), 130, 20, 0);

/** A STEP file with named bodies (in this order), like a CAD export. */
function stepOf(bodies) {
  const doc = k.createXCAFDocument();
  const root = doc.addShape(k.makeCompound([]), { assembly: true, name: 'Revision test' });
  for (const [name, shape] of bodies) doc.addChild(root, shape, { name });
  const step = doc.exportSTEP();
  doc.close();
  // OCCT writes the time into the header; fix it so the files only change when the geometry does.
  return step.replace(/FILE_NAME\('([^']*)','[^']*'/, "FILE_NAME('$1','2026-11-09T00:00:00'");
}

// --- Markers on the base model -------------------------------------------------------------
// Locator: kind, body name, OCCT type, and a point on the entity (well away from other entities
// of the same kind and type). Paint markers paint whole faces.
const loc = (kind, type, at, body = 'Bracket') => ({ kind, body, type, at });
const L = {
  top: loc('face', 'plane', [45, 10, 6]),
  end: loc('face', 'plane', [80, 20, 3]),
  wallOut: loc('face', 'plane', [0, 20, 18]),
  wallIn: loc('face', 'plane', [5, 20, 18]),
  hole1: loc('face', 'cylinder', [27, 12, 3]),
  boss: loc('face', 'cylinder', [67, 20, 8]),
  endEdge: loc('edge', 'line', [80, 20, 6]),
  pin: loc('face', 'cylinder', [133, 20, 10], 'Pin'),
};
const markers = [
  { id: 'm_top', name: 'Plate top (paint)', paint: [L.top], entities: [] },
  { id: 'm_end', name: 'End face (paint)', paint: [L.end], entities: [] },
  { id: 'm_wall_out', name: 'Wall outside (paint)', paint: [L.wallOut], entities: [] },
  { id: 'm_wall_in', name: 'Wall inside (paint)', paint: [L.wallIn], entities: [] },
  { id: 'm_hole', name: 'Hole Ø6 (face)', paint: [], entities: [L.hole1] },
  { id: 'm_boss', name: 'Boss Ø14 (face)', paint: [], entities: [L.boss] },
  { id: 'm_end_edge', name: 'End top edge (edge)', paint: [], entities: [L.endEdge] },
  { id: 'm_pin', name: 'Pin (face, other body)', paint: [], entities: [L.pin] },
];

// --- Expectations ----------------------------------------------------------------------------
// status: found (same place, within "found" tolerance) | changed (found but moved / resized:
// flagged for the user) | lost (gone: kept as a ghost) | check (needs the user: mirrored body).
// An array = any of these is right. paintOn / entities = locators in the AFTER model.
const xf = (f) => (l) => ({ ...l, at: f(l.at) });
/** Every marker found at its locators moved by `f` (Bracket only; the Pin never moves). */
function allFound(f = (p) => p, body = 'Bracket') {
  const move = (l) => (l.body === 'Bracket' ? { ...xf(f)(l), body } : l);
  return Object.fromEntries(
    markers.map((m) => [
      m.id,
      {
        status: 'found',
        ...(m.paint.length ? { paintOn: m.paint.map(move) } : {}),
        ...(m.entities.length ? { entities: m.entities.map(move) } : {}),
      },
    ]),
  );
}
const at = (l, p) => ({ ...l, at: p });

const pairs = [
  {
    id: '00-unchanged',
    title: 'Same part exported again (control: ids stay the same)',
    bodies: [
      ['Bracket', bracket()],
      ['Pin', pin()],
    ],
    expect: allFound(),
  },
  {
    id: '01-fillet',
    title: 'R3 fillet on the top end edge',
    bodies: [
      ['Bracket', bracket({ endFillet: 3 })],
      ['Pin', pin()],
    ],
    expect: {
      ...allFound(),
      m_end: {
        status: ['found', 'changed'],
        paintOn: [at(L.end, [80, 20, 1.5]), loc('face', 'cylinder', [79.1213, 20, 5.1213])],
      },
      m_end_edge: { status: 'lost' },
    },
  },
  {
    id: '02-hole-bigger',
    title: 'Hole at (30, 12) Ø6 → Ø8',
    bodies: [
      ['Bracket', bracket({ hole1R: 4 })],
      ['Pin', pin()],
    ],
    expect: { ...allFound(), m_hole: { status: 'changed', entities: [at(L.hole1, [26, 12, 3])] } },
  },
  {
    id: '03-thicker-wall',
    title: 'Wall 5 → 8 mm thick (inside face moves 3 mm)',
    bodies: [
      ['Bracket', bracket({ wall: 8 })],
      ['Pin', pin()],
    ],
    expect: {
      ...allFound(),
      m_wall_in: { status: 'changed', paintOn: [at(L.wallIn, [8, 20, 18])] },
    },
  },
  {
    id: '04-longer',
    title: 'Plate 80 → 100 mm long (end face and edge move 20 mm)',
    bodies: [
      ['Bracket', bracket({ length: 100 })],
      ['Pin', pin()],
    ],
    expect: {
      ...allFound(),
      m_end: { status: 'changed', paintOn: [at(L.end, [100, 20, 3])] },
      m_end_edge: { status: 'changed', entities: [at(L.endEdge, [100, 20, 6])] },
    },
  },
  {
    id: '05-rib',
    title: 'Rib added between wall and plate (new faces take nothing)',
    bodies: [
      ['Bracket', bracket({ rib: true })],
      ['Pin', pin()],
    ],
    expect: allFound(),
  },
  {
    id: '06-hole-removed',
    title: 'Hole at (30, 12) removed',
    bodies: [
      ['Bracket', bracket({ hole1R: 0 })],
      ['Pin', pin()],
    ],
    expect: { ...allFound(), m_hole: { status: 'lost' } },
  },
  {
    id: '07-moved',
    // The rib changes the face numbering too, so keeping old ids can't pass: needs alignment.
    title: 'Bracket moved by (15, −10, 5) and a rib added; Pin stays',
    bodies: [
      ['Bracket', k.translate(bracket({ rib: true }), 15, -10, 5)],
      ['Pin', pin()],
    ],
    expect: allFound(([x, y, z]) => [x + 15, y - 10, z + 5]),
  },
  {
    id: '08-rotated',
    title: 'Bracket turned 90° about z through (40, 20) and a rib added; Pin stays',
    bodies: [
      // A matrix, not k.rotate: a k.rotate result hangs XCAF's STEP export (occt-wasm 5.15).
      ['Bracket', k.transform(bracket({ rib: true }), [0, -1, 0, 60, 1, 0, 0, -20, 0, 0, 1, 0])],
      ['Pin', pin()],
    ],
    expect: allFound(([x, y, z]) => [40 - (y - 20), 20 + (x - 40), z]),
  },
  {
    id: '09-mirrored',
    title: 'Bracket mirrored at x = 40 (left/right version); Pin stays',
    bodies: [
      ['Bracket', k.transform(bracket(), [-1, 0, 0, 80, 0, 1, 0, 0, 0, 0, 1, 0])],
      ['Pin', pin()],
    ],
    expect: Object.fromEntries(
      markers.map((m) => [m.id, m.id === 'm_pin' ? allFound().m_pin : { status: 'check' }]),
    ),
  },
  {
    id: '10-renamed-reordered',
    title: 'Pin written first, Bracket renamed "Bracket v2" (match by size)',
    bodies: [
      ['Pin', pin()],
      ['Bracket v2', bracket()],
    ],
    expect: allFound((p) => p, 'Bracket v2'),
  },
];

writeFileSync(
  join(out, 'base.step'),
  stepOf([
    ['Bracket', bracket()],
    ['Pin', pin()],
  ]),
);
for (const p of pairs) writeFileSync(join(out, `${p.id}.step`), stepOf(p.bodies));

const key = {
  version: 1,
  about:
    'Revision test set. Generated by packages/geometry/scripts/make-revision-set.js — edit the script, not this file.',
  base: 'base.step',
  markers,
  pairs: pairs.map((p) => ({ id: p.id, title: p.title, after: `${p.id}.step`, expect: p.expect })),
};
writeFileSync(join(out, 'revisions.json'), `${JSON.stringify(key, null, 2)}\n`);
console.log(`${out}: base + ${pairs.length} pairs, ${markers.length} markers`);
