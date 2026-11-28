// Writes a synthetic large STEP assembly for performance checks:
//   node packages/geometry/scripts/make-large-step.js [out.step] [gridSize]
// Each part is a filleted plate with holes and a torus boss (lots of curved faces, like real
// printed parts). Default 21×21 = 441 parts ≈ 1M triangles at the default tessellation.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OcctKernel } from 'occt-wasm';

const out = process.argv[2] ?? join('test-models', 'synthetic-1M.step');
const grid = Number(process.argv[3] ?? 21);
const k = await OcctKernel.init();

function part() {
  let s = k.makeBox(40, 40, 8);
  s = k.fillet(s, k.getSubShapes(s, 'edge'), 2);
  for (const [x, y] of [
    [8, 8],
    [32, 8],
    [8, 32],
    [32, 32],
  ])
    s = k.cut(s, k.translate(k.makeCylinder(2.5, 20), x, y, -5));
  s = k.fuse(s, k.translate(k.makeTorus(10, 3), 20, 20, 8));
  return s;
}

const proto = part();
const mesh = k.tessellate(proto, { linearDeflection: 0.1, angularDeflection: 0.5 });
console.log('triangles per part:', mesh.indices.length / 3);
const parts = [];
for (let i = 0; i < grid; i++)
  for (let j = 0; j < grid; j++) parts.push(k.translate(proto, i * 50, j * 50, 0));
writeFileSync(out, k.exportStep(k.makeCompound(parts)));
console.log(
  `${out}: ${parts.length} parts, ≈${(parts.length * mesh.indices.length) / 3} triangles`,
);
