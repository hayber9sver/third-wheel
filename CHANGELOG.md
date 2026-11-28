# Changelog

What changed in each version of Third Wheel. Downloads: [Releases](https://github.com/XiLaoTr/third-wheel/releases).

## 0.2.0 — 2026-11-25

**Third Wheel now has a chat with your AI agent built in.** Mark spots on the model and ask about them in the
**Agent** tab; the agent answers under each comment. Agree on a change, and the next version opens with your notes
moved over.

Third Wheel has no CAD inside. Your agent builds and changes the part in your own CAD (Fusion, FreeCAD, SolidWorks,
CadQuery, build123d …) and exports STEP. Third Wheel is where you look at it and point at what you mean.

### Added

- **Agent tab** (next to **Bodies**): write to the agent you started in your terminal (Claude Code, Codex, Gemini CLI,
  Copilot CLI).
  - You see its progress, its answers, and **↳ Replied under #n** links to the comments it answered.
  - Topics and history are saved with the project.
  - A new agent session gets a short catch-up, not the whole conversation.
- **Replies under a comment:** while your agent listens in the **Agent** tab, they reach it at once.
- **Projects:** one project per folder. Your notes go in a `.thirdwheel` folder next to your models. Model files are
  never changed or copied.
- **Parts:** a project can hold several parts (e.g. a box and its lid).
  - Toolbar: **Open folder** · **Add file** · **Parts ▾** · **Versions ▾**.
  - **↔ Part ▾** links a comment to another part.
  - Third Wheel asks when a "new version" looks like a different part.
- **Dimensions in the view:** select a hole, an edge or two faces to see the size on the model.
- **Edge chains:** double-click an edge to select the whole smooth chain (e.g. around a fillet).
- **Help ▸ Send feedback…:** a short private form or a GitHub issue.
- **Set up your AI agent…:** one tab per agent (new: Copilot CLI).
  - **Chat in Third Wheel** steps for the agents that can listen in the **Agent** tab.
  - **Ask fewer permission questions** for Claude Code.
- **Square Wheel cube:** [Third Wheel's own test model](test-models/square-wheel/), with a second version.

### Changed

- **Send to AI** is now **Send review**. It sends all your new comments at once, for when you'd rather go through the
  whole model first.
- **Connect an AI agent…** is now **Set up your AI agent…**.
- **Your notes move once, one way.** The first time you open a model with 0.2.0, its old `<model>.thirdwheel.json`
  notes move into the project's `.thirdwheel/` folder. The old file is left as it was; version 0.1 only sees the notes
  from before the move.
- Marker names are unique in a project, so you and the agent always mean the same marker.
- Closing the last comment on a marker resolves the marker.
- Text from model files is cleaned before the agent reads it.

### Fixed

- Markers now move to the new version of a part whose sides are near mirror images. Before, they could be flagged as
  mirrored.
- The view now turns around the model's centre when the left panel is open.
- Toolbar labels now fit at 175 % display scaling on Windows.

**Note:** the installers are still unsigned, so the first start shows a warning (see the [README](README.md#download)).

## 0.1.0 — 2026-11-14

First public version.

- Open a STEP file and see it like in a CAD tool: hovering highlights vertices, edges, faces and bodies.
- Mark spots with **Select**, **Brush** and **Smart fill**, and write comments on the markers.
- **Send to AI**: your AI agent (e.g. Claude Code) reads, through Third Wheel's MCP server, exactly which faces and
  edges you marked. It can answer and mark comments fixed.
- New versions open with your notes carried over and the agent's answers next to them. **Versions ▾** compares them.
- STL and 3MF files open too, with paint and comments only.
- Installers for macOS and Windows, and one-click connection to Claude Code.
