# Annotation file format (`.thirdwheel.json`), schema version 1

> **Older files.** Since schema version 2 the app keeps a **project folder** `.thirdwheel/` instead
> (see [file-format.md](file-format.md)). It reads these sidecars only to move them into a project, and
> leaves them as they are, so an older app still opens them. The v2 marks files reuse the marker shapes
> described here (`entities`, `paint`, `transfer`, fingerprints).

Third Wheel never changes the model file. Everything the user adds — markers (paint and held CAD
entities), comments, body-list folders — is saved in a **sidecar** JSON file next to the model.
The source of truth is the zod schema in `packages/core/src/schema.ts`; this page explains it.
The example below is checked against that schema by `packages/core/src/file-format.test.ts`.

AI agents don't need this file: they get annotations over MCP.

## File names

| File                                                        | When                                                                                                                      |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `<model file name>.thirdwheel.json`                         | The sidecar, e.g. `bracket.step` → `bracket.step.thirdwheel.json`. Same folder as the model.                              |
| `<model file name>.thirdwheel.<yyyy-mm-dd-hhmmss>.bak.json` | Backup of a sidecar that can't be used (see _Loading_). Local time. If the name exists: `….bak-2.json`, `….bak-3.json`, … |

## When the app writes it

- **Nothing is written until the first change** (opening a model and looking at it creates no file).
- After a change: auto-save 1 s after the last change, on closing the window, on opening another model,
  and on Cmd/Ctrl+S.
- Written atomically (temp file `….tmp` next to it, then renamed over the old file).
- Readable JSON (`formatJson` in core): 2-space indent, but anything that fits in 100 characters stays on one line (an entity, a run list) and `samples` wrap about 10 numbers per line. About 1.7× the size of one-line JSON. Key order is not significant; readers must not rely on the layout.

## Top level

```jsonc
{
  "schemaVersion": 1,          // integer; this spec describes 1
  "model": { … },              // which file the annotations belong to
  "tessellation": { … },       // required for STEP
  "markers": [ … ],
  "comments": [ … ],
  "bodyTree": { … },           // optional, left out when empty
  "bodies": [ … ],             // optional: body fingerprints (written by newer app versions)
  "versions": { … }            // optional: version chain
}
```

### `model`

