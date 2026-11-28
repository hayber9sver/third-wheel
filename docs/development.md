# Third Wheel development

Back to the [README](../README.md). For using the app, see the [user guide](user-guide.md). To send a change, see
[Contributing](../CONTRIBUTING.md).

## Build from source

You need **Node.js 22 or 24** (the "LTS" version from [nodejs.org](https://nodejs.org); Node 25 and newer no longer ship
Corepack, which this project uses) and **Git** (macOS: run `git --version` in Terminal and accept the install offer;
Windows: [git-scm.com](https://git-scm.com/download/win)).

Open **Terminal** (macOS) or **PowerShell** (Windows) and run, one line at a time:

```sh
git clone https://github.com/XiLaoTr/third-wheel.git
cd third-wheel
corepack enable          # once per computer; gives you the right pnpm version
pnpm install             # downloads everything the app needs (a few minutes)
pnpm build               # builds the app and the MCP server for your AI agent
pnpm dev                 # starts the app
```

Next time, `cd third-wheel` and `pnpm dev` are enough. To update: `git pull`, `pnpm install`, `pnpm build`.
Then [connect Claude Code](user-guide.md#connect-claude-code).

### If something goes wrong

- **`corepack` "is not recognized" / "command not found"** — your Node is 25 or newer, which no longer includes Corepack.
  Install Node **24 LTS** from [nodejs.org](https://nodejs.org) (or run `npm install -g corepack` once), open a new
  terminal, then `corepack enable` again. Don't install pnpm by hand instead: another pnpm version can skip the
  Electron download (next point).
- **Windows: `corepack enable` says "permission denied" / EPERM** — open PowerShell as administrator once for that line.
- **`pnpm dev` says "Electron failed to install correctly"** — the Electron download during `pnpm install` didn't
  finish (network, antivirus) or a pnpm other than the project's ran it. Run `node apps/desktop/node_modules/electron/install.js` (Windows:
  `node apps\desktop\node_modules\electron\install.js`), then `pnpm dev` again. `pnpm --version` should say the version
  in `package.json` ("packageManager"); a different one means `corepack enable` didn't take.
- **`does not provide an export named 'BrowserWindow'`** — your terminal has `ELECTRON_RUN_AS_NODE=1` set (some editors
  do that). macOS: `unset ELECTRON_RUN_AS_NODE`; PowerShell: `Remove-Item Env:ELECTRON_RUN_AS_NODE`. Then `pnpm dev` again.

## Commands

```sh
pnpm dev                 # start the desktop app (Electron + Vite, hot reload)
pnpm dev:open <file>     # same, and open that model at start (no file = the last one)
pnpm build               # production build of the desktop app (apps/desktop/out) + MCP server
pnpm lint                # ESLint (type-aware) + Prettier format check
pnpm format              # auto-format with Prettier
pnpm test                # run all Vitest tests once
pnpm test:watch          # Vitest in watch mode
pnpm test:e2e            # build, then Playwright smoke tests of the Electron app
pnpm typecheck           # tsc -b across all packages
pnpm dist                # build + installer for this OS in apps/desktop/release (macOS: universal .dmg, Windows: .exe)
pnpm notices             # regenerate apps/desktop/resources/THIRD_PARTY_NOTICES.txt (after changing dependencies)
```

`pnpm notices` lists every package shipped at run time (production dependencies of the workspace packages, followed
through `node_modules`, plus Electron) with its licence text; About → Third-party licences shows it. A unit test fails
when the file is out of date. A package without a licence file needs an entry in `SPECIAL` in
`scripts/third-party-notices.js` (written from its README — see `occt-wasm`).

CI (`.github/workflows/ci.yml`) runs lint, typecheck and tests on Windows and macOS for every push to `main` and every
pull request.

## Installers and releases

`pnpm dist` packages the app with electron-builder (`apps/desktop/electron-builder.yml`). On a Mac,
`pnpm --filter @third-wheel/desktop exec electron-builder --win` builds the Windows installer too.
Everything the app runs is bundled by electron-vite, so the package has no `node_modules`; `<resources>/` holds
`mcp/third-wheel-mcp.js` (the MCP server, run by the app's own executable with `ELECTRON_RUN_AS_NODE=1`) and
`THIRD_PARTY_NOTICES.txt`. The OpenCascade `.wasm` stays a plain file in `app.asar.unpacked/` (LGPL-2.1: users can swap it).
The installed app keeps its settings in the same folder as a dev build (`@third-wheel/desktop`), so the two can't run at
the same time. Not signed: the README explains the first-start warning.

**Release:** set `version` in `apps/desktop/package.json` (for a new minor version also update the "Early version" note
at the top of the README: its version, and "Coming next" once that has shipped), commit, then `git tag v<version>` and
`git push origin v<version>`.
The Release workflow (`.github/workflows/release.yml`) builds the macOS `.dmg` and Windows `.exe` and attaches them to a
**draft** GitHub Release; check it and click **Publish**. **Actions → Release → Run workflow** builds the same installers
as downloadable test files without a release.

## Test models

All test models are our own and live in the repo:

- `packages/geometry/test-data/revisions/` — the test bracket (`base.step`) and its revisions (`01-fillet.step` …),
  made by `node packages/geometry/scripts/make-revision-set.js`. `docs/beta/bracket.step` is a copy of `base.step`.
- `packages/geometry/test-data/bracket.stl` — the bracket as an STL, for mesh-only mode.
- `synthetic-1M.step` (≈ 1M triangles, for speed checks) is not stored: `node packages/geometry/scripts/make-large-step.js`
  builds it into `test-models/` (a minute or two; git-ignored).

For trying things by hand, `test-models/` has `bracket.step` and `bracket_v2.step` (copies of `base.step` and
`01-fillet.step`); the notes the app writes next to them are git-ignored. `THIRD_WHEEL_SAMPLES=1 pnpm test packages/geometry`
checks every STEP in `test-models/` (or in the folder named by `THIRD_WHEEL_SAMPLES_DIR`).

## Demo GIF

`docs/images/demo.gif` is recorded by `scripts/demo/record-demo.js` (drives the built app through the MCP server; captures
the app's page only) and encoded by `scripts/demo/encode-gif.js` — see the comments at the top of each file.

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

## Layout

Workspace: `apps/desktop` (Electron main + renderer), `packages/core` (schema, sidecar, bridge protocol),
`packages/geometry` (STEP / STL / 3MF import, review payload, revision transfer), `packages/mcp-server` (all `@third-wheel/*`).
Design notes in `docs/`: [file format](file-format.md), [MCP tools](mcp-tools.md), [ADRs](adr/).
App icons: `assets/icons/` (copies used by the app in `apps/desktop/resources/`).
