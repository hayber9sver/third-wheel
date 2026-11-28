# Project file format (`.thirdwheel/`), schema version 2

Third Wheel never changes or copies a model file. Everything the user adds (markers, comments,
body-list folders, chats) is kept in a **project**: one per folder, stored in a `.thirdwheel/` folder
inside it. Models are referenced by a path relative to the project folder and by a content hash.

- **Source of truth:** the zod schemas in `packages/core/src/project-schema.ts`; this page explains
  them. The [examples](#examples) are checked against those schemas by
  `packages/core/src/file-format.test.ts`.
- **AI agents** don't need these files: they get annotations over MCP.
- **Older apps** kept one sidecar per model (`<model>.thirdwheel.json`, schema 1, described in
  [file-format-v1.md](file-format-v1.md)). See [Moving from sidecars](#moving-from-sidecars).

## Files

```text
my-parts/                       the project folder
  bracket.step                  models: anywhere in or below it (or referenced outside, see versions)
  out/bracket_v2.step
  .thirdwheel/
    project.json                parts, versions, markers, comments, chats index
    marks/<version-id>.json     paint and held entities of one version
    chats/<chat-id>.jsonl       one chat, one entry per line (append-only)
    lock                        which app has the project open (don't commit it)
    .gitignore                  "chats/" and "lock": written when missing, never overwritten
```

- **One project per folder.** A model belongs to the nearest `.thirdwheel/` in its folder or a
  parent folder, up to the home folder or the drive root, so `out/part.step` joins the parent's project.
  Network paths (`\\host\share`) are not supported.
- **Hidden?** On macOS the leading dot hides the folder in Finder (`Cmd+Shift+.` shows it). Windows
  Explorer shows it.
- **Nothing is written until the first change.** Opening a model and looking at it creates no files.
- Paths in the files use `/` on every system. The `.thirdwheel` folder's own path must stay at or
  below 200 characters, so its files stay below the 260-character Windows limit.
- Other files in `.thirdwheel/` (a sync tool's conflict copies like `project (1).json`, files
  you added) are left alone; the app lists them in a notice.

## Writing and reading

- **Atomic saves:** each file is written to `<file>.<random>.tmp` and then renamed over the old one.
  When Windows briefly refuses the rename (antivirus, OneDrive, Explorer's preview holding the file),
  it tries again (about 50 → 500 ms) and then reports the error.
- **Saves that belong together** (a version's marks and the project) are all written to temp files
  first. If one fails, none is renamed. Marks files are renamed before `project.json`.
- **Chat:** one line appended per entry; earlier lines are never rewritten. A half-written last line
  (crash) is skipped when reading, and the next entry starts on a new line.
- **Format:** UTF-8 JSON, written with `\n` line ends. Readers accept `\r\n` (git `autocrlf`) and a
  BOM. Readable layout (2-space indent, short things on one line); key order and layout carry no
  meaning.
- **Unknown fields are kept.** A field this app doesn't know (from a newer or forked app) is read,
  kept, and written back unchanged.
- **Unreadable file** (not JSON, schema errors, larger than 256 MB, no permission): it is moved aside
  to `<name>.<yyyy-mm-dd-hhmmss>.bak.json` (local time; `….bak-2.json`, … if taken), and the app says
  so.
- **Backup before losing data:** a save that would drop something first copies the old file
  to a backup of the same name.
- **`schemaVersion` higher than 2:** refused with "made by a newer version of Third Wheel —
  please update the app". The file is never moved aside or overwritten.

## Ids

- **New ids** for parts, versions and chats: 10 random characters `a-z0-9` starting with a letter
  (e.g. `k3f9x2a1qz`). They are random, not counters, so two people adding at the same time never
  make the same id.
- **Markers and comments** made in the app get random ids of the same form, unique in the project.
  (Readers must accept any id form: ones moved in from v1 files keep theirs, e.g. `m12`, `c7`.)
- **Version and chat ids become file names**, so they must be 1–32 characters `a-z0-9` and never a
  Windows device name (`con`, `nul`, `com1`, …).
- Marker, comment, reply and folder ids from older files keep their v1 form (any 1–64 characters).
- **Entity ids and triangle numbers** are as in v1: OpenCascade traversal indices of the version's
  STEP, and triangles of our own tessellation numbered face by face.

## `project.json`

| Field           | Type             | Meaning                                                                                                            |
| --------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| `schemaVersion` | `2`              |                                                                                                                    |
| `id`            | id               | The project's id.                                                                                                  |
| `name`          | string           | Shown name; default: the folder name.                                                                              |
| `created`       | ISO time         |                                                                                                                    |
| `tessellation`  | object, optional | Mesh settings for STEP (`linearDeflection` mm, `angularDeflection` rad), as in v1.                                 |
| `models`        | array            | **Parts**, each with its version list.                                                                             |
| `markers`       | array            | Each marker's `id`, `name` (1–60, unique in the project, case ignored), `color` (`#rrggbb` lower case), `visible`. |
| `comments`      | array            | Comments with their threads, once per project.                                                                     |
| `chats`         | array            | Chats index: `id`, `title` (the first message), `created`, `last`, `entries`, `summary?`.                          |
| `sidecars`      | array, optional  | v1 sidecars already moved in (`path`, `contentHash`, `at`): each is merged only once.                              |

### `models[]` (parts)

`{ id, name, versions[], bodyTree? }`. A part is one model and its versions; two models in a
folder are two parts of one project.

#### `versions[]`

One entry per version, oldest first.

| Field         | Type                           | Meaning                                                                                                                                 |
| ------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `id`          | file id                        | Names the marks file `marks/<id>.json`. Unique in the whole project.                                                                    |
| `path`        | string                         | Relative to the project folder, `/` between parts, `..` allowed (`../exports/part.step`). Never `\`, never absolute (except `outside`). |
| `outside`     | `true`, optional               | The file has no relative path (another drive on Windows): `path` is absolute as the system wrote it. Not carried when the folder moves. |
| `contentHash` | `"sha256:<64 hex>"`            | SHA-256 of the file's bytes. "Is this file already a version?" compares this first, then the real path.                                 |
| `meshHash`    | `"sha256:<64 hex>"`, optional  | As in v1: same value = same geometry.                                                                                                   |
| `format`      | `"step"` \| `"stl"` \| `"3mf"` | Mesh files are mesh-only mode (paint and comments only).                                                                                |
| `added`       | ISO time                       | When it became a version.                                                                                                               |
| `from`        | version id, optional           | The version it was made from (same part). Several versions may share one `from` (variants); circles are refused.                        |
| `overwritten` | `true`, optional               | Written by early test builds only: these contents are gone from disk. A file saved over keeps its version (new `contentHash`).          |
| `unlinked`    | ISO time, optional             | The user removed it from its versions (Remove from versions…): it is left out of "is this a new version?" guesses until linked again.   |

A missing file shows as "not found"; **Locate…** takes a file only when its content hash matches.

#### `bodyTree` (optional)

The user's folders in the body list, as in v1 but with bodies **by name**, so they survive a new
version.

- `bodies: [{ body: { name, path?, index? }, parent }]`, where `path` = enclosing assemblies (as v1
  `bodies[].path`) and `index` = the fallback when names repeat or are empty.
- `folders` and `assemblies` are as in v1.
- A malformed `bodyTree` is dropped, never the project.

### `comments[]`

As v1 comments (`id`, `text`, `markerIds`, `status` `open` / `resolved` / `wontfix`, `author`
`human` / `ai`, `createdAt`, `updatedAt`, `replies?`, `linkedModels?`, `awaitingConfirm?`, `parts?`
(part requests, below), the old `note?`), plus:

| Field         | Type            | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelId`     | part id         | The part the comment is about.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `linkedParts` | array, optional | Parts of this project the comment links to (from `linkedModels` names that matched a part). A name that stands for a linked part is shown as that part's newest version, so the link follows the part to new versions. A comment never links to its own part: names of its own part's versions are dropped when notes are read or saved, and when two parts become one (a file linked as a new version) the links between them go. |

#### `parts[]` (part requests)

The comment's `text` is the instruction; `parts` are the choices the user made in the Library panel. The
AI builds the geometry itself (with build123d / bd_warehouse) and exports a new model file; the app only
stores and shows the request.

Each part: `id` (unique within the comment, `p1`, `p2`, …); `source` (`{ "kind": "library", "library":
"bd_warehouse", "version"?, "cls": "SocketHeadCapScrew", "params": { … } }`; `params` holds what the user
chose from the library's standard tables (type, size) or typed (a length, a tooth count), up to 12 values;
a name left out = the AI chooses); `copies` (1–999); `scope` (`"whole"` or `{ "subparts":
[names] }`, the names the model shows without the `[n]` the app adds to repeats); `target?` (`{ "markerIds":
[…], "mode"?: "each" | "pattern", "spacing"? }`; every marker id must be among the comment's `markerIds`);
`note?` (a special requirement the standard choices cannot say, e.g. "countersunk flush"); `result?` (`{ "status": "placed" | "skipped" | "failed" |
"needs-info", "bodies"?, "note"?, "updatedAt" }`, written when the AI answers).

The app writes only ids of existing markers (a deleted marker's id is kept in memory for undo, but
not saved). Checking `markerIds` is the schema's job; the app does not re-check them on load.

In the project file a part's `target.markerIds` are project marker ids (renamed with the comment's markers when sidecars are merged). A target marker the shown version no longer lists is left out when the notes are read, like the comment's own `markerIds`.

A comment is stored **once**. Its status and thread are the same on every version. Its markers are
drawn on whichever version is shown, from that version's marks file. A marker the version has no marks
for is "not on this version".

## `marks/<version-id>.json`

One version's paint and held entities. It also records what its numbers refer to, so a changed file
or setting is caught as in v1 (other version → move the marks over with the revision transfer):

| Field           | Type                | Meaning                                                                                                                                           |
| --------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion` | `2`                 |                                                                                                                                                   |
| `versionId`     | file id             | Must match the file name; a marks file copied over another version is unreadable.                                                                 |
| `contentHash`   | `"sha256:<64 hex>"` | The file the triangle numbers were made from.                                                                                                     |
| `meshHash`      | optional            | As in v1.                                                                                                                                         |
| `tessellation`  | optional            | The mesh settings used (required for STEP in practice, as v1).                                                                                    |
| `bodies`        | array, optional     | Body fingerprints by body index, as v1 `bodies`.                                                                                                  |
| `markers`       | array               | `{ id, entities, paint, transfer? }`: `id` names a marker in `project.json`; the rest is as v1 `markers[]` (see [v1](file-format-v1.md#markers)). |

The v1 rules hold: one marker per whole triangle, a whole triangle is never also cut, and each entity
and face appears once per marker.

## `chats/<chat-id>.jsonl`

One JSON object per line. A broken line is skipped and counted; the rest of the chat is read.

| Field         | Meaning                                                                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq`         | Number, from 1 per chat.                                                                                                                                                                                                                             |
| `kind`        | See the table below.                                                                                                                                                                                                                                 |
| `text`        |                                                                                                                                                                                                                                                      |
| `at`          | ISO time.                                                                                                                                                                                                                                            |
| `ref?`        | `{ commentId, modelId, file?, n?, title? }` — a comment by id and **part** (`modelId` = the part id, not a version), so an old link opens the comment on that part's newest version; `file`, `n` (card number then) and `title` only label the link. |
| `model?`      | On `event` lines, the version that was shown. The version on screen for any other line is the last `event` above it.                                                                                                                                 |
| `connection?` | On `joined` / `left` / `caught-up`, the MCP server's id for that start.                                                                                                                                                                              |
| `agent?`      | The agent's own name (MCP client name, e.g. `claude-code`) on its lines.                                                                                                                                                                             |
| `detail?`     | Used by `caught-up` and `summary` (below).                                                                                                                                                                                                           |
| `topic?`      | On `elsewhere` lines, `{ title, chat?, project? }` — the topic the answer went to: `chat` = its id in this project, or `project` = the other project's folder name.                                                                                  |

| `kind`          | Line                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------- |
| `user`          | Typed in the chat.                                                                                |
| `agent`         | Its answer.                                                                                       |
| `progress`      | A step it reported.                                                                               |
| `thread`        | The user's reply under a comment.                                                                 |
| `review`        | Send review.                                                                                      |
| `replied`       | The agent answered under a comment.                                                               |
| `event`         | A model was shown: "Opened bracket_v2.step".                                                      |
| `joined`/`left` | An agent connection started listening / went quiet: "Claude Code connected".                      |
| `caught-up`     | What a new connection was told; `detail` = the same in words.                                     |
| `summary`       | The agent's summary of the chat in `detail`; also copied to the index's `summary`.                |
| `elsewhere`     | The agent answered a message from another topic there: "Answered in topic “…”"; `topic` names it. |

`kind` is kept as text: a kind an older app doesn't know is skipped when shown, never dropped from
the file.

When lines are written:

- A chat is written once it holds a message: `event`, `joined`, `left` and `caught-up` lines wait for
  the next message and are written with it.
- The index is saved before the lines are appended, so a chat file never holds lines its index entry
  doesn't count.
- The last chat in the `chats` index is the current one; **New chat** adds a new file.

## `lock`

`{ "host", "pid", "started" }` of the app window that has the project open. It is created only when
none exists, so two windows starting at once can't both get it.

| Lock found                                                      | What happens                                                                                          |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| From this computer, process gone (a crash)                      | Taken over.                                                                                           |
| From a running app on this computer                             | The second window opens read-only.                                                                    |
| From **another computer** (a shared OneDrive or Dropbox folder) | Can't be checked. The app says `open on <host> since …`, and the user chooses read-only or take over. |

## Moving from sidecars

The first time a model is opened in a folder that has v1 sidecars and no project:

- **Every** `*.thirdwheel.json` in the folder is taken in (not sub-folders). Sidecars of versions
  outside the folder that a version chain links to are taken too (`../exports/part_v2.step`).
- **Versions:** each sidecar's `versions.earlier[0]` names its parent. Links find their version by
  content hash first, then path, so a folder moved after the links were made still lines up. Linked
  sidecars become one part; unlinked ones become separate parts. A version known only from a link
  (moved) is kept as a version without marks; earlier contents of a file saved over in place are
  left out (one file name = one version). Self-links and circles are cut.
- **Markers:** paint goes into each version's marks file. Name and colour come from the newest
  version. A marker id another part already uses gets a new id.
- **Comments** are stored once. If the user deleted a comment in a newer version, it is not brought
  back. Otherwise the last-edited copy wins.
- **The old sidecars are left untouched**, and an older app still opens them. Each is remembered in
  `sidecars` and merged only once. A sidecar found later (a copied-in model with its notes) merges
  the same way. A version or comment the project already has always wins.

## Git and sync

- Commit `.thirdwheel/` with the models. The app writes `.thirdwheel/.gitignore` with `chats/` and
  `lock` when it saves the project and the file is missing (also in projects made before it); remove
  the `chats/` line to share chats. A `.gitignore` the user wrote or edited is never touched.
- `.gitattributes`: `.thirdwheel/** text eol=lf` keeps line ends stable. Readers accept `\r\n` anyway.
- The files are made for line-by-line merges: stable order, random ids, one file per version's marks,
  one line per chat entry.

## Examples

`project.json`: one part with two versions, the second exported to a sibling folder, one marker,
one resolved comment with a thread, one chat.

```json
{
  "schemaVersion": 2,
  "id": "p7k2m9x4qa",
  "name": "my-parts",
  "created": "2026-11-21T09:00:00.000Z",
  "tessellation": { "linearDeflection": 0.1, "angularDeflection": 0.5 },
  "models": [
    {
      "id": "bq3r8t1zxe",
      "name": "bracket",
      "versions": [
        {
          "id": "v1a2b3c4d5",
          "path": "bracket.step",
          "contentHash": "sha256:0f3c8a5e1d2b4c6a7e9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e",
          "format": "step",
          "added": "2026-11-21T09:00:00.000Z"
        },
        {
          "id": "w9x8y7z6u5",
          "path": "../exports/bracket_v2.step",
          "contentHash": "sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b",
          "format": "step",
          "added": "2026-11-21T10:30:00.000Z",
          "from": "v1a2b3c4d5"
        }
      ],
      "bodyTree": {
        "folders": [{ "id": "n1", "name": "Hardware", "parent": "top" }],
        "bodies": [{ "body": { "name": "Pin", "index": 1 }, "parent": { "folder": "n1" } }],
        "assemblies": []
      }
    }
  ],
  "markers": [{ "id": "m1", "name": "Thin wall", "color": "#e5484d", "visible": true }],
  "comments": [
    {
      "id": "c1",
      "modelId": "bq3r8t1zxe",
      "text": "This wall is too thin to print.",
      "markerIds": ["m1"],
      "status": "resolved",
      "author": "human",
      "createdAt": "2026-11-21T09:05:00.000Z",
      "updatedAt": "2026-11-21T10:31:00.000Z",
      "replies": [
        {
          "id": "r1",
          "text": "Made it 2 mm thick.",
          "author": "ai",
          "createdAt": "2026-11-21T10:31:00.000Z",
          "updatedAt": "2026-11-21T10:31:00.000Z",
          "status": "resolved"
        }
      ]
    }
  ],
  "chats": [
    {
      "id": "h4j5k6l7m8",
      "title": "Make the wall thicker",
      "created": "2026-11-21T09:10:00.000Z",
      "last": "2026-11-21T10:32:00.000Z",
      "entries": 3
    }
  ]
}
```

`marks/v1a2b3c4d5.json`: the first version's paint (two whole triangle runs and one cut triangle
on face 7) and a held face.

```json
{
  "schemaVersion": 2,
  "versionId": "v1a2b3c4d5",
  "contentHash": "sha256:0f3c8a5e1d2b4c6a7e9f0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e",
  "tessellation": { "linearDeflection": 0.1, "angularDeflection": 0.5 },
  "bodies": [
    { "name": "Bracket", "size": [60, 40, 8], "centre": [0, 0, 4], "area": 7420.5 },
    { "name": "Pin", "size": [6, 6, 20], "centre": [20, 0, 10], "area": 433.5 }
  ],
  "markers": [
    {
      "id": "m1",
      "entities": [
        { "kind": "face", "id": 7, "seq": 1, "fingerprint": { "type": "plane", "area": 120 } }
      ],
      "paint": {
        "faces": [
          {
            "faceId": 7,
            "triangles": [
              [120, 3],
              [140, 2]
            ],
            "pieces": [{ "triangle": 125, "tree": [1, 0, 0, 1] }],
            "samples": [10, 2, 8, 11, 2, 8, 12, 3, 8]
          }
        ]
      }
    }
  ]
}
```

`chats/h4j5k6l7m8.jsonl`: three entries.

```jsonl
{"seq":1,"kind":"user","text":"Make the wall thicker","at":"2026-11-21T09:10:00.000Z"}
{"seq":2,"kind":"event","text":"Agent loaded bracket_v2.step — new version of bracket.step","at":"2026-11-21T10:30:00.000Z","model":"w9x8y7z6u5"}
{"seq":3,"kind":"replied","text":"Done: the wall is 2 mm now.","at":"2026-11-21T10:32:00.000Z","ref":{"commentId":"c1","modelId":"bq3r8t1zxe","file":"bracket.step","n":1,"title":"wall too thin"}}
```
