# Contributing to Third Wheel

Thanks for helping! Bug reports, ideas and code are all welcome.

## Report a bug or suggest an idea

Open an [issue](https://github.com/XiLaoTr/third-wheel/issues). Helpful to include:

- your OS and the app version (**About Third Wheel**),
- the AI agent and model you used,
- the steps that led to the problem, and a screenshot.

If it is about a model, a small STEP / STL file and its notes help a lot. The notes are the `.thirdwheel` folder next
to the model: zip it, without its `chats` folder. Only attach files you are allowed to share: issues are public.

## Change the code

1. For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time
   on it. Interaction follows the conventions of common CAD tools and slicers (Fusion, Onshape, SolidWorks, OrcaSlicer):
   check how they do it before proposing something new.
2. [Build from source](docs/development.md#build-from-source) and read the [project layout](docs/development.md#layout).
3. Before you open a pull request, run `pnpm lint`, `pnpm typecheck` and `pnpm test` (all green) and add or update tests
   for what you changed.
4. Keep each pull request to one change and say how you checked it (which OS, which model file).

A few project rules:

- **macOS and Windows** are both first-class: shortcuts use Cmd on Mac / Ctrl on Windows, file paths go
  through Node's `path`, and OS-specific code handles both.
- Only `packages/geometry` uses the CAD kernel (`occt-wasm`); everything else uses its results.
- **File format changes** (anything in `packages/core/src/project-schema.ts` or `schema.ts`) need three things in the
  same pull request: a migration from the previous `schemaVersion` (old files must keep opening, and are never rewritten
  in their old form), an update of [docs/file-format.md](docs/file-format.md), and a test fixture of an old file that
  still loads. New optional fields need no new `schemaVersion`; readers keep fields they don't know, so never remove
  that behaviour. Changes that older apps would misread raise `schemaVersion`.
- No new runtime dependency without saying why in the pull request. After changing dependencies, run `pnpm notices`
  (a test fails when the list of third-party licences is out of date, or when a dependency the app ships is not under
  MIT, Apache-2.0, BSD, ISC or 0BSD).

## Add an AI agent

Each tab of the app's **Set up your AI agent** pop-up is one small description file; adding an agent needs no code. See
[Adding an AI agent](docs/adding-an-agent.md): copy a file, fill it in, try it with the real agent, open a pull request.

## Sign off your commits (DCO)

Every commit needs a `Signed-off-by` line. With it you confirm the
[Developer Certificate of Origin](https://developercertificate.org/): that you wrote the change, or otherwise have the
right to submit it under this project's licence.

```sh
git commit -s -m "Fix hover on small edges"   # -s adds "Signed-off-by: Your Name <your@email>"
```

The name and email come from your git settings and should match the commit author (GitHub's `noreply` address is
fine if you want to keep your email private). A check on each pull request shows whether a sign-off is missing.

Forgot it?

- **Last commit:** `git commit --amend --no-edit -s`
- **All commits of your branch:** `git rebase --signoff HEAD~3` (put the number of your commits in place of 3). If you
  merged `main` into your branch, e.g. with **Update branch**, ask in the pull request instead.
- **Already pushed?** Then push again with `git push --force-with-lease`. A plain `git push` is refused; don't
  `git pull` first, that brings the unsigned commits back.

## AI-assisted contributions

Welcome: this app itself was written with an AI coding agent (see the [README](README.md)). However your change was
written, you are responsible for it: run and test it, understand it well enough to answer review questions, and make
sure it contains no code you don't have the right to share (AI tools can reproduce existing code). Your sign-off covers
this too.

## Licence

Third Wheel is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the same licence
(Apache 2.0, section 5): you keep the copyright of your work and license it to the project and to everyone else on the
same terms.

**No GPL or AGPL code.** Don't copy in code, libraries or examples under GPL or AGPL (for example code from OpenSCAD
or from OpenSCAD libraries under GPL — check each library's licence), and don't add dependencies under those licences:
the app could no longer be shipped under Apache 2.0. The one LGPL part, the OpenCascade kernel inside `occt-wasm`,
stays a separate `.wasm` file loaded at run time. Unsure about a licence? Ask in the pull request first.