| Field         | Type                           | Meaning                                                                                                                                                                                                                                              |
| ------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fileName`    | string                         | Model file name only, no folder (`/` or `\` is refused).                                                                                                                                                                                             |
| `format`      | `"step"` \| `"stl"` \| `"3mf"` | Model format. `stl` / `3mf` = mesh-only mode: no `tessellation`, one face per body (faceId = body index), triangle ids in file order (3MF: build items in order), no entities in markers.                                                            |
| `contentHash` | `"sha256:<64 lower-case hex>"` | SHA-256 of the model file's bytes.                                                                                                                                                                                                                   |
| `meshHash`    | `"sha256:<64 lower-case hex>"` | Optional. SHA-256 of our mesh + entity maps (geometry `meshHash`: triangles, face / edge / vertex → body, mesh settings; not body names). Same value on a changed file = same geometry, the annotations fit as they are. A malformed one is dropped. |

### `tessellation`

The mesh settings the triangle numbers below refer to (our own tessellation of the STEP, not the
STEP's). Required when `format` is `step`.

| Field               | Type       | Meaning                                              |
| ------------------- | ---------- | ---------------------------------------------------- |
| `linearDeflection`  | number > 0 | Max chord deviation in mm. App default `0.1`.        |
| `angularDeflection` | number > 0 | Max angular deviation in radians. App default `0.5`. |

### Ids used below

- **faceId, edge/vertex/body id** — index in OpenCascade's topology traversal of the STEP
  (`docs/adr/001-step-kernel.md`), starting at 0. Stable for the same file and kernel; never an OCCT hash.
- **Triangle number** — index into the whole tessellated model (all bodies), starting at 0.
  Triangles are numbered face by face, so a painted area is usually a few long runs.
- **Marker, comment, folder ids** — strings of 1–64 characters, unique within their list. The app
  writes `m1…`, `c1…`, `n1…`; any string is accepted.

## `markers[]`

A marker is a named, coloured group of paint and/or exact CAD entities. Comments point at markers.

| Field      | Type                    | Meaning                                                              |
| ---------- | ----------------------- | -------------------------------------------------------------------- |
| `id`       | string                  | Unique marker id.                                                    |
| `name`     | string, 1–60 chars      | Shown in the Markers panel.                                          |
| `color`    | `"#rrggbb"`, lower case | Marker colour.                                                       |
| `visible`  | boolean                 | Eye toggle in the Markers panel. Hidden markers' paint is locked.    |
| `entities` | array                   | Exact B-rep entities the marker holds, in the order they were added. |
| `paint`    | object                  | Painted surface, see below.                                          |
| `transfer` | object (optional)       | How it came over from the previous model version, see below.         |

The active marker (the one Brush paints with) is **not saved**; after loading, the first marker is active.

### `transfer`

Set by the app on a marker it moved from the previous version of the model but did not find where
it was; removed when the user clicks "Looks right". A malformed one is dropped (the marker stays).

| Field    | Type                                 | Meaning                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` | `"changed"` \| `"lost"` \| `"check"` | Moved or resized / nothing matched (it holds nothing) / its body is mirrored, not moved.                                                                                                                                                                                                                                                                              |
| `from`   | string                               | File name of the previous version.                                                                                                                                                                                                                                                                                                                                    |
| `ghost`  | object (optional)                    | The parts that could not be placed, where they would be on this model (moved with their body): `faces` (`samples`, `clear`, `fingerprint` per painted face) and `entities` (fingerprints with `kind`; `body` = index into this file's `bodies`). Tried again on every new version; one that is found again comes back flagged `changed`. The app draws it as a ghost. |

### `entities[]`

| Field         | Type                                           | Meaning                                                                                                                                                           |
| ------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`        | `"vertex"` \| `"edge"` \| `"face"` \| `"body"` | Entity type.                                                                                                                                                      |
| `id`          | integer ≥ 0                                    | Traversal index of that kind.                                                                                                                                     |
| `seq`         | integer ≥ 0                                    | Grows with every add, across all markers. When an entity is in several visible markers, the highest `seq` decides its colour (unless the active marker holds it). |
| `fingerprint` | object, optional                               | What the entity looked like when saved (see below). Not needed to load.                                                                                           |

The same `kind` + `id` may appear only once per marker, but may be in several markers.

**`fingerprint`** lets a new revision of the model find the entity again by geometry:
ids change between revisions, type, size and position mostly don't. All fields are optional and
only those that apply are written; numbers are rounded to 4 decimals (mm, degrees).

| Field       | Meaning                                                                                                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `body`      | Index into `bodies` (this file's body fingerprints).                                                               |
| `type`      | Surface / curve type: `plane`, `cylinder`, `cone`, `sphere`, `torus`, `line`, `circle`, …                          |
| `point`     | Vertex: position. Face: area-weighted centre of its mesh. Edge: midpoint along it. Body: bbox centre.              |
| `length`    | Edge length.                                                                                                       |
| `area`      | Face / body mesh area (mm²).                                                                                       |
| `radius`    | Circle, cylinder, sphere radius; torus major radius. `minorRadius`: torus tube radius.                             |
| `dir`       | Plane normal, line direction, or axis (circle, cylinder, cone, torus); unit vector.                                |
| `halfAngle` | Cone half-angle.                                                                                                   |
| `form`      | Cylinder / cone `hole` or `shaft`; sphere `hollow` or `ball`.                                                      |
| `size`      | Body: bounding-box size.                                                                                           |
| `bounds`    | Face: bounding box of its mesh, `[[min x, y, z], [max x, y, z]]` (tells turns apart that fit a mark equally well). |

A malformed `fingerprint` is dropped (listed in the "dropped fields" pop-up), the entity is kept.

### `paint`

| Field     | Type                | Meaning                                                                                                                                                      |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `faces`   | array               | Paint per CAD face, one entry per `faceId` (sorted by `faceId` when written).                                                                                |
| `samples` | number[] (optional) | Older files only (now per face, below): painted triangles' centres as flat `x, y, z, …`. Still read: the revision transfer falls back to it for older files. |

Each `faces[]` entry:

| Field         | Type                | Meaning                                                                                                                                                                                                                                                                                                                      |
| ------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `faceId`      | integer ≥ 0         | CAD face the triangles lie on.                                                                                                                                                                                                                                                                                               |
| `triangles`   | `[first, count][]`  | Wholly painted triangles as **runs**: `[120, 3]` = triangles 120, 121, 122. Not overlapping (refused otherwise); the app writes them ascending. `count` ≥ 1.                                                                                                                                                                 |
| `pieces`      | array (optional)    | Triangles the brush painted only partly.                                                                                                                                                                                                                                                                                     |
| `samples`     | number[] (optional) | Points spread evenly over this face's paint, flat `x, y, z, …` in mm, rounded to 1 µm. At most 2000 per marker (every painted face keeps at least one). Used to move paint onto a changed model. A malformed list is dropped.                                                                                                |
| `clear`       | number[] (optional) | Points on this face just outside the paint (unpainted pieces of cut triangles, unpainted triangles touching the paint, within 2 spacings of a painted point), same format. On a new version each spot takes the state of its nearest point, so a brush stroke keeps its outline instead of growing. At most 2000 per marker. |
| `fingerprint` | object (optional)   | What the painted CAD face looked like, same fields as an entity `fingerprint`.                                                                                                                                                                                                                                               |

Each `pieces[]` entry is `{ "triangle": <number>, "tree": [a, b, c, d] }`. A triangle is cut into
4 children by its edge midpoints (`ab`, `bc`, `ca`), in this order:

| Child      | Corners    |
| ---------- | ---------- |
| 0          | a, ab, ca  |
| 1          | ab, b, bc  |
| 2          | ca, bc, c  |
| 3 (middle) | ab, bc, ca |

`a, b, c` are the triangle's corners in mesh order. Each child is `1` (painted by this marker), `0` (not)
or again 4 children. The root always has 4 children.

Rules (the file is refused if they are broken):

- A whole triangle belongs to **one** marker only, and a whole triangle is never also cut.
- A cut triangle may appear in several markers (each marker stores its own pieces); a triangle appears
  at most once in one marker's pieces. Overlapping `1`s of different markers are not checked.
- A `faceId` appears at most once per marker.

## `comments[]`

| Field                    | Type                                      | Meaning                                                                                                                                                                             |
| ------------------------ | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                     | string                                    | Unique comment id.                                                                                                                                                                  |
| `text`                   | string, 1–10 000 chars                    | The remark.                                                                                                                                                                         |
| `markerIds`              | string[]                                  | Markers this comment is about; empty = a general remark. Each id once; every id must exist in `markers`. One marker may serve several comments.                                     |
| `status`                 | `"open"` \| `"resolved"` \| `"wontfix"`   |                                                                                                                                                                                     |
| `author`                 | `"human"` \| `"ai"`                       |                                                                                                                                                                                     |
| `createdAt`, `updatedAt` | ISO 8601 date-time with offset            | e.g. `2026-11-08T10:00:00.000Z`.                                                                                                                                                    |
| `note`                   | string ≤ 10 000 chars (optional)          | Older files only: the AI's note on the last status change. Still read (shown as the thread's first AI reply, status = the comment's unless open); never written.                    |
| `replies`                | reply[] ≤ 500 (optional)                  | The thread under the comment, oldest first. Left out when empty. See below.                                                                                                         |
| `linkedModels`           | string[] ≤ 8, each ≤ 255 chars (optional) | Other model files this comment is about, by file name (e.g. "this pocket must fit the lid"). Names, not paths. Left out when empty; repeats dropped on load.                        |
| `awaitingConfirm`        | `true` (optional)                         | The AI set it to resolved / won't fix and the user hasn't confirmed yet: the comment stays listed with Confirm / Reopen. Only on closed comments; left out otherwise.               |
| `parts`                  | part[] ≤ 50 (optional)                    | Parts the user asks the AI to add (a part request). Left out when empty. A malformed list is dropped on load; the comment stays. See `parts[]` in [file-format.md](file-format.md). |

Each reply: `id` (unique within the comment, `r1`, `r2`, …), `text` (1–10 000 chars), `author`
(`"human"` \| `"ai"`), `createdAt`, `updatedAt` (differs once edited), `status?` — the status the comment
was set to with this reply (the AI's `set_comment_status` note → `resolved` / `wontfix` / `open`; a
user's reply on a closed comment reopens it → `open`).

The app writes only ids of existing markers (a deleted marker's id is kept in memory for undo, but
not saved). Checking `markerIds` is the schema's job; the app does not re-check them on load.

## `bodyTree` (optional)

The user's own folders in the body list, and bodies / STEP assemblies moved away from where the
STEP puts them. It only sorts the list; the model is never changed. Rows not listed stay in their
STEP place. Left out while there are no folders and nothing was moved.

```jsonc
{
  "folders": [{ "id": "n1", "name": "Fasteners", "parent": "top" }],
  "bodies": [{ "body": 3, "parent": { "folder": "n1" } }],
  "assemblies": [{ "assembly": 0, "parent": "top" }],
}
```

- A **place** (`parent`) is `"top"` (top level), `{ "assembly": <index> }` (a STEP assembly, index into
  the model's assemblies) or `{ "folder": "<folder id>" }`.
- `folders[]`: `id`, `name` (1–60 chars), `parent`. Folders may hold folders.
- `bodies[]` / `assemblies[]`: only rows the user moved.
- Entries that don't fit the model (unknown or duplicate folder id, index out of range, a folder inside itself) are
  **dropped (a misplaced folder: moved to the top level) and counted** by the app, not refused. A malformed `bodyTree` is dropped as a whole (not counted) — the
  rest of the file still loads.

## `bodies` (optional)

One fingerprint per body of the model, by body index (all bodies, not only annotated ones), so
bodies — and what refers to them: entity fingerprints, `bodyTree` — can be matched by name, then
size, after the STEP changes. Written on every save; not needed to load. Mesh numbers
in mm, rounded to 4 decimals; about 175 bytes per body.

```jsonc
[
  {
    "name": "M3 screw [2]",
    "path": "Assembly › Screws",
    "size": [3, 3, 10],
    "centre": [5, 0, 5],
    "area": 141.4,
  },
]
```

- `name`: display name from the STEP (`Body N` when the STEP has none); up to 1000 chars.
- `path`: enclosing assemblies, outermost first, joined with `›`; left out at the top level.
- `size`, `centre`: bounding box; `area`: surface area.
- A malformed list is dropped as a whole (listed in the pop-up); the rest of the file loads.

## `versions` (optional)

The model's version chain: other files that are versions of it. Made only when the user or the AI
says so — **Import new version…**, **Bring my notes over** (asked on open), `load_model` with
`revisionOf` — or when the file is overwritten in place (Reload with changes). Never from file
names. Left out while empty.

```jsonc
{
  "earlier": [
    // [0] = the version this one was made from (the truth); then a cache of what that one came from
    {
      "path": "/Users/me/cad/part v10.step",
      "name": "part v10.step",
      "contentHash": "sha256:…",
      "date": "2026-11-09T14:02:00.000Z",
    },
    {
      "path": "/Users/me/cad/part v10.step",
      "name": "part v10.step",
      "contentHash": "sha256:…",
      "date": "2026-11-09T13:40:00.000Z",
      "overwritten": true,
    },
  ],
  "newer": [
    // versions made from this one (signposts), newest first
    {
      "path": "/Users/me/cad/toy_demo.step",
      "name": "toy_demo.step",
      "contentHash": "sha256:…",
      "date": "…",
    },
  ],
}
```

- `path`: absolute path where the file was when linked (a moved file shows "not found" in Versions ▾;
  **Locate…** takes a file only when its `contentHash` matches, then saves the new path). Up to 4096 chars.
- `contentHash`: `sha256:<hex>` of the version meant (the bytes, as `model.contentHash`).
- `date`: when the link was made. `overwritten: true`: a newer version was saved over this path, so
  these contents are gone from disk (shown greyed, "earlier contents of X").
- Each list ≤ 100 links (oldest dropped); a file + contents pair is listed once.
- On Import the app adds the new file to the **earlier file's** `newer` list. `versions` is the only
  field it ever writes into another version's notes (markers, comments, unknown fields untouched). An
  earlier file without notes gets a notes file with no markers, holding just that line.
- A malformed `versions` is dropped (the chain is lost), never the file.

**Rules of the chain — like a linked list spread over files.** Keep to these in later changes:

- **`earlier[0]` is the truth**: the one version this file was made from (its parent). The rest of
  `earlier` is only a cache, used where a version's notes can't be read (moved, overwritten). Versions ▾
  walks parent by parent: each readable version's own `earlier` takes over.
- **One parent per file.** Linking a file that already names another parent asks the user which is
  right (the AI's `revisionOf` moves it and says so in `warning`). Several **newer** versions are fine
  (variants): the chain is a tree.
- **`newer` entries are signposts**, trusted only when that file's `earlier[0]` names this one (or
  earlier contents of this path it replaced); a stale one is ignored.
- **No circles**: a file that is already an earlier version of X is never linked as newer than X.
- Every walk remembers what it visited and stops after 100 versions (10 levels of newer), so a broken
  chain on disk can't hang the app.
- **Remove from versions** (Versions ▾, after a confirm; no Undo): the removed version's newer files get
  its parent as theirs, the parent gets them as newer, and the removed file's own `versions` becomes
  `{ "unlinked": "<date>" }`. Written in that order (the parent side decides), so a crash or a file that
  can't be written loses at most that one link, never a notes file. `unlinked`: the automatic guesses
  (the "newer version?" question, the same-size mesh question, the `load_model` hint) leave the file out; linking it again
  (Import, Bring my notes over, `revisionOf`) clears it. A walk also skips a version marked `unlinked`.
  A newer file the removal can't reach (behind a version whose notes can't be read) keeps naming the
  removed one; removing it again from that file's Versions ▾ fixes it.
  The app changes the chain of another file's notes only when those notes exist and belong to the linked
  contents (`model.contentHash`), and only for files opened or found through a version chain; no notes file is created this way.

## Loading

1. **Not JSON, no `schemaVersion`, schema errors, `model.format` not `step`, or the file can't be read
   (permissions, larger than 256 MB)** → the sidecar is "unreadable".
2. **`schemaVersion` higher than 1** → refused with "made by a newer version of Third Wheel — please
   update the app" (handled like unreadable).
3. **Other model version**: `contentHash` differs from the model file, or `tessellation` differs from
   the app's settings → "other-version".
4. Other-version with the **same `meshHash`** as the new file (a re-export that only changed
   the file's header or ids): the annotations load as they are and are saved at once with the new
   `contentHash` (no backup: nothing is lost). Without `meshHash` (older files) only the model still
   in memory in this session can show the geometry is the same.
5. Other-version with changed geometry: the sidecar is renamed to a `.bak.json` backup and
   its markers are **moved onto the new geometry** (geometry `transferAnnotations`: bodies by name /
   size, entities by fingerprint, paint by face `samples`), then saved at once; a notice gives the
   counts. Markers not found where they were get a `transfer` entry. If the rename fails, the first
   save keeps a backup copy instead. If moving fails, the model opens empty (pop-up).
   **From a mesh file:** a STEP opened as the next version of an STL / 3MF (Import new
   version…, "Bring my notes over", `revisionOf`) takes that mesh's notes (geometry
   `transferMeshAnnotations`). The mesh is lined up with the STEP as a whole: the 24 turns in 90°
   steps whose box fits (sorted sides within 10 %), scored by mesh points (≤ 1500 triangle centres;
   paint points when the mesh file is gone) within the tolerance of the STEP surface, a mirror only
   when it fits ≥ 2 % of the points better (→ every marker `check`), then up to 4 mean-offset nudges.
   **Tolerance** = max(0.5 mm, 1 % of the STEP model's largest bbox side) (the "found"
   distance). Each painted `samples` point goes to the nearest STEP triangle within the "changed"
   distance (max(5 mm, 5 %)), on any face; the paint is rebuilt on the faces that took points, `clear`
   points mark where it ends (only those whose nearest face took paint). Marker: `found` when ≥ 80 %
   of its points are within the tolerance, `changed` when ≥ 50 % land, else `lost` (ghost at the
   lined-up place). Coverage report (notice, `LoadResult.revision.transfer.fromMesh`): points,
   matched, mesh surface share on the STEP, tolerance. The mesh's notes stay; the STEP's notes
   start a new file (`bodyTree` dropped, the STEP's `bodies`), both linked in `versions`. Limit:
   one transform per file — parts moved apart on a slicer plate are not lined up one by one.
   Unreadable: renamed to `.bak.json`, pop-up, the model opens with no annotations.
6. Otherwise the annotations load. Paint triangles that are not on their `faceId` or past the end of
   the mesh, and entity ids out of range, are **dropped and counted**; the notice bar says how many.

**Unknown keys are dropped on read.** A newer v1 writer may add optional fields; this app reads the
file without them, and the next save writes the file without them (they are lost). The app shows a pop-up
listing them when the file is loaded.

**Backup before losing data.** When a load dropped anything (unknown fields, or items that didn't fit
the model), the first save afterwards first **copies** the old file to a `.bak.json` backup (same
names as above), then writes. If the copy fails, nothing is overwritten. Later saves make no more
copies; a load that dropped nothing makes none. Breaking
changes raise `schemaVersion`.

## Example

A STEP part with two bodies, two markers (one with paint and a held edge, one holding a face) and
two comments (one resolved by the AI), and one user folder.

```json
{
  "schemaVersion": 1,
  "model": {
    "fileName": "bracket.step",
    "format": "step",
    "contentHash": "sha256:9f2c5e0b7a1d4c3e8b6a5f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0"
  },
  "tessellation": { "linearDeflection": 0.1, "angularDeflection": 0.5 },
  "markers": [
    {
      "id": "m1",
      "name": "Marker 1",
      "color": "#e8590c",
      "visible": true,
      "entities": [
        {
          "kind": "edge",
          "id": 14,
          "seq": 0,
          "fingerprint": {
            "body": 0,
            "type": "line",
            "point": [20, 0, 5],
            "length": 40,
            "dir": [1, 0, 0]
          }
        }
      ],
      "paint": {
        "faces": [
          {
            "faceId": 2,
            "triangles": [
              [120, 3],
              [130, 1]
            ],
            "pieces": [{ "triangle": 124, "tree": [1, 0, [1, 1, 0, 0], 0] }],
            "samples": [12.5, 4, 3.25, 13.1, 4.002, 3.25, 12.871, 5.5, 3.25],
            "fingerprint": {
              "body": 0,
              "type": "plane",
              "point": [13, 4.5, 3.25],
              "area": 96,
              "dir": [0, 0, 1]
            }
          }
        ]
      }
    },
    {
      "id": "m2",
      "name": "Hole",
      "color": "#1971c2",
      "visible": false,
      "entities": [
        {
          "kind": "face",
          "id": 7,
          "seq": 1,
          "fingerprint": {
            "body": 0,
            "type": "cylinder",
            "point": [10, 10, 5],
            "area": 113.0973,
            "radius": 1.8,
            "dir": [0, 0, 1],
            "form": "hole"
          }
        }
      ],
      "paint": { "faces": [] }
    }
  ],
  "comments": [
    {
      "id": "c1",
      "text": "Wall too thin here — make it 2 mm.",
      "markerIds": ["m1"],
      "status": "open",
      "author": "human",
      "createdAt": "2026-11-08T10:00:00.000Z",
      "updatedAt": "2026-11-08T10:00:00.000Z"
    },
    {
      "id": "c2",
      "text": "Hole should be M4 clearance.",
      "markerIds": ["m2"],
      "status": "resolved",
      "author": "human",
      "createdAt": "2026-11-08T10:01:00.000Z",
      "updatedAt": "2026-11-08T10:20:00.000+01:00",
      "replies": [
        {
          "id": "r1",
          "text": "Diameter changed to 4.5 mm.",
          "author": "ai",
          "createdAt": "2026-11-08T10:20:00.000+01:00",
          "updatedAt": "2026-11-08T10:20:00.000+01:00",
          "status": "resolved"
        }
      ]
    }
  ],
  "bodyTree": {
    "folders": [{ "id": "n1", "name": "Fasteners", "parent": "top" }],
    "bodies": [{ "body": 1, "parent": { "folder": "n1" } }],
    "assemblies": []
  },
  "bodies": [
    { "name": "Bracket", "size": [40, 40, 10], "centre": [20, 20, 5], "area": 4103.5 },
    {
      "name": "M4 screw",
      "path": "Fasteners",
      "size": [4, 4, 12],
      "centre": [10, 10, 4],
      "area": 160.2
    }
  ]
}
```
