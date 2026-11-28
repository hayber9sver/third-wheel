# Code map

One line per source file: what lives there. Read this to find the right file before searching.
Unit tests sit next to the file they test (`x.test.ts`); they are not listed. Keep this map in sync
when you add, move or split a file.

## apps/desktop — the Electron app

### src/main — main process (Node)

- `index.ts` — entry: re-exports the `wiring/` modules in start-up order (see the comment there).
- `wiring/window.ts` — the app window: size and placement, icon, test-mode flags, `createWindow`.
- `wiring/model-files.ts` — model files the window may read, version scans and file states, the project session, project IPC for a shown model.
- `wiring/open-folder.ts` — Open folder… and Open Recent: the recent list, the app menu, choosing a folder.
- `wiring/project-ipc.ts` — a project with no model shown, the start page, Add file…, versions and parts, saving notes, perf results, theme.
- `wiring/app-bridge.ts` — passing the MCP server's requests to the window (`askWindow`) and back; `load_model` from main.
- `wiring/agent-setup.ts` — AI status for the status bar; the Connect pop-up's IPC (agent files, find / connect).
- `wiring/app-lifecycle.ts` — About, opening feedback links, menu commands, starting the bridge, quitting, files handed to the app, single instance, start-up.
- `agent-cli.ts` — runs an agent description (`agents/*.json`): finds the program, plans / runs its commands, checks its settings files.
- `agent-fix.ts` — the Connect pop-up's other changes, shown first: pre-allow rules ("Ask fewer permission questions"), removing an entry in the way.
- `app-menu.ts` — the app menu template (File with Open Recent, Edit, Help; macOS app + Window menus; Developer in dev builds).
- `bridge.ts` — the localhost WebSocket server the MCP server talks to (token, bridge file readable only by the user, also on Windows).
- `chat-queue.ts` — chat listen loop, app side: messages waiting for the agent, waits, re-delivery.
- `chat-session.ts` — the chat for this app session: agent state, join / leave lines, catch-up.
- `chat-store.ts` — chats saved in the shown project (`.thirdwheel/chats/`).
- `chat-wiring.ts` — the bridge methods the chat tools call, the chat panel's IPC, the optional chat debug log.
- `dialog-folder.ts` — which folder an Open / Add / Locate dialog starts in.
- `launch-file.ts` — which model file a launch (double-click, second launch) asks to open.
- `model-path.ts` — one spelling per model file (symlinks, Windows letter case).
- `project-fs.ts` — Node's `fs` as the project store's file system.
- `project-session.ts` — the window's notes read from / saved into the project; lock, read-only, migration (one class).
- `recent-projects.ts` — File ▸ Open Recent list (pure).

### src/preload

- `index.ts` — the window's `window.thirdWheel` API over IPC (sandboxed preload).

### src/shared — used by main, preload and renderer

- `about.ts` — what "About Third Wheel" shows.
- `feedback.ts` — Send feedback: the setup line (version, OS, agent) and the GitHub issue / feedback form links.
- `agent-desc.ts` — agent description files (`agents/<id>.json`): what the Connect pop-up shows and does for one agent.
- `agent-list.ts` — the built-in agent description files.
- `agents.ts` — the built-in engines' texts (Connect pop-up wording per engine).
- `ai-status.ts` — AI connection status and save status texts for the status bar.
- `app-name.ts` — the display name and settings folder name.
- `chat.ts` — the Agent tab's conversation as the window sees it (types).
- `chat-setup.ts` — "Chat in Third Wheel" (pure): start line, live status, pre-allow rules merged into a settings file.
- `claude-setup.ts` — what an agent will use for a folder (the Connect check line, `.mcp.json` yes / no, fixes).
- `ipc.ts` — IPC channel names and the types sent over them.
- `load-rules.ts` — `load_model` rules (the AI works inside the project folder) and their texts.
- `menu-commands.ts` — app menu commands and the once-per-key-press guard.
- `shortcuts.ts` — platform-aware shortcuts (Cmd on macOS, Ctrl on Windows) and their labels.
- `theme.ts` — theme modes (Auto / Light / Dark).
- `window-fit.ts` — keeps a window inside its display's usable area.

### src/renderer/src — the window (DOM + three.js)

