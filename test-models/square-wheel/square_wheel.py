"""Square Wheel cube: Third Wheel's own test model.

The logo's teal square wheel as a 30 mm calibration cube, plus the round white "third wheel"
whose pin sits in one of the cube's side holes. It has the kinds of faces the app must handle:
planes, cylinders (holes, pin), cones (countersink, chamfers), spheres (dimples), a torus
(the wheel's rounded rim) and B-spline (the wavy top).

Writes, next to this script:
  square-wheel.step     both bodies ("Square wheel", "Third wheel")
  square-wheel.stl      the same, as a mesh (mesh-only mode)
  square-wheel_v2.step  the revision: looser pin (changed), left eye moved up (moved),
                        smile removed (lost)

Run:  python square_wheel.py                        all three files above
      python square_wheel.py <folder> <name> [--print] [--loose-pin]
          only <folder>/<name>.step; --print = print-ready layout (parts flat on the bed,
          sturdier antennas, looser pin); --loose-pin = the first version with only the pin
          changed as in v2 (the README demo's second version)
Needs build123d; see docs/development.md.
Units: mm. Z is up, the cube's face with the eyes looks towards -Y.
"""

import math
from datetime import datetime, timezone
from pathlib import Path

from build123d import (
    Align,
    Axis,
    Box,
    Color,
    Compound,
    Cone,
    Cylinder,
    Face,
    Location,
    Plane,
    Pos,
    Rot,
    Part,
    Sphere,
    SlotArc,
    SlotCenterToCenter,
    CenterArc,
    chamfer,
    export_step,
    export_stl,
    extrude,
    fillet,
)

OUT = Path(__file__).resolve().parent
TIMESTAMP = datetime(2026, 1, 1, tzinfo=timezone.utc)  # fixed: same file on every run

SIZE = 30.0  # cube edge
EDGE_R = 3.0  # rounded vertical edges
TOP_CHAMFER = 1.0
WAVE = 1.2  # wavy top: height of the waves

# Right side (+X): three tolerance holes in 0.1 mm steps; the wheel's pin sits in the middle one.
TOL_HOLES = [(-10.0, 6.0, 5.0), (0.0, 15.0, 5.1), (10.0, 6.0, 5.2)]  # (y, z, diameter)
TOL_DEPTH = 5.0  # shallow enough to stay clear of the eye holes
PIN_HOLE = TOL_HOLES[1]

WHEEL_D = 20.0
WHEEL_T = 6.0
WHEEL_RIM_R = 2.0
WHEEL_GAP = 1.0  # between cube side and wheel
ANTENNA_Y = 12.0  # antennas sit this far in front of / behind the centre
PIN_LEN = 4.5  # 3.5 mm of it sits in the hole


