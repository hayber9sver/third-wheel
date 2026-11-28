# MCP tools

The AI talks to the running app through the MCP server `packages/mcp-server`, which uses the
[app bridge](#app-bridge-mcp-server--running-app). The app must be running; otherwise every tool
answers "Third Wheel is not running".

What to read:

- **Connecting an AI agent:** [Setup](#setup-claude-code).
- **What each tool takes and returns** (agent builders, contributors): [Tools](#tools).
- **How the MCP server talks to the app** (contributors): [App bridge](#app-bridge-mcp-server--running-app)
  and [Agent tab](#agent-tab-chat_wait-chat_send-chat_progress-chat_history-chat_summary).

## Setup (Claude Code)

The app shows this setup with the real path: click the AI status in the status bar (or
"Set up your AI agent…" on the start view). It gives a copyable
`claude mcp add third-wheel -- node "<path>"` (optionally `--scope user`) and `.mcp.json` snippet.

To set it up by hand:

1. Build the server inside your clone of third-wheel (Node 22+):

   ```sh
   pnpm install && pnpm build:mcp
   ```

   This makes one runnable file, `packages/mcp-server/build/third-wheel-mcp.js`. `pnpm build`
   builds it too.

2. Put this in your CAD project's `.mcp.json`, with the **absolute** path to your clone:

   ```json
   {
     "mcpServers": {
       "third-wheel": {
         "command": "node",
         "args": ["/abs/path/third-wheel/packages/mcp-server/build/third-wheel-mcp.js"]
       }
     }
   }
   ```

3. Start the app (`pnpm dev`), then Claude Code in the project folder. `/mcp` shows `third-wheel`.

Packaged builds look for the server at `<resources>/mcp/third-wheel-mcp.js` (the installers ship it).

## Tools

### Rules for all tools

- All answers are compact JSON text, except `render_region` (a PNG + JSON text).
- Lengths mm, areas mm².
- Errors come back as tool errors with a readable message (`isError`).
- **modelId** = first 12 hex digits of the file's sha256 (`modelIdOf` in core). Every new STEP
  export gets a new id.
- Tools that take a `modelId` fail with "call load_model" when the app shows a different model.
  Exception: `get_annotations` also reads a model opened earlier in the same app window (not one
  that is now a version of the shown model's part: comments belong to the part, so it says to read
  the shown model).

### Overview

| Tool                                        | Params                                                    | Use                                            |
| ------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------- |
| [`load_model`](#load_model)                 | `path`, `revisionOf?`                                     | Open a model (or a new version) in the app     |
| [`get_open_model`](#get_open_model)         | none                                                      | Which model is open in the app (first call)    |
| [`search_parts`](#search_parts)             | `query` or `cls`, `limit?`                                | Look up library parts (the shipped catalogue)  |
| [`request_review`](#request_review)         | `modelId`, `alsoModelIds?`, `message?`                    | Ask the user to review                         |
| [`wait_for_review`](#wait_for_review)       | `reviewId`, `timeoutSec?`                                 | Wait until the user clicks **Send review**     |
| [`get_annotations`](#get_annotations)       | `modelId`, `statuses?`                                    | Read comments and markers (the review payload) |
| [`render_region`](#render_region)           | `modelId`, `markerIds[]` + `size?`, or `groups`           | Picture of marked regions                      |
| [`set_comment_status`](#set_comment_status) | `modelId`, `commentId`, `status`, `note?`, `partResults?` | Resolve / won't fix / reopen, with a reply     |
| [`reply_to_comment`](#reply_to_comment)     | `modelId`, `commentId`, `text`, `partResults?`            | Reply in a comment's thread, status unchanged  |
| [`wait_for_message`](#wait_for_message)     | none                                                      | Listen to the app's Agent tab                  |
| [`send_chat_message`](#send_chat_message)   | `text`                                                    | Answer in the Agent tab                        |
| [`post_progress`](#post_progress)           | `text`                                                    | Short step line while the agent works          |
| [`get_chat_history`](#get_chat_history)     | `before?`, `limit?`, `topic?`                             | Read earlier chat lines                        |
| [`post_chat_summary`](#post_chat_summary)   | `text`                                                    | Store a summary of the current topic           |

### `load_model`

**Params**

- `path`: `.step` / `.stp`, or `.stl` / `.3mf` in mesh-only mode (below). Relative = from the MCP
  server's working folder, i.e. the AI's project. Network paths (`\\host\share`, `//host`) are
  refused.
- `revisionOf?`: modelId of a model loaded this session that this file is a new version of. The AI
  is told to export each version under a new name and pass it. It also links both files in the
  project's version list, shown in **Versions ▾**. Unknown `revisionOf` → error.

**Answer**

`{ modelId, name, path, bodies, faces, markers, comments: { open, resolved, wontfix }, revision?, hint?, warning?, namesLost?, project: { name, folder }, saveNextAs }`

Brings the window to the front. Up to 10 min for huge files. Its annotations in the project come back.

| Field            | Meaning                                                                                                                                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project.folder` | Where the AI saves every export.                                                                                                                                                                                                                                                                                       |
| `saveNextAs`     | A free path next to the file (next version name, not on disk, not listed).                                                                                                                                                                                                                                             |
| `hint`           | The file looks like a newer copy of a model loaded this session (versioned name `part_v2` / `-rev3` / ` (2)`, or same body names) and `revisionOf` was missing: names the modelId to load it again with. Also names a mesh with notes of the same overall size. Never names a file the user removed from its versions. |
| `warning`        | Says when a version link changed. A file has one earlier version, so `revisionOf` moves it from the one the project listed (or from its own older contents). A file that is already an earlier version of `revisionOf` is not linked (circle).                                                                         |
| `revision`       | Present when the file is a new version (same path with new contents, or `revisionOf`). See [Revisions](#revisions).                                                                                                                                                                                                    |
| `namesLost`      | With `revisionOf`: most of the user's custom body names of the previous version are missing in this file (a build123d round trip dropped them). Says how to put them back; see [Keeping the user's body names](#keeping-the-users-body-names).                                                                         |
| `mesh`           | `"stl" \| "3mf"` in mesh-only mode.                                                                                                                                                                                                                                                                                    |

**Project rules** (the AI works inside the project folder)

- The file must lie in the open project's folder or a subfolder (not in a subfolder with a project
  of its own). With no project open, its folder's project opens (made on the first write).
- Without `revisionOf` a file inside is listed as a part at once.
- A listed file saved over in place loads as the same version with the new contents (like Reload;
  `hint` says so).
- Refused, nothing loaded, with an error naming the path to save to and "if you can't save there,
  don't try again: tell the user":
  - a file outside the project folder (with or without `revisionOf`; no other folder is searched or
    written);
  - a `revisionOf` model of another project;
  - a new version (`revisionOf`) under a file name the project lists with other contents (saved over).

**Mesh-only mode** (`.stl` / `.3mf`)

- The result has `mesh: "stl" | "3mf"`, the `get_annotations` payload too.
- Markers carry paint only; each painted "face" is a whole mesh body.
- A mesh can't be loaded with `revisionOf`, but it can be the `revisionOf` of a STEP (below).

#### Revisions

`revision` = `{ of, path, annotations: carried | moved | waiting | none | own, markers, comments, transfer?, matched?, recoloured? }`

| `annotations` | Meaning                                                                                                                                                                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `carried`     | Same geometry, all moved over.                                                                                                                                                                                                                                |
| `moved`       | Geometry changed, markers moved by matching geometry; details in `transfer`.                                                                                                                                                                                  |
| `waiting`     | Moving them failed, kept, model starts empty.                                                                                                                                                                                                                 |
| `own`         | The file has markers of its own: kept, nothing moved. `matched` = names of its markers that are the part's markers of the same name (they take that marker's id, colour and comments); `recoloured` = `[{ name, taken }]` its markers that got a free colour. |

`transfer` = `{ found, changed, lost, check, flagged: [{ id, name, status }], fromMesh?, looksDifferent? }`

- `looksDifferent` (STEP → STEP, another file) = why it looks like another part, not a version
  (more than half of at least 2 placed markers lost, or a side of the overall box more than 25 %
  off, e.g. `"6 of 8 markers lost"`). The markers moved anyway, and the app's notice says so too
  (the user, not the AI, is asked "New version / Separate part" when they add such a file). The AI
  is told to say so in the chat and check `revisionOf`.
- `fromMesh`: when `revisionOf` = an STL / 3MF of this session and a STEP is loaded, the files are
  lined up and the paint goes onto the STEP's faces.
  `fromMesh` = `{ points, matched, surface, toleranceMm, mirrored, meshRead }` (painted points within
  `toleranceMm` of a STEP face; share of the mesh surface on the STEP).

After a transfer, `get_annotations` markers carry `transfer: { status, from, was? }` until the user
confirms them.

### `get_open_model`

**Params:** none.

**Answer:** `{ model: { modelId, name, path, contentHash } | null, summary?: { bodies, markers, comments: { open, resolved, wontfix }, mesh? } }`

- The model open in the app; nothing is loaded. `model: null` = nothing open.
- The AI is told to call it first in a new session (bridge method `open_model`).

### `search_parts`

**Params:** `query` (English or Chinese words, as in the Library panel's search box) **or** `cls` (a
class name), `limit?` (default 10, max 30).

**Answer**

- With `query`: `{ library, version, total, hits[], note? }`. Each hit: `cls`, `label`, `module`,
  `group`, `operation`, `matched`, `exampleSize`, `solids`, `subparts?`, `builtWith`, `options[]`
  (standard types, sizes, choices, numbers with default, flags such as thread); long lists come as
  `count` + `examples`.
- With `cls`: that class in full (every buildable size by standard).
- Same catalogue as the panel, so no size the library cannot build.

### `request_review`

**Params:** `modelId` (the shown model), `alsoModelIds?` (≤ 3 models opened earlier in this window),
`message?` (≤ 2000 chars, shown in the AI banner).

**Answer:** `{ reviewId }`, after a text line "Now call wait_for_review…" (the tool text tells the AI
to wait in the same turn).

- A new request replaces an open one.
- With `alsoModelIds` the banner shows one button per model (open-comment count). Opening any of
  them keeps the request; one Send answers for all.
- Brings the window to the front.

### `wait_for_review`

**Params:** `reviewId`, `timeoutSec?` (default 120, max 300).

**Answer:** `{ reviewId, state, modelId, openComments?, models?, reason? }`

| `state`     | Meaning                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sent`      | The user clicked **Send review** (then call `get_annotations`). `openComments` = all models together; `models` = `{ modelId, name, openComments }` per model when the request had `alsoModelIds`. |
| `waiting`   | Time ran out; call again.                                                                                                                                                                         |
| `cancelled` | The user dismissed it, a newer request replaced it, or a model outside the request was opened (`reason`).                                                                                         |

Settled answers are kept, so a late call still gets them. A window reload drops open requests
("Unknown review").

### `get_annotations`

**Params:** `modelId`, `statuses?` (default `["open"]`).

**Answer:** the [review payload](#review-payload-get_annotations),
`reviewPayloadText(reviewPayload(model, annotations, { statuses }))`.

- A model opened earlier in this window: the payload kept when it was left (every status, cut by
  `filterReviewPayload`; a model not shown can't change).
- `render_region` / `set_comment_status` still need it shown.

### `render_region`

**Params:** `modelId`, and either

- `markerIds[]`: one picture, `size?` 64–768, default 384; or
- `groups`: ≤ 4 marker lists → one contact sheet.

**Answer:** image `image/png` + text `{ width, height, view? , tiles?, skipped? }`
(see [Picture facts](#picture-facts-render_region)). Unknown marker ids → error.

### `set_comment_status`

**Params:** `modelId`, `commentId`, `status` (`open` / `resolved` / `wontfix`), `note?`,
`partResults?` (see [Part requests](#part-requests)).

**Answer:** `{ commentId, status, replyId?, changed, partsUpdated? }`

- The note becomes an AI reply in the thread tagged with the status (same undo step).
- Acts on the shown model. The user can undo it (`Cmd+Z` (macOS) / `Ctrl+Z` (Windows)); saved like any edit.
- Resolved / won't fix from the AI waits for the user's Confirm (comment `awaitingConfirm`).
  Reopen makes it open again for the AI.

### `reply_to_comment`

**Params:** `modelId`, `commentId`, `text` (1–10 000 chars), `partResults?` (see
[Part requests](#part-requests)).

**Answer:** `{ commentId, replyId, status, partsUpdated? }`, after a text line telling the AI to call
`request_review` + `wait_for_review` once it has replied (bridge method `reply_comment`).

- Adds an AI reply without changing the status.
- Server instructions: questions about a comment go in its thread, not the chat.
- Acts on the shown model; undoable; saved like any edit.

### `wait_for_message`

**Params:** none.

Listens to the app's Agent tab (long-poll). The app sets the wait: default and max 25 min (Claude
Code aborts a tool call silent for 30 min).

| Answer                                                                | Meaning                                                                              |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `{"state":"message","messages":[{id,text,about?,shown?}],"catchUp"?}` | Every message sent since the last call, oldest first, then a line saying what to do. |
| `{"state":"waiting"}`                                                 | Nothing yet; call again.                                                             |
| `{"state":"stopped"}`                                                 | No message for 2 h; stop listening.                                                  |
| `{"state":"replaced"}`                                                | Another agent session's wait took over; stop.                                        |
| `{"state":"closed"}`                                                  | The app was quit; stop (open it and start listening again).                          |

Fields of a `message` answer:

- `shown` = `{ modelId, file }` on screen when the user sent it.
- `about`, one of:
  - `{ kind: "thread", modelId, file, commentId, n, payload }`: the user replied under that comment.
    `text` = the reply; `payload` = that comment as `get_annotations` gives it, with its markers.
  - `{ kind: "review", models: [{ modelId, file, path, openComments, newComments: [{ id, n }] }] }`:
    the user clicked Send review. `newComments` = open comments not sent before.
- `catchUp`: only on the first call of a new connection (answered at once, `messages` may be empty):
  `{ project?, shown?, since?, parts: [{ file, newVersions?, openComments }], modelSwitches?, summary?: { of, text }, topic: { title?, lines, latest: [{ from, text }] } }`.
  - `parts` = the project's parts, plus the shown model if the project doesn't list it yet.
  - Counts and the last 6 messages, never the transcript.
  - Sent again until a later call acks its delivery.

A hand-over the agent never received (the call was cancelled, or the session ended) is handed over
again on the next call, also to a new session.

### `send_chat_message`

**Params:** `text` (1–20 000 chars, Markdown subset: bold, italic, code, lists, code blocks, https links).

Shows the agent's answer in the Agent tab, under the agent's name, in the topic its latest message
came from (the topic shown then gets an "Answered in topic" line when it is another).

### `post_progress`

**Params:** `text` (1–300 chars).

A short step line ("Editing the CAD script"); shown under the "…" while the agent works, folded
under its next answer.

### `get_chat_history`

**Params:** `before?` (a `seq`), `limit?` (1–100, default 30), `topic?` (an id from `topics`).

**Answer:** `{ topic: { id?, title, current }, lines: [{ seq, kind, text, at, ref? }], hasOlder, topics? }`

- `lines`: lines of the current topic (the one the agent's latest message came from, where its
  answers are filed), or of `topic`, before `before`, oldest first.
- Progress and catch-up lines are left out; texts cut at 2000 chars; `ref` = `"#n"`.
- `topics` (first page only) = the project's topics, newest first, `{ id, title, lines, last }`.

### `post_chat_summary`

**Params:** `text` (1–4000 chars).

Stores the agent's summary of the current topic (a folded "Saved a summary of this topic" line;
`summary` in the chats index). The next catch-up sends it (`of: "this topic"`, or `"earlier topic"`
after New topic).

### Review payload (`get_annotations`)

Built by geometry `review.ts`; typically < 1k tokens (a 130-body assembly, 2 markers: ~860).
Positions to 0.01 mm, directions to 1e-3, areas to 0.1 mm².

- `model` file name, `path` (its full path on this computer, so you can edit the file or write the next
  version beside it; added by the app), `units: "mm"`.
- `comments[]`:
  - `id`, `text`, `status`, `by` (`human` / `ai`).
  - `n`: the card number the user sees ("#3" = `n` 3), its place in the list of all comments.
  - `markers`: marker ids; empty = about the whole model.
  - `linkedModels?`: other parts the comment is about, by their newest file name; never a version
    of the comment's own part.
  - `replies?`: the thread, oldest first, the last 10: `by`, `text`, `status?` = what the comment
    was set to with that reply; an older `note` comes first as an AI reply. `moreReplies?`: earlier
    ones left out.
  - `parts?`: library parts the user asks for (see [Part requests](#part-requests)).
  - `measured?`: only when the comment's markers hold exactly two entities.
    `between` [{ `kind`, `id` }, …]; `main` { `kind`: `distance` / `angle` / …, `value` } = the
    dimension the app draws; and the values Info shows: `distance` (shortest; `distanceApprox` =
    from the mesh), `centreDistance`, `axisDistance`, `planeDistance`, `angle` + `angleBetween`.
    To 0.001 mm / degree; measured on the file as it is now.
- `markers[]` (only those the listed comments point at, first-mention order): `id`, `name`,
  - `paint?`: `area`, `centre` (area-weighted), `size` (bbox), `normal` (mean, unit), `flatness`
    (1 flat … 0 facing all ways), `patchCount`, `patches?` (largest ≤ 5: `area`, `centre`) +
    `morePatches?`, `faces[]` (CAD faces under the paint, most painted first, ≤ 8; entity fields +
    `covered` 0–1) + `moreFaces?`.
  - `entities?` (held B-rep entities, ≤ 10) + `moreEntities?`.
- Entity fields (only those that apply): `kind` (`vertex` / `edge` / `face` / `body`), `id`
  (traversal index), `body` (index → name in `bodies`), `type` (`plane`, `cylinder`, `line`,
  `circle`, …), `form`, `radius`, `minorRadius`, `length`, `arcAngle` (partial arcs only),
  `halfAngle`, `area`, `point` (vertex / centre / apex / a point on the plane or axis), `dir`
  (normal / direction / axis), body `size` + `faces`.
- `bodies`: `{ "<body index>": "<name>" }` for every body mentioned.

### Part requests

A comment may carry `parts[]`: library parts (bd_warehouse) the user chose in the Library panel. Each:
`id` (`p1`, …), `source` (`kind: "library"`, `library`, `version?`, `cls`, `params` = the standard type, size
or numbers the user fixed; a missing one is yours to choose, e.g. the size from the hole it goes in;
`simple: false` = a real thread was asked for, `simple: true` = none; bd_warehouse screws and nuts default to no
thread, so a missing `simple` gives smooth screws),
`copies`, `scope` (`"whole"` or `{ subparts: [names] }`), `target?` (`markerIds`, `mode?`: `each` or
`pattern`), `note?` (a special requirement), `result?` (yours, below). The comment's `text` is the
instruction. Build the parts with build123d / bd_warehouse, place them at the target markers, export a new
model file into the project folder (`saveNextAs`) and `load_model` it with `revisionOf`. Report with `partResults` on `set_comment_status` or
`reply_to_comment`: one entry per part, `{ partId, status, bodies?, note? }` with `status` `placed`,
`skipped`, `failed` or `needs-info` (put the question in `note` or the reply). The app stores each as the
part's `result` and shows it on the comment. An unknown `partId` is an error and nothing is changed. The
answer has `partsUpdated`.

Step-by-step recipes (start of a session, keeping names, placing a library part at a hole, cutting a pocket, reporting) are in `docs/recipes.md`.

### Keeping the user's body names

The Bodies list shows the names inside the STEP file. build123d's `import_step`, the results of boolean
operations and `export_step` drop them: the new file then has bodies called `SOLID` / `COMPOUND` (or
codes like `=>[0:1:1:2]`) and no assembly nesting, and the user cannot find their parts. When you change a
model with build123d, set `.label` on every solid you export (the text of the previous version's
`PRODUCT` names) and keep the nesting with `Compound(label=…, children=[…])`. When `load_model` is given a
`revisionOf` and most of the previous version's custom names are missing in the new file, the result has
`namesLost` with this advice; fix the names, export under a new file name and load it again.

### Picture facts (`render_region`)

- `view` (one picture) or each of `tiles[]`:
  - `viewDir`: unit, from the region towards the camera; the camera looks along −viewDir.
  - `up`: world direction that is up in the picture.
  - `center`: world point at the picture centre, mm.
  - `mmPerPx`: orthographic.
  - `ghosted[]` (`body`, `name`): parts in front of the region drawn faint and see-through.
- Tiles also have `number` (label top-left, none with one tile), `group` (index into `groups`),
  `markerIds`, pixel rect `x`, `y`, `size`.
- `skipped`: group indices with nothing to draw.
- Asked markers in their own colours, the rest grey with dark edges on white.

### Text from files (cleaned before the agent reads it)

Part names in a STEP file, file names and comments in a notes file someone else wrote can hide
instructions (zero-width characters, bidi overrides, Unicode tag characters a model reads but the
user never sees). The MCP server passes every bridge result through `cleanForAgent`
(`packages/core/src/agent-text.ts`) before the agent gets it:

- Control, format, private-use and variation-selector characters are removed (tabs and line breaks
  stay).
- Names (`name`, `title`, `project`, `bodies`) become one line of at most 200 characters.
- File names (`model`, `file`, `linkedModels`, …): at most 255.
- Paths only lose hidden characters.
- Other text (comments, replies) is cut at 10,000 characters (the app's own comment limit, so only a
  hand-edited notes file gets cut), ending in `… [N more characters cut]`.
- Chat lines (`wait_for_message` with its catch-up, `get_chat_history`) are not cut.

Removing joiners also changes some emoji sequences and Persian / Indic text slightly; paths that
contain such characters no longer match the file. The server instructions and `get_annotations` tell
the agent that names and comments are user data: a comment is a request about the model, never an
instruction about anything else.

## App bridge (MCP server ↔ running app)

### Connection

- The app opens a WebSocket on `127.0.0.1` (random free port) at start, unless `THIRD_WHEEL_BRIDGE=0`.
- It writes a **bridge file**: `{ app, protocol, port, token, pid, version }`.
  - Readable only by the user: file mode 0600. On Windows, where the mode does nothing, `icacls`
    removes inherited access and grants only the signed-in user; if that fails the app logs a
    warning and keeps the profile folder's default access.
  - New random token each start.
  - Removed on quit (only if a later app copy hasn't taken it over; the last started copy wins).
  - Location: macOS `~/Library/Application Support/third-wheel/bridge.json`; Windows
    `%APPDATA%\third-wheel\bridge.json`.
  - `THIRD_WHEEL_BRIDGE_FILE=<path>` overrides it in both the app and the client (e2e tests use
    their own).
- Clients connect with `Authorization: Bearer <token>`. Refused before the WebSocket opens:
  - wrong / missing token (401);
  - any `Origin` header (= a web page, 403);
  - a `Host` other than `127.0.0.1:<port>` / `localhost:<port>` (403).

### Messages

- Messages are JSON. Request `{ id, method, params? }` (≤ 1 MB) → `{ id, result }` or
  `{ id, error: { code, message } }`.
- Codes: `bad_request`, `unknown_method`, `no_window`, `timeout`, `failed`.
- Requests may overlap; answers match by `id`.
- Client-side errors (`BridgeError.code`): `not_running` (no file, or nobody listening — a crashed
  app's file), `unauthorized`, `refused`, `version_mismatch`, `closed`, `timeout`, `connect_failed`.

| Method                                                                                                  | Answered by   | Result                                                         |
| ------------------------------------------------------------------------------------------------------- | ------------- | -------------------------------------------------------------- |
| `ping`                                                                                                  | main          | `{ app: 'third-wheel', version, protocol }`                    |
| `status`                                                                                                | window        | `{ model: { path, name, contentHash, modelId } \| null }`      |
| `load`, `annotations`, `request_review`, `wait_review`, `render`, `set_comment_status`, `reply_comment` | main + window | see tools above (params / results in core `bridge-methods.ts`) |
| `chat_wait`, `chat_send`, `chat_progress`, `chat_history`, `chat_summary`                               | main          | the Agent tab tools above (core `chat-methods.ts`)             |
| `chat_hello`                                                                                            | main          | `{ ok: true }` — see below                                     |

Time limits: window answers 30 s; `load` 10 min, `render` 2 min, `wait_review` its own timeout +
10 s (client + 20 s).

### Code

| Part     | Where                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocol | `packages/core/src/bridge.ts`                                                                                                                                                                             |
| Server   | `apps/desktop/src/main/bridge.ts` (handlers in `main/wiring/app-lifecycle.ts` + `app-bridge.ts`, window methods via `askWindow` → renderer `onBridgeRequest` in `renderer/src/wiring/bridge-handlers.ts`) |
| Client   | `packages/mcp-server/src/bridge-client.ts` (`connectBridge`, `call`)                                                                                                                                      |
| Tools    | `packages/mcp-server/src/tools.ts` (one bridge connection per tool call), entry `cli.ts`                                                                                                                  |

### Agent tab (`chat_wait`, `chat_send`, `chat_progress`, `chat_history`, `chat_summary`)

The app keeps the conversation and a queue of the user's messages
(`apps/desktop/src/main/chat-queue.ts`, `chat-session.ts`, `chat-wiring.ts`).

**`chat_hello`** (not a tool): the MCP server (`cli.ts`) sends it once when the agent's MCP client
has finished its handshake: `{ connection, agent?, folder? }` (`folder` = the server's working
folder). The setup pop-up (**Set up your AI agent**) then shows "Connected (started in …)" before
the agent listens; no chat line. An app without it answers an error, which the server ignores.

**`chat_wait` params**

| Param         | Meaning                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------- |
| `ack?`        | The `delivery` of the last hand-over the MCP server passed to the agent: only then are those messages done. |
| `agent?`      | The MCP client's name, shown in the tab.                                                                    |
| `connection?` | A random id the MCP server makes once per start, 8–64 `a-z0-9`.                                             |

**Connections**

- A new connection gets a `joined` line ("Claude Code connected"; the one before, if still there,
  a `left` line). Its first wait is answered at once with `catchUp` and a folded `caught-up` line
  showing it in words.
- The same id after a `left` line gets "… is listening again".
- `not-listening` for 2 min (`THIRD_WHEEL_CHAT_LEAVE_SEC`) or `stopped` writes the `left` line
  ("… stopped listening").
- The app can't tell a fresh agent from a resumed one or see `/clear`: a connection is one MCP
  server start.
- Messages carry `shown` from the window's model event lines (`modelId`).
- A wait whose connection closes is dropped without losing messages.

**Agent state shown in the chat**

| State           | When                                                                                                                                                                                                                                                                                                                                                           |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `none`          | No wait yet.                                                                                                                                                                                                                                                                                                                                                   |
| `listening`     | A wait is open, or ended less than 30 s ago.                                                                                                                                                                                                                                                                                                                   |
| `working`       | User messages handed over (a catch-up alone doesn't count), until its next wait or a `chat_send` answer. After 10 min (or the wait time, if shorter) without any MCP tool call it is marked `quiet`: "No news for 10 min — check its terminal". The "…" shows only in the topic the messages came from; other topics get `workingIn` and a note that opens it. |
| `not-listening` | Follows `working` (see Connections for the `left` line).                                                                                                                                                                                                                                                                                                       |
| `stopped`       | 2 h without a message.                                                                                                                                                                                                                                                                                                                                         |

The states follow in that order: `none` → `listening` → `working` → `not-listening`. Quitting the app
answers an open wait `closed`.

**Lines the window adds** (besides typed messages; IPC `chatPost`, checked with `chatPostSchema`)

- `thread`: the user's reply under a comment, queued with its `about`, only once an agent listened
  this app session.
- `review`: Send review with a chat agent, queued.
- `replied`: the agent's `reply_to_comment` / `set_comment_status` note: a link line in the chat,
  not queued.

Send review counts open comments the agent hasn't had (not sent with a review / copied message /
thread reply, unchanged since, and not last written by the AI). `about` is capped at 60 000 JSON
characters.

**Settings for tests and debugging**

| Variable                                                                                  | Effect                                                             |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `THIRD_WHEEL_CHAT_WAIT_SEC` / `THIRD_WHEEL_CHAT_GRACE_SEC` / `THIRD_WHEEL_CHAT_LEAVE_SEC` | 1–1500 s: shorten the wait, the 30 s and the 2 min (tests).        |
| `THIRD_WHEEL_CHAT_LOG=<file>`                                                             | Writes a JSON-lines log of the steps (timings and sizes, no text). |