Entry and wiring (feature modules started in order by `main.ts`; they import each other's names from `main.ts`):

- `main.ts` — entry: re-exports the `wiring/` modules in start-up order.
- `wiring/ui.ts` — `byId`, settings in localStorage.
- `wiring/view.ts` — the viewport instance, theme, help sheet, navigation / orbit style, info overlay, hover readout, Info panel; the shown model's state.
- `wiring/annotations.ts` — markers, comments, dimensions in the view, 3D comment pins, autosave.
- `wiring/edit-history.ts` — undo / redo, the comments panel, paint strokes from the view.
- `wiring/tool-options.ts` — brush size, Smart fill angle (keys, Alt + scroll, toolbar row).
- `wiring/selection-ui.ts` — selection (click, box, double-click, right-click menu), Add to marker, toolbar icons, selection filter.
- `wiring/model-load.ts` — start page, progress, body list, `loadModel` (every open goes through it).
- `wiring/notes-load.ts` — a loaded model's notes: mesh-only mode, reading notes, moving them from an earlier version, version questions.
- `wiring/project-status.ts` — save indicator, the shown model's project (window title, read-only).
- `wiring/side-panel.ts` — AI status, Connect pop-up, the floating left panel (Bodies | Agent chat).
- `wiring/menu-notices.ts` — app menu items the window runs, the notice bar, notes-at-risk pop-ups.
- `wiring/versions-menu.ts` — Versions menu: add, open, compare, remove versions.
- `wiring/parts-menu.ts` — Parts menu: the project's parts, open one at its newest version.
- `wiring/send-review.ts` — Send review button, AI request banner, the part shown for a review.
- `wiring/bridge-handlers.ts` — answers the MCP server's requests (status, load, annotations, render, replies).
- `wiring/toolbar.ts` — tool switching, view buttons, toolbar fit, region pictures for the AI.
- `wiring/test-hook.ts` — `window.__thirdWheelTest` for the e2e tests (dev builds only).

3D view:

- `viewport.ts` — the three.js viewport class (scene, camera, input, picking, strokes, region pictures; one class).
- `body-buffers.ts` — draw buffers grouped by body (show any subset without a rebuild).
- `camera-views.ts` — camera maths: standard views, view keys, fit.
- `free-orbit.ts` — free orbit (no fixed up axis) on top of OrbitControls.
- `navigation.ts` — navigation styles (mouse / trackpad mappings like the CAD tools) and orbit styles.
- `wheel.ts` — tells mouse wheels from trackpad swipes.
- `view-cube.ts` — the view cube.
- `picker.ts` — GPU ID picking; `pick-buffers.ts` its ID data; `pick-resolve.ts` reading the ID buffer.
- `highlighter.ts` — hover + selection highlight; `highlight-buffers.ts` its geometry.
- `marker-entities.ts` — marker-held entities drawn in the view.
- `paint-overlay.ts` — paint drawn over the model.
- `fill-preview.ts` — Smart fill hover preview.
- `brush-cursor.ts` — brush cursors and the surface raycaster.
- `pin-overlay.ts` — comment pins over the view; `comment-pins.ts` their layout (pure).
- `dimension-overlay.ts` — dimensions over the view.
- `comment-focus.ts` — the focused comment's look (what fades).
- `ghosts.ts` — ghosts of markers a new version could not place.
- `revision-overlay.ts` — compare view drawn over the model.
- `region-render.ts` — offscreen region picture; `region-view.ts` its camera; `region-occlusion.ts` parts in front; `contact-sheet.ts` several regions in one image.
- `box-select.ts` — box select rules (pure).

Panels, tools and state:

- `selection.ts` — the current selection (pure); `selection-filter.ts` the filter (vertex / edge / face / body).
- `tools.ts` — tools (Select, Brush, Smart fill), keys, brush sizes.
- `smart-fill.ts` — Smart fill region growing (pure).
- `paint.ts` — the paint layer (painted triangles per marker, pieces).
- `markers.ts` — markers (state, edits); `markers-panel.ts` the Markers panel.
- `comments.ts` — comments and threads (state, edits); `comments-panel.ts` the Comments panel.
- `undo.ts` — undo / redo history.
- `context-menu.ts` — the right-click menu.
- `info-panel.ts` — the Info panel; `info-format.ts` its texts and exact values.
- `hover-label.ts` — the hover readout text.
- `body-list.ts` — the body list; `body-tree.ts` its tree; `body-folders.ts` the user's folders.
- `left-panel.ts` — the floating left panel (tabs, fold, resize).
- `collapsible.ts` — collapsible panel sections.
- `toolbar-fit.ts` — toolbar fit for narrow windows.
- `icons.ts` — inline SVG icons.
- `help.ts` — the cheat sheet content.
- `start-page.ts` — the start page (no project open).
- `about.ts` — the About pop-up.
- `feedback.ts` — the Send feedback pop-up (Help menu, start page link).

Loading, notes and the AI:

- `model-loader.ts` — loads model files through the import worker, with progress; `step-worker.ts` the worker entry.
- `sidecar.ts` — notes ↔ app state (markers, comments, paint); checks.
- `autosave.ts` — saves the notes after changes.
- `revision.ts` — loading a new version: carrying notes over, questions and texts.
- `version-list.ts` — the Versions menu list; `version-diff.ts` what changed between two versions.
- `part-list.ts` — the Parts menu list.
- `dialog-question.ts` — a `<dialog>` asking one question at a time (a late close event never answers the next one).
- `review-request.ts` — review requests from the AI; `send-to-ai.ts` the Send review bookkeeping.
- `ai-connect.ts` — the Connect pop-up (one tab per agent) and AI status; `connect-chat.ts` its "Chat in Third Wheel" part.
- `chat-panel.ts` — the Agent tab; `chat-display.ts` what it shows (pure); `chat-markdown.ts` safe Markdown for answers.
- `perf.ts`, `perf-probe.ts` — frame-time measurement (dev).

### e2e — Playwright tests of the built app

- `fixtures.ts` — shared setup (`launchApp` / `closeApp`, fake agents, helpers); `notes.ts` reading project notes.
- `view.spec.ts` picking, body folders, dimensions, Info · `paint-tools.spec.ts` · `markers.spec.ts` · `comments.spec.ts` · `projects.spec.ts` · `app.spec.ts` · `ai-tools.spec.ts` (region pictures, bridge, MCP tools, Connect, AI status) · `revisions.spec.ts` · `version-history.spec.ts` · `mesh.spec.ts` · `chat.spec.ts`.
- `chat-loop-drive.js` — chat listen-loop driver (not a test).

### Other

- `agents/*.json` — one description file per agent for the Connect pop-up; `agent.schema.json` their schema.
- `electron.vite.config.ts`, `playwright.config.ts`, `electron-builder.yml` — build, e2e and packaging config.

## packages/core — pure TypeScript (no DOM / three.js / Electron)

- `index.ts` — the package's exports.
- `schema.ts` — annotation schema v1 (markers, comments, paint) and its parsing.
- `runs.ts` — triangle runs (compact paint storage).
- `format-json.ts` — human-readable JSON for saved files.
- `region.ts` — region analysis (what a painted area is: faces, sizes).
- `thread.ts` — comment threads (replies).
- `versions.ts` — versioned file names (`part_v2.step`).
- `project-schema.ts` — project format v2 (`project.json`, marks).
- `project-store.ts` — reading and writing a project folder.
- `project-notes.ts` — one project version seen as v1 notes, and written back.
- `project-migrate.ts` — old `*.thirdwheel.json` sidecars → project.
- `project-paths.ts` — paths and ids in a project folder (macOS + Windows).
- `project-lock.ts` — `.thirdwheel/lock`.
- `project-chats.ts` — the project's chats index.
- `project-parts.ts` — the project's parts with their newest versions (Parts menu).
- `marker-names.ts` — marker names unique in a project: taken-name check, "Name (2)" copies, old duplicates renamed.
- `agent-text.ts` — cleaning text from files (hidden characters, long names) before the MCP server hands it to the agent.
- `bridge.ts` — app bridge protocol; `bridge-methods.ts` its methods for the MCP tools; `chat-methods.ts` the chat methods.
- `testing/fixtures.ts`, `testing/memory-fs.ts` — test helpers (sample projects, in-memory file system).

## packages/geometry — STEP / mesh import and geometry (only package that calls the kernel)

- `index.ts` — the package's exports.
- `step-import.ts` — STEP → `StepModel` with occt-wasm; `model.ts` the model type.
- `import-worker.ts` — import off the UI thread.
- `mesh-import.ts` — STL / 3MF import (mesh-only mode); `mesh-hash.ts` mesh hash.
- `part-names.ts` — part names from the STEP assembly tree.
- `analytic.ts` — exact geometry of analytic faces / edges (radius, axis…).
- `edge-chain.ts` — tangent edge chains (double-click an edge selects its chain).
- `entity-info.ts` — facts about picked entities and measurements between two.
- `exact.ts` — exact measurements from OpenCascade on request.
- `dimension.ts` — the one dimension drawn for one or two entities.
- `fingerprint.ts` — fingerprints saved with notes (bodies, entities).
- `paint-samples.ts` — points spread over painted area, per face.
- `review.ts` — the review payload the AI reads.
- `transfer.ts` — moving notes onto a new version: rules, tolerances, public functions.
- `transfer-match.ts` — matching bodies, lining markers up, matching entities.
- `transfer-model.ts` — transforms and the new model per body (grid for nearest surface).
- `transfer-paint.ts` — moving paint onto the new surfaces.
- `revision-set.ts` — the revision test set (expected results).
- `round.ts` — rounding for compact output; `vec.ts` small vector helpers.
- `scripts/make-large-step.js`, `scripts/make-revision-set.js` — test data generators.

## packages/mcp-server — MCP server (stdio)

- `cli.ts` — entry point; `index.ts` the package's exports.
- `tools.ts` — the MCP tools and the server instructions; every bridge result is cleaned for the agent here.
- `bridge-client.ts` — client side of the app bridge.
- `build.js` — bundles the server into one file.

## scripts

- `dev-open.js` — `pnpm dev:open <model.step>`.
- `third-party-notices.js` — third-party notices for the app and the licence allow-list (`--check`); `licences/` licence texts it includes.
- `demo/record-demo.js`, `demo/encode-gif.js` — the README demo GIF (the recording plays the agent in the Agent tab; `demo/square-wheel_v2.step` = its second version, only the pin changed).