def cube(v2: bool, printable: bool = False) -> Part:
    h = SIZE / 2
    body = Box(SIZE, SIZE, SIZE + 2, align=(Align.CENTER, Align.CENTER, Align.MIN))
    body = fillet(body.edges().filter_by(Axis.Z), EDGE_R)

    # Wavy top (B-spline): cut away everything above a gently waving surface near z = SIZE.
    n = 13
    pts = [
        [
            (
                -h - 2 + i * (SIZE + 4) / (n - 1),
                -h - 2 + j * (SIZE + 4) / (n - 1),
                SIZE - _wave(-h - 2 + i * (SIZE + 4) / (n - 1)),
            )
            for j in range(n)
        ]
        for i in range(n)
    ]
    top = Face.make_surface_from_array_of_points(pts)
    above = extrude(top, amount=5, dir=(0, 0, 1))
    body = body - above
    body = chamfer(body.edges().group_by(Axis.Z)[-1], TOP_CHAMFER)

    front = Plane.XZ.offset(h)  # on the front face, local y = global Z, normal towards -Y

    # Eyes: two through holes, slightly different diameters. In v2 the left eye moved up 2 mm.
    left_z = 20.0 if v2 else 18.0
    for x, z, d in [(-6.0, left_z, 6.0), (6.0, 18.0, 6.5)]:
        body -= Pos(x, 0, z) * Rot(90, 0, 0) * Cylinder(d / 2, SIZE + 2)

    # Smile: an arc groove with chamfered edges (removed in v2).
    if not v2:
        arc = CenterArc((0, 15.0), 8.0, 225, 90)
        groove = extrude(front * SlotArc(arc, 2.4), amount=-1.6)
        body -= groove
        smile_edges = body.edges().filter_by_position(Axis.Y, -h - 0.01, -h + 0.01).filter_by(
            lambda e: _near_smile(e)
        )
        body = chamfer(smile_edges, 0.4)

    # Right side (+X): tolerance holes.
    for y, z, d in TOL_HOLES:
        body -= Pos(h - TOL_DEPTH / 2, y, z) * Rot(0, 90, 0) * Cylinder(d / 2, TOL_DEPTH)

    # Left side (-X): countersunk hole (cone) above a sphere dimple, one above the other.
    body -= Pos(-h + 2.5, 0, 21.0) * Rot(0, 90, 0) * Cylinder(1.7, 5)  # clear of the left eye
    body -= Pos(-h, 0, 21.0) * Rot(0, 90, 0) * Cone(3.5, 0, 3.5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    body -= Pos(-h - 2.0, 0, 9.0) * Rot(0, 90, 0) * Sphere(4.5)

    # Back (+Y): the second robot's face. Its eyes are the same through holes; its mouth is a
    # straight slot with chamfered edges.
    back = Plane(origin=(0, h, 0), x_dir=(-1, 0, 0), z_dir=(0, 1, 0))  # local y = global Z
    body -= extrude(back * Pos(0, 10.0) * SlotCenterToCenter(10, 2.4), amount=-1.6)
    mouth_edges = body.edges().filter_by_position(Axis.Y, h - 0.01, h + 0.01).filter_by(
        lambda e: abs(e.center().X) < 8 and 8 < e.center().Z < 12
    )
    body = chamfer(mouth_edges, 0.4)

    # One antenna per robot (front face, back face), on the top near its face: a rod with a
    # ball, like the logo's.
    for y in (-ANTENNA_Y, ANTENNA_Y):
        body += Pos(0, y, SIZE - 1) * Cylinder(1.25 if printable else 0.8, 7.5, align=(Align.CENTER, Align.CENTER, Align.MIN))
        body += Pos(0, y, SIZE + 6.5) * Sphere(1.75)

    return body


def wheel(v2: bool, printable: bool = False) -> Part:
    y, z, hole_d = PIN_HOLE
    disc = Cylinder(WHEEL_D / 2, WHEEL_T, align=(Align.CENTER, Align.CENTER, Align.MIN))
    if printable:
        # Lies on its outer face (the one with the eyes): chamfer that edge, round the other.
        disc = fillet(disc.edges().group_by(Axis.Z)[0], WHEEL_RIM_R)
        disc = chamfer(disc.edges().group_by(Axis.Z)[-1], 1.5)
    else:
        disc = fillet(disc.edges(), WHEEL_RIM_R)
    # Eye dimples on the outer face, like the logo's wheel.
    for ex, ey in [(-1.5, -2.5), (-1.5, 2.5)]:  # local -X is up after the turn below
        disc -= Pos(ex, ey, WHEEL_T + 0.8) * Sphere(1.6)
    # Pin: 0.1 mm smaller than its hole (a tight fit, on purpose for the v2 story); v2 and the
    # print layout use 0.25 mm, a usual clearance for FDM printing.
    pin_d = hole_d - (0.25 if v2 or printable else 0.1)
    pin = Pos(0, 0, -PIN_LEN) * Cylinder(pin_d / 2, PIN_LEN + 0.5, align=(Align.CENTER, Align.CENTER, Align.MIN))
    pin = chamfer(pin.edges().group_by(Axis.Z)[0], 0.4)
    w = disc + pin
    # Local +Z (outer face) points along +X; pin goes into the cube's middle side hole.
    if printable:  # flat on the bed next to the cube, pin up
        return Location((SIZE / 2 + 5 + WHEEL_D / 2, 0, WHEEL_T), (180, 0, 0)) * w
    return Location((SIZE / 2 + WHEEL_GAP, y, z), (0, 90, 0)) * w


def _wave(x: float) -> float:
    """Depth of the wavy top below z = SIZE: two gentle waves from left to right."""
    return WAVE * 0.5 * (1 - math.cos(2 * math.pi * x / (SIZE / 2)))


def _near_smile(edge) -> bool:
    c = edge.center()
    return abs(c.X) < 9 and 5 < c.Z < 13


def build(v2: bool, printable: bool = False, loose_pin: bool = False) -> Compound:
    c = cube(v2, printable)
    c.label = "Square wheel"
    c.color = Color(0x5CCDBE)
    w = wheel(v2 or loose_pin, printable)
    w.label = "Third wheel"
    w.color = Color(0xFFFFFF)
    return Compound(label="Square Wheel cube", children=[c, w])


if __name__ == "__main__":
    import sys

    # Optional: python square_wheel.py <folder> <name>  -> <folder>/<name>.step only (review rounds).
    # --print: the print-ready layout (parts flat on the bed, sturdier antennas, looser pin).
    # --loose-pin: only the pin changed as in v2 (the README demo's second version).
    printable = "--print" in sys.argv
    loose_pin = "--loose-pin" in sys.argv
    args = [a for a in sys.argv[1:] if a not in ("--print", "--loose-pin")]
    if (printable or loose_pin) and len(args) != 2:
        sys.exit("--print / --loose-pin need <folder> <name>")
    if len(args) == 2:
        export_step(
            build(False, printable, loose_pin), Path(args[0]) / f"{args[1]}.step", timestamp=TIMESTAMP
        )
        sys.exit(0)
    v1 = build(False)
    export_step(v1, OUT / "square-wheel.step", timestamp=TIMESTAMP)
    export_stl(v1, OUT / "square-wheel.stl", tolerance=0.02, angular_tolerance=0.2)
    export_step(build(True), OUT / "square-wheel_v2.step", timestamp=TIMESTAMP)
    for ch in v1.children:
        print(ch.label, "faces:", len(ch.faces()), "valid:", ch.is_valid)
