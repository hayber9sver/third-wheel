# Third Wheel development

How to build Third Wheel, test it and change it. Back to the [README](../README.md). For using the app, see the
[user guide](user-guide.md). To send a change, see [Contributing](../CONTRIBUTING.md).

## Build from source

No programming needed. You type a few lines into a terminal (or let your AI agent do it).

### What you need

- **Node.js 22 or newer.** Get the "LTS" version from [nodejs.org](https://nodejs.org). Node 25 and newer no longer
  include Corepack (it gives you the right pnpm version): the steps below add it with one extra line.
- **Git.**
  - macOS: run `git --version` in Terminal and accept the install offer.
  - Windows: [git-scm.com](https://git-scm.com/download/win).

### Easiest: let your AI agent do it

In Claude Code (or another coding agent), ask:

> _Clone https://github.com/XiLaoTr/third-wheel and build it, following docs/development.md._

Later, to start it:

> _Run Third Wheel_ (it runs `pnpm dev` in the `third-wheel` folder).

Once it runs, to connect the agent:

> _Connect yourself to Third Wheel, following docs/user-guide.md (built from source)._

The agent installs what's missing and fixes most of the problems listed
[below](#if-something-goes-wrong) on its own. You still need Node.js and Git ([above](#what-you-need)); ask the agent if
you're unsure whether you have them.

### By hand

1. Open **Terminal** (macOS) or **PowerShell** (Windows).
2. Run these lines one at a time:

   ```sh
   git clone https://github.com/XiLaoTr/third-wheel.git
   cd third-wheel
   npm install -g corepack  # Node 25 or newer only, once per computer
   corepack enable          # once per computer; gives you the right pnpm version
   pnpm install             # downloads everything the app needs (a few minutes)
   pnpm build               # builds the app and the MCP server for your AI agent
   pnpm dev                 # starts the app
   ```

3. Then [set up Claude Code](user-guide.md#set-up-claude-code).

- **Next time:** `cd third-wheel` and `pnpm dev` are enough.
- **To update:** `git pull`, `pnpm install`, `pnpm build`.

### If something goes wrong

- **`corepack` "is not recognized" / "command not found":** your Node is 25 or newer, which no longer includes
  Corepack.
  1. Run `npm install -g corepack` once (macOS: see the next point if it says "permission denied").
  2. Open a new terminal, then run `corepack enable` again.

  Don't install pnpm by hand instead: another pnpm version can skip the Electron download ("Electron failed to
  install correctly" below).

- **macOS: `npm install -g corepack` says "permission denied" / EACCES:** Node from nodejs.org keeps its global
  packages in a folder only an administrator may change. Run `sudo npm install -g corepack` and type your Mac password.
- **Windows: `npm install -g corepack` or `corepack enable` says "permission denied" / EPERM:** open PowerShell as
  administrator once for that line.
- **`pnpm dev` says "Electron failed to install correctly":** the Electron download during `pnpm install` didn't finish
  (network, antivirus), or a pnpm other than the project's ran it.
  1. Run `node apps/desktop/node_modules/electron/install.js` (Windows:
     `node apps\desktop\node_modules\electron\install.js`).
  2. Run `pnpm dev` again.

  `pnpm --version` should say the version in `package.json` ("packageManager"); a different one means
  `corepack enable` didn't take.

- **`does not provide an export named 'BrowserWindow'`:** your terminal has `ELECTRON_RUN_AS_NODE=1` set (some editors
  do that). Clear it, then run `pnpm dev` again:
  - macOS: `unset ELECTRON_RUN_AS_NODE`
  - PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`

## Commands

Run them inside `third-wheel/`.

```sh
pnpm dev                 # start the desktop app (Electron + Vite, hot reload)
pnpm dev:open <file>     # same, and open that model at start (no file = the last one)
pnpm build               # production build of the desktop app (apps/desktop/out) + MCP server
pnpm lint                # ESLint (type-aware) + Prettier format check
pnpm format              # auto-format with Prettier
pnpm test                # run all Vitest tests once
pnpm test:watch          # Vitest in watch mode
pnpm test:e2e            # build, then Playwright tests of the Electron app (-g "<test name>" for one)
pnpm typecheck           # tsc -b across all packages
pnpm dist                # build + installer for this OS in apps/desktop/release, emptied first (macOS: universal .dmg, Windows: .exe)
pnpm notices             # regenerate apps/desktop/resources/THIRD_PARTY_NOTICES.txt (after changing dependencies)
```

**CI** (`.github/workflows/ci.yml`) runs lint, typecheck and tests on Windows and macOS for every push to `main` and
every pull request.

### End-to-end tests

The e2e app stays out of your way:

- Its window is transparent and click-through, never comes to the front and has no Dock icon (macOS). Playwright
  drives it from inside.
- It quits by itself within seconds when the test runner that started it is gone (even killed hard).
- To watch a run, set `THIRD_WHEEL_E2E_VISIBLE=1`.

### Chat loop driver

Not a test. After `pnpm build`, run:

```sh
node apps/desktop/e2e/chat-loop-drive.js <out-folder>
```

It starts the built app and the built MCP server, and plays the agent with a scripted MCP client (idle wait, message,
progress, answer, queued messages, cancelled wait, re-delivery to a new session). It prints the chat view and the debug
log's events. The e2e test "Chat" walks the chat panel's states the same way.

### Third-party notices

`pnpm notices` lists every package shipped at run time with its licence text: the production dependencies of the
workspace packages (followed through `node_modules`) plus Electron. About → Third-party licences shows it.

- A unit test fails when the file is out of date.
- A package without a licence file needs an entry in `SPECIAL` in `scripts/third-party-notices.js`, written from its
  README (see `occt-wasm`).

## Layout

| Folder                | What's in it                                                 |
| --------------------- | ------------------------------------------------------------ |
| `apps/desktop`        | Electron main + renderer                                     |
| `packages/core`       | project + notes schema (reads old sidecars), bridge protocol |
| `packages/geometry`   | STEP / STL / 3MF import, review payload, revision transfer   |
| `packages/mcp-server` | MCP server                                                   |

These are the workspace packages, all named `@third-wheel/*`.

**[Code map](code-map.md): one line per source file.** Keep it in sync when you add, move or split a file.

- **Start-up code:** the window's and the main process's start-up code is split by area into `wiring/` modules, started
  in order by their entry file (`renderer/src/main.ts`, `main/index.ts`).
- **E2E tests:** one spec file per area, each starting its own app copy.
- **Design notes** in `docs/`: [file format](file-format.md), [MCP tools](mcp-tools.md), [ADRs](adr/).
- **App icons:** `assets/icons/` (copies used by the app in `apps/desktop/resources/`).
- **Set up your AI agent** pop-up tabs: one description file per agent in `apps/desktop/agents/`
  ([adding an agent](adding-an-agent.md)). Tabs nobody tried with the real agent (`"tested": null`) show only with
  `THIRD_WHEEL_SHOW_UNTESTED=1 pnpm dev`.

## Test models

All test models are our own and live in the repo.

| File                                          | What it is                                                                                                                                                      |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/geometry/test-data/revisions/`      | The test bracket (`base.step`) and its revisions (`01-fillet.step` …), made by `node packages/geometry/scripts/make-revision-set.js`.                           |
| `packages/geometry/test-data/bracket.stl`     | The bracket as an STL, for mesh-only mode.                                                                                                                      |
| `docs/beta/bracket.step`                      | A copy of `base.step`.                                                                                                                                          |
| `test-models/bracket.step`, `bracket_v2.step` | For trying things by hand: copies of `base.step` and `01-fillet.step`. The notes the app writes next to them are git-ignored.                                   |
| `test-models/square-wheel/`                   | Third Wheel's own test model ([below](#square-wheel-model)).                                                                                                    |
| `synthetic-1M.step`                           | ≈ 1M triangles, for speed checks. Not stored: `node packages/geometry/scripts/make-large-step.js` builds it into `test-models/` (a minute or two; git-ignored). |

`THIRD_WHEEL_SAMPLES=1 pnpm test packages/geometry` checks every STEP directly in `test-models/`, or in the folder named
by `THIRD_WHEEL_SAMPLES_DIR` (e.g. `test-models/square-wheel`). Subfolders are not searched.

### Square wheel model

`test-models/square-wheel/` holds:

- the logo's square wheel as a 30 mm cube (two robot faces, tolerance holes, countersink, sphere dimple, wavy B-spline
  top, antennas);
- the round "third wheel" with a pin.

It is made in code with [build123d](https://github.com/gumyr/build123d) by `square_wheel.py`, which writes:

- `square-wheel.step` (two bodies);
- `square-wheel.stl` (mesh-only mode);
- `square-wheel_v2.step` (a revision: looser pin, left eye moved up, smile removed).

To change it, set up Python once (3.10–3.13; on Apple Silicon use a native arm64 Python) and run the script:

```sh
# macOS
python3 -m venv ~/.venvs/third-wheel-cad
~/.venvs/third-wheel-cad/bin/pip install build123d
~/.venvs/third-wheel-cad/bin/python test-models/square-wheel/square_wheel.py
```

```powershell
# Windows (PowerShell)
py -m venv $env:USERPROFILE\.venvs\third-wheel-cad
& $env:USERPROFILE\.venvs\third-wheel-cad\Scripts\pip install build123d
& $env:USERPROFILE\.venvs\third-wheel-cad\Scripts\python test-models\square-wheel\square_wheel.py
```

- `python square_wheel.py <folder> <name>` writes only `<folder>/<name>.step` (handy for review rounds outside the
  repo).
- Add `--print` for a print-ready layout (parts flat on the bed, sturdier antennas, looser pin).
- A rerun can write the colours in a different order (new file hash, same shape): commit regenerated files only when the
  model changed.

## Installers and releases

`pnpm dist` packages the app with electron-builder (`apps/desktop/electron-builder.yml`). On a Mac,
`pnpm --filter @third-wheel/desktop exec electron-builder --win` builds the Windows installer too.

What the package contains:

- Everything the app runs is bundled by electron-vite, so the package has no `node_modules`.
- `<resources>/` holds `mcp/third-wheel-mcp.js` (the MCP server, run by the app's own executable with
  `ELECTRON_RUN_AS_NODE=1`) and `THIRD_PARTY_NOTICES.txt`.
- The OpenCascade `.wasm` stays a plain file in `app.asar.unpacked/` (LGPL-2.1: users can swap it).

The installed app keeps its settings in the same folder as a dev build (`@third-wheel/desktop`), so the two can't run at
the same time. Installers are not signed: the README explains the first-start warning.

### Release

1. Set `version` in `apps/desktop/package.json`. For a new minor version, also update the "Early version" note at the
   top of the README: its version and what it says the app does today.
2. In `CHANGELOG.md`, replace "unreleased" in the new version's heading with today's date.
3. Commit.
4. Run `git tag v<version>` and `git push origin v<version>`.
5. The Release workflow (`.github/workflows/release.yml`) builds the macOS `.dmg` and Windows `.exe` and attaches them
   to a **draft** GitHub Release. Paste the version's `CHANGELOG.md` section as its notes, check it and click
   **Publish**.

**Actions → Release → Run workflow** builds the same installers as downloadable test files without a release.

## Demo GIF

`docs/images/demo.gif` is recorded by `scripts/demo/record-demo.js` (drives the built app through the MCP server;
captures the app's page only) and encoded by `scripts/demo/encode-gif.js`. See the comments at the top of each file.

## Parts library catalogue

The Library panel (toolbar) lists the parts of [bd_warehouse](https://github.com/gumyr/bd_warehouse) with a
picture of each. The list and the low-polygon preview meshes are **generated data** shipped with the app in
`apps/desktop/src/renderer/src/library/data/` (see the README there for the files and the licences). They are
not built at run time and not part of `pnpm build`; regenerate them when bd_warehouse changes:

```sh
uv venv --python 3.12 .venv-library
uv pip install --python .venv-library/Scripts/python.exe -r scripts/library/requirements.txt   # macOS / Linux: bin/python
.venv-library/Scripts/python.exe scripts/library/generate_catalogue.py
```

Then check that every size the catalogue offers can really be built (bd_warehouse 0.4.0 lists ASME `#0`, `#1`
and `#2` screws but raises `KeyError` when building them; the generator leaves such sizes out and writes them to
`unbuildable.json`):

```sh
.venv-library/Scripts/python.exe scripts/library/verify_catalogue.py   # exit 1 lists any size that cannot be built; about 4 minutes
```

### Scripts for the user's AI

`scripts/ai/restore_step_names.py` puts the body names and nesting of an earlier STEP onto a new export (a build123d
round trip drops them); `docs/recipes.md` explains when to use it. Self-test (needs build123d, e.g. the
`.venv-library`): `.venv-library/Scripts/python.exe scripts/ai/selftest_restore_step_names.py`. Run it when build123d
changes (it is part of the update checklist below).

### Updating bd_warehouse / build123d (checklist)

The catalogue depends on exact library versions (`scripts/library/requirements.txt`): class names, which standards and
sizes exist, which sizes can be built, the parameters, and how build123d writes STEP files. Do all of this whenever
either version changes, in one pull request:

1. Change the pins in `scripts/library/requirements.txt`, recreate `.venv-library` from it.
2. `generate_catalogue.py`: it must still build all classes (`report.json`; `PlasticBottleThreadMatch` is expected to
   fail). A class that is new, renamed or removed is listed in `MODULES` and `KEYWORDS` by hand: add search words
   (English and Chinese) and check its defaults (`DEFAULTS`).
3. `verify_catalogue.py` must exit 0 (every offered size builds).
4. Read the diff of `catalogue.json`, `report.json` and `unbuildable.json`: sizes that appeared (a bug fixed upstream
   makes a size buildable again), sizes that went away or newly fail, changed standards or parameter names. Tell
   people if sizes they may have used disappeared.
5. If build123d changed: re-run the things AIs depend on: `scripts/ai/selftest_restore_step_names.py` must pass, and check
   how STEP export writes body names and nesting (see "Keeping the user's body names" in `docs/mcp-tools.md`),
   `import_step` behaviour, the `simple` flag and thread solids.
6. `pnpm test` (`library/data.test.ts` fails while the catalogue and the pins disagree), `pnpm test:e2e`.
7. Run `pnpm notices`: the third-party licence list (`THIRD_PARTY_NOTICES.txt`) credits bd_warehouse and build123d at the
   pinned versions (their licence files are copied into `scripts/licences/`; copy the new ones if the licence or the
   NOTICE changed), and update the note in `library/data/README.md`. `pnpm test` fails while the list is out of date.

`pnpm test` has a unit test over the shipped data (`library/data.test.ts`) that fails if a known unbuildable size
is offered again. Read the diff of `catalogue.json` and `report.json` (a class that stopped building shows up there). The defaults a
preview is built with are in the script (`DEFAULTS`); they are chosen by hand.
