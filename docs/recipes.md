# Recipes for an AI that edits the model

For an AI connected through the MCP tools (`docs/mcp-tools.md`) that changes the user's CAD with build123d /
bd_warehouse. Each recipe was run against the real app. Units are mm.

## 0. Start of a session

Call `get_open_model`: it gives the `modelId` and the file `path` of what the user has open, and how many comments
wait. Then `get_annotations` with that `modelId`. Write the next version **beside** the file under a new name
(`part.step` → `part_v2.step`), never over it.

## 0b. Recommend a library part

When the user asks what to use ("how do I fasten these", "a seal for this", "找一個軸承"), call `search_parts` with
their words instead of answering from memory: it searches the catalogue the app ships (the same one as the Library
panel), so the classes exist and every size listed can be built. Then `search_parts` with `cls` for the full
standards and sizes of the one you suggest. Tell the user which to add in the Library panel (Add to request), or
build it yourself, and respect what they fixed in `params`.

## 1. Keep the user's names (do this every time)

The Bodies list shows the names inside the STEP file. build123d's `import_step`, boolean results and
`export_step` drop them: the user then sees `SOLID` / `COMPOUND` / `=>[0:1:1:2]` and no folders. After exporting
the new version run:

```sh
python scripts/ai/restore_step_names.py part.step part_v2.step part_v2_named.step
```

(from the Third Wheel repository; needs the build123d you edit with). Every solid of the old file is matched to a
solid of the new one by its bounding box (holes, fillets and pockets do not change it) and gets its old name; the
old nesting is rebuilt; parts you added keep their own labels; parts you removed are left out. Then `load_model`
`part_v2_named.step` with `revisionOf` = the previous `modelId`. `load_model` answers with `namesLost` when most of
the old custom names are still missing. Self-test: `python scripts/ai/selftest_restore_step_names.py`.

Or set `.label` yourself on every solid you export and keep `Compound(label=…, children=[…])` nesting.

## 2. Put a library part at a hole

A comment with `parts[]` asks for it (`docs/mcp-tools.md`, "Part requests"). The marker's hole entity in the
payload gives `type: "cylinder"`, `form: "hole"`, `radius`, `point` (a point on the axis), `dir` (the axis) and
`area`; the depth is `area / (2 · π · radius)` (the payload gives the area, not the depth). Pick the size from the
part's `params` if the user fixed one; otherwise from the hole (the biggest metric size whose clearance hole, ISO 273
normal fit, fits: M3 3.4, M4 4.5, M5 5.5, M6 6.6, M8 9.0 mm).

```python
import bd_warehouse.fastener as F
from build123d import Pos

screw = F.SocketHeadCapScrew(size="M5-0.8", length=16, fastener_type="iso4762", simple=True)  # simple=False = real thread
nut = F.HexNut(size="M5-0.8", fastener_type="iso4032", simple=True)
# A fastener's origin is at its bearing surface (head underside) and the shaft points -Z: put the head on the
# +Z end of the hole, the nut on the other end (print bounding_box() to check for your axis).
```

- `simple` defaults to **True = no thread**. `params.simple == false` means the user asked for a real thread; it makes
  the part ~20 solids (a folder in the Bodies list).
- Use only sizes the catalogue offered (`params.size`); bd_warehouse 0.4.0 lists ASME `#0`, `#1`, `#2` screws but
  cannot build them (`KeyError`). If a size fails, say so with `partResults` (`failed` / `needs-info`) and ask in the
  comment thread instead of guessing.
- Name the new solids (`s.label = "Screw M5-0.8x16 (Hole 1)"`) and report them in `partResults[].bodies`.

## 3. Cut a hole or pocket that fits a library part

Build the part, take its cross-section or the part itself as the tool, move it to the marker, and subtract with
clearance: `plate = plate - (Pos(x, y, z) * tool)`. For "just big enough for it" use 0.1–0.2 mm per side unless the
user says otherwise. The cut does not change the plate's bounding box, so recipe 1 still matches it by size.

## 4. Report back

Per requested part: `set_comment_status` (done) or `reply_to_comment` (a question) with
`partResults: [{ partId, status: placed | skipped | failed | needs-info, bodies?, note? }]`. When the part's
`source.version` differs from your installed bd_warehouse, check that the size still builds and say so.
