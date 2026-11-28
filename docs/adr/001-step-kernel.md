# ADR 001 — STEP kernel

- **Status:** accepted (kernel spike, 2026-11-06)
- **Decision:** use **`occt-wasm`** (OpenCascade V8 → WASM, npm `occt-wasm`, tested at 5.15.0) as the STEP kernel.
  `occt-import-js` is rejected; `opencascade.js` and a Python OCP sidecar are not needed.

## Requirements

face→triangle ranges · edge polylines · vertices · body ids · stable ids across reloads of the same file · acceptable load
time. Later tasks also need entity info (face type, radius, edge length, vertex coords).

## Candidates

|                                 | `occt-import-js` 0.0.23 | **`occt-wasm` 5.15.0**                                                     | `opencascade.js`                            |
| ------------------------------- | ----------------------- | -------------------------------------------------------------------------- | ------------------------------------------- |
| Face → triangle ranges          | ✅ `brep_faces`         | ✅ `meshShape().faceGroups`                                                | ✅ (hand-written)                           |
| Body ids                        | ✅ one mesh per body    | ✅ `getSubShapes(…,'solid')`                                               | ✅                                          |
| Edges + polylines               | ❌                      | ✅ `wireframe({source:'triangulation'})`, points shared with the face mesh | ✅                                          |
| Vertices                        | ❌                      | ✅ `vertexPosition`                                                        | ✅                                          |
| Face / curve type, length       | ❌                      | ✅ `surfaceType`, `curveType`, `getLength`                                 | ✅                                          |
| Names / colours / assembly tree | names, colours          | ✅ XCAF (`importXCAFFromSTEP`)                                             | ✅                                          |
| API                             | JSON result             | typed TS, handles, worker wrapper                                          | raw Emscripten bindings, manual `.delete()` |
| Maintenance                     | last release 2024       | active (weekly releases, CI)                                               | 1.1.1 (2021), beta (2023)                   |
| Size (unpacked)                 | 8 MB wasm               | 21 MB wasm (~4.5 MB brotli)                                                | 67 MB                                       |
| Licence                         | LGPL-2.1 (OCCT)         | wrapper MIT/Apache, wasm LGPL-2.1 (OCCT)                                   | LGPL-2.1                                    |

`opencascade.js` was not run: `occt-wasm` already meets every requirement, and `opencascade.js` is larger, harder to use and
unmaintained. A Python sidecar would add a second runtime to install on macOS + Windows for no gain.

## Measurements

Node 22.14, Apple Silicon, one process; `linearDeflection 0.1 mm`, `angularDeflection 0.5 rad`. Script:
`packages/geometry/spike/kernel-spike.js`, removed once the choice was made (it is in the git history of v0.1.0).
Samples were third-party 3D-printer CAD files, kept locally only (not committed, since deleted).

| File                           | Size    | Bodies | Faces | Edges  | Vertices | Triangles | `occt-import-js` load | `occt-wasm` load (import + mesh + edges) |
| ------------------------------ | ------- | ------ | ----- | ------ | -------- | --------- | --------------------- | ---------------------------------------- |
| Printer part A (fillets/holes) | 1.2 MB  | 1      | 330   | 858    | 535      | 7.4 k     | 1.1 s                 | **0.6 s** (0.50 + 0.11 + 0.00)           |
| Printer part B (fillets/holes) | 2.2 MB  | 1      | 548   | 1 513  | 952      | 12.3 k    | 2.2 s                 | **0.9 s** (0.71 + 0.15 + 0.00)           |
| Printer toolhead (assembly)    | 13.1 MB | 130    | 9 342 | 25 284 | 16 403   | 182 k     | 14.6 s                | **5.3 s** (3.93 + 1.32 + 0.02)           |

- WASM init: ~40 ms. Entity queries (types/lengths/positions for all entities): 160 ms on the assembly.
  Process RSS peaks ~1 GB on the assembly for both kernels.
- `occt-wasm` consistency checks, all files: every triangle maps to exactly one face, every face to one body, every
  edge polyline to one edge; 0 face-hash collisions (edges/vertices not checked — the worker import must check or avoid joining on
  the 31-bit hash). Edges without a polyline: 4 / 5 / 27, against 4 / 5 / 26 degenerate
  edges (sphere/cone apex, curve type `other`) — nothing to draw. The one extra on the assembly is unexplained; the worker import
  should log which edge it is.
- Bodies = solid **instances**: 81 solid definitions in the file, 130 placed instances (repeated screws, etc.).

## Stable ids

OCCT's own shape hashes (`hashCode`, the `faceGroups`/`edgeGroups` hashes) are memory-based: they
**change on a reload in the same process** (and only happened to match across fresh processes) — they may only be used to join data inside one load. Our ids are the **index in OCCT's topology traversal**
(`getSubShapes(shape, 'solid' | 'face' | 'edge' | 'vertex')`). A fingerprint over per-index content (face→body, face
types, edge type + length, vertex positions, triangle→face) was identical on reload in the same process **and** in a
fresh process, for both kernels and all three files.

## Consequences

- Worker import: run `occt-wasm` in a Web Worker (its `OcctWorker` wrapper or our own); 5 s on a 13 MB assembly needs the
  progress indicator. Build `triangle→faceId`, `faceId→bodyId`, edge polylines, vertex list by mapping hashes → traversal
  index within the load; store tessellation settings (absolute deflection) in the sidecar. Bodies are solid instances;
  use XCAF for part names/colours. `occt-wasm` can also generate small STEP fixtures (`makeBox` … `exportStep`) for
  committed tests, since the sample files can't be committed.
- Requires a WASM engine with SIMD, tail calls and exceptions: fine for Electron 45 (Chromium 140) and Node 22.
- Dependency risk: single maintainer. Mitigation: pin the exact version; our code talks to it only inside
  `packages/geometry`, so swapping to `opencascade.js`/a custom OCCT build later stays local.
- LGPL-2.1: ship the `.wasm` as a separate, replaceable file (not inlined into a bundle) and include the licence text.
- `occt-import-js` was removed with the worker import (`occt-wasm` is now a runtime dependency).
- Worker import findings: `faceGroups` start/count are in **index entries** (3 per triangle), `edgeGroups` in **floats** (3 per
  point). The one unexplained edge without polyline on the assembly is a 3e-13 mm circle — zero length, i.e. degenerate.
