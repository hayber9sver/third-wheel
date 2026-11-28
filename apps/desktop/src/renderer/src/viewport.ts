/**
 * three.js viewport: Z-up scene with grid + axes, orbit/pan/zoom, render-on-demand, resize-aware.
 *
 * Why one file (~2,200 lines): one class that owns the scene, camera, renderers and pointer input,
 * and whose parts share that private state; the drawing pieces already live in their own modules
 * (highlighter, paint-overlay, pin-overlay, picker, region-render, view-cube …). Methods of
 * `Viewport`, in order: setup + theme · model, ghosts, compare, body visibility · camera framing
 * (setView / fitAll / frame…) · region pictures for the AI (renderRegion / renderContactSheet) ·
 * comment pins + dimensions · selection, tools, paint strokes + Smart fill · marker entities +
 * hover highlight · pointer input + box select · projection + camera moves · view cube ·
 * picking + hover · navigation style, resize, render loop · benchmarks.
 */
import type { StepModel } from '@third-wheel/geometry';
import {
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  MOUSE,
  Matrix4,
  PerspectiveCamera,
  Quaternion,
  Ray,
  Raycaster,
  Scene,
  Sphere,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { ResolvedTheme } from '../../shared/theme.js';
import {
  DEFAULT_NAVIGATION_STYLE,
  getNavigationStyle,
  leftDragNavigates,
  trackpadSwipeAction,
  type NavAction,
  type NavigationStyle,
  type OrbitStyle,
} from './navigation.js';
import { buildBodyBuffers, visibleRuns } from './body-buffers.js';
import { WheelClassifier } from './wheel.js';
import {
  bodyBoxes,
  boxCenter,
  easeInOut,
  fitDistance,
  fitInFreeArea,
  freeAreaShift,
  nearestScreenUp,
  orbitSetup,
  rollScreenUp,
  sphereOfBodies,
  standardScreenUp,
  Z_UP,
  type BoundingSphere,
  type Vec3,
} from './camera-views.js';
import { ViewCube } from './view-cube.js';
import { installFreeOrbit, screenUp, setOrbitAxis } from './free-orbit.js';
import { Picker } from './picker.js';
import {
  boxAction,
  boxLabel,
  boxMode,
  boxRect,
  boxSelectItems,
  visibleIds,
  type BoxAction,
  type BoxMode,
} from './box-select.js';
import {
  DEFAULT_FILTER,
  applyFilter,
  pickPassKinds,
  type SelectionFilter,
} from './selection-filter.js';
import type { EntityRef } from './pick-resolve.js';
import { Highlighter } from './highlighter.js';
import { MarkerEntitiesOverlay } from './marker-entities.js';
import type { ShownEntity } from './markers.js';
import { focusedEntities, focusedStyles } from './comment-focus.js';
import type { SelectionItem } from './selection.js';
import { pinSpots, type PinSpec } from './comment-pins.js';
import { DimensionOverlay, type DimensionSpec } from './dimension-overlay.js';
import { PinOverlay, type PlacedPin } from './pin-overlay.js';
import {
  BrushCursor,
  ERASE_COLOR,
  NO_MARKER_COLOR,
  SurfaceRaycaster,
  type BrushCursorState,
  type SurfaceHit,
} from './brush-cursor.js';
import { DEFAULT_BRUSH_RADIUS_MM, DEFAULT_TOOL, toolDef, type ToolId } from './tools.js';
import { PaintOverlay, type MarkerStyle } from './paint-overlay.js';
import { warmPaintCode, type PaintLayer, type PaintSphere } from './paint.js';
import { FillPreview } from './fill-preview.js';
import type { GhostShape } from './ghosts.js';
import { RevisionOverlay } from './revision-overlay.js';
import type { VersionDiff } from './version-diff.js';
import { encodePng, RegionRenderer } from './region-render.js';
import { chooseRegionDir } from './region-occlusion.js';
import { composeSheet, drawTileLabels, MAX_SHEET_REGIONS, sheetLayout } from './contact-sheet.js';
import {
  regionSamples,
  regionSize,
  regionView,
  regionViewDir,
  type RegionRequest,
  type RegionSamples,
  type RegionView,
} from './region-view.js';
import {
  DEFAULT_FILL_ANGLE_DEG,
  TriangleAdjacency,
  brushPatch,
  faceRegion,
  smartFill,
  type FillRegion,
} from './smart-fill.js';

/** Brush stamps along a stroke at most this far apart, as a fraction of the radius. */
const STROKE_SPACING = 0.5;
/** Extra stamps filled in between two frames of a fast stroke, at most. */
const MAX_STROKE_FILL = 32;
/** Alt + scroll: this much wheel delta (px) = one brush size step. */
const WHEEL_PX_PER_RADIUS_STEP = 50;

/**
 * A picked entity (after the selection filter) and the body it belongs to. `kind: 'body'` when the
 * filter turns a face into its whole body; then `id === body`.
 */
export interface PickHit extends SelectionItem {
  readonly body: number;
}

/** Pick radius, CSS px: vertices/edges this close to the cursor win over the face under it. */
const PICK_RADIUS = 6;

/** A press that moves less than this (CSS px) before release is a click, not a drag. */
const CLICK_SLOP_PX = 4;

interface Palette {
  bg: number;
  gridMajor: number;
  gridMinor: number;
  face: number;
  edge: number;
}

const PALETTE: Record<ResolvedTheme, Palette> = {
  light: { bg: 0xe9ebef, gridMajor: 0x9aa0aa, gridMinor: 0xcfd3da, face: 0xc3c8d0, edge: 0x1c1f24 },
  dark: { bg: 0x23262c, gridMajor: 0x5a606b, gridMinor: 0x353941, face: 0xaeb4bd, edge: 0x0d0f12 },
};

/** The shown model: one mesh + one line object for all bodies, grouped by body (body-buffers.ts). */
interface ModelView {
  readonly root: Group;
  readonly faces: Mesh<BufferGeometry, MeshStandardMaterial[]>;
  readonly edges: LineSegments<BufferGeometry, LineBasicMaterial[]>;
  readonly triStart: Uint32Array;
  readonly edgeStart: Uint32Array;
  /** Per-body bounding boxes (camera-views.ts `bodyBoxes`). */
  readonly boxes: Float64Array;
  /** Current visibility per body (missing = visible). */
  visible: readonly boolean[];
  /** The imported model (box select reads its geometry). */
  readonly source: StepModel;
  /** ID-buffer picking for this model (shares its GPU buffers). */
  readonly picker: Picker;
  /** Entity → body, from the StepModel. */
  readonly bodyOf: Readonly<Record<EntityRef['kind'], Uint32Array>>;
  /** Hover + selection highlight. */
  readonly highlighter: Highlighter;
  /** Entities held by markers, in their colours. */
  readonly markerEntities: MarkerEntitiesOverlay;
  /** Bounding sphere of the whole model (minimum zoom-to-selection size). */
  readonly radius: number;
  /** Surface point under the pointer for the brush tools (BVH built on first use). */
  readonly surface: SurfaceRaycaster;
  /** Paint drawn over the faces. */
  readonly paint: PaintOverlay;
  /** Body per import triangle. */
  readonly triBody: Uint32Array;
  /** Smart fill: hover preview and triangle neighbours (built in idle time or on first use). */
  readonly fillPreview: FillPreview;
  adjacency: TriangleAdjacency | undefined;
  /** Offscreen region pictures, built on first use. */
  regionRenderer: RegionRenderer | undefined;
}

/** A region picture: PNG + how it was taken, so the AI can read it. */
export interface RegionImage extends RegionCamera {
  readonly png: Uint8Array;
  /** Square size in px. */
  readonly size: number;
  /** Draw + read back, and PNG encoding, in ms. */
  readonly renderMs: number;
  readonly encodeMs: number;
}

/** How a region picture was taken, so the AI can read it. */
export interface RegionCamera {
  /** Unit direction from the region towards the camera (orthographic, looks along −dir). */
  readonly viewDir: Vec3;
  /** Unit world direction that is up in the picture. */
  readonly up: Vec3;
  /** World point at the picture's centre. */
  readonly center: Vec3;
  readonly mmPerPx: number;
  /** Bodies in front of the region, drawn faint and see-through; empty = none. */
  readonly ghosted: readonly GhostedBody[];
}

export interface GhostedBody {
  readonly body: number;
  readonly name: string;
}

function cameraFacts(shot: RegionShot, px: number): RegionCamera {
  const { view } = shot;
  return {
    viewDir: view.dir,
    up: view.up,
    center: view.target,
    mmPerPx: (2 * view.halfSize) / px,
    ghosted: shot.ghosted,
  };
}

interface RegionShot {
  readonly rgba: Uint8Array;
  readonly view: RegionView;
  readonly ghosted: readonly GhostedBody[];
}

/** One tile of a contact sheet. */
export interface ContactSheetTile extends RegionCamera {
  /** Label drawn in the tile's top-left corner (1…; no label when the sheet has one tile). */
  readonly number: number;
  /** Index of the request this tile shows. */
  readonly region: number;
  readonly markerIds: readonly string[];
  /** Top-left corner in the sheet and square size, px. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/** Several region pictures in one PNG. */
export interface ContactSheet {
  readonly png: Uint8Array;
  readonly width: number;
  readonly height: number;
  readonly tiles: readonly ContactSheetTile[];
  /** Request indices that showed nothing (unknown / empty markers). */
  readonly skipped: readonly number[];
  /** Draw + read back + compose, and PNG encoding, in ms. */
  readonly renderMs: number;
  readonly encodeMs: number;
}

/** A comment pin to show: its look + what it is anchored on. */
export interface CommentPinRequest {
  readonly spec: PinSpec;
  readonly items: readonly SelectionItem[];
  readonly triangles: ArrayLike<number>;
}

/** Camera pose: look-at target, unit direction target→camera, distance, picture's up (⟂ dir). */
interface CameraPose {
  readonly target: Vec3;
  readonly dir: Vec3;
  readonly distance: number;
  readonly screenUp: Vec3;
}

/** Camera rotation looking along −`dir` with `screenUp` up on screen. */
function lookRotation(dir: Vec3, screenUp: Vec3): Quaternion {
  const m = new Matrix4().lookAt(new Vector3(...dir), new Vector3(), new Vector3(...screenUp));
  return new Quaternion().setFromRotationMatrix(m);
}

/** Camera rest before comment pins hop to a visible spot, in ms. */
const PIN_SETTLE_MS = 150;

/** Duration of camera moves for preset views / fit, in ms. */
const CAMERA_MOVE_MS = 250;

const GRID_SIZE = 200; // mm
const GRID_DIVISIONS = 20;

const MOUSE_FOR: Record<NavAction, MOUSE | null> = {
  orbit: MOUSE.ROTATE,
  pan: MOUSE.PAN,
  none: null,
};

export class Viewport {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(45, 1, 0.1, 10_000);
  private readonly controls: OrbitControls;
  private readonly resizeObserver: ResizeObserver;
  /** CSS px of the view's left side the floating left panel covers (0 = folded / none). */
  private leftCover = 0;
  private grid: GridHelper | undefined;
  private model: ModelView | undefined;
  private theme: ResolvedTheme = 'light';
  private frameRequested = false;
  private disposed = false;
  private navStyle: NavigationStyle = getNavigationStyle(DEFAULT_NAVIGATION_STYLE);
  private orbitStyle: OrbitStyle = 'turntable';
  private readonly wheelClassifier = new WheelClassifier(navigator.userAgent.includes('Mac'));
  private readonly viewCube = new ViewCube();
  /** View direction pressed on the view cube, applied if the pointer is released on the same spot. */
  private cubePress: { pointerId: number; dir: Vec3 } | undefined;
  /** Running preset/fit camera move; OrbitControls must not touch the camera meanwhile. */
  private cameraMove: { frame: number; finish: () => void } | undefined;
  /** Last pointer position over the canvas (CSS px, canvas-relative), for hover picking. */
  private pointer: { x: number; y: number } | undefined;
  private hoverRequested = false;
  private hovered: PickHit | undefined;
  private navigating = false;
  /** Bodies hovered in the body list (highlighted like a hover in the view). */
  private listHover: readonly SelectionItem[] = [];
  /**
   * Focused comment: its markers' entities (hover layer when nothing else hovers); its
   * markers keep their colour (shown even when hidden), other markers fade (`comment-focus.ts`).
   */
  private focusItems: readonly SelectionItem[] = [];
  private focusMarkers: ReadonlySet<string> | undefined;
  /** Comment pins: what main asked for (anchors recomputed on visibility changes). */
  private pinRequests: readonly CommentPinRequest[] = [];
  private readonly pinOverlay = new PinOverlay();
  private readonly dimensionOverlay = new DimensionOverlay();
  /** Ghosts of lost markers and the compare with the previous version. */
  private readonly revision = new RevisionOverlay();
  /** Pins pick their visible spot on the next frame (camera came to rest / pins changed). */
  private pinSettle = false;
  private pinCameraKey = '';
  private pinSettleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Active tool. Select: hover highlight + clicks to `onClick`; others: their cursor. */
  private tool: ToolId = DEFAULT_TOOL;
  private brushRadius = DEFAULT_BRUSH_RADIUS_MM;
  private readonly brushCursor = new BrushCursor();
  /** Pointer over the visible model (brush tools) / over the view cube: decides the CSS cursor. */
  private overSurface = false;
  private overCube = false;
  /** Paint shown over the model and the markers' colours / visibility. */
  private paintLayer: PaintLayer | undefined;
  private markerStyles: readonly MarkerStyle[] = [];
  private shownEntities: readonly ShownEntity[] = [];
  /**
   * Paint stroke in progress (a press owned by Brush / Smart fill); `last` = last stamp.
   * `erase` is decided at the press (Shift held then) and kept for the whole stroke. `fill`:
   * Smart fill — each region the drag passes over is filled once (`lastRegion`).
   */
  private stroke:
    | {
        last: { x: number; y: number; point: Vec3 } | undefined;
        erase: boolean;
        fill: boolean;
        lastRegion?: FillRegion;
      }
    | undefined;
  /** Smart fill settings and the last region computed (reused while hovering inside it). */
  private fillAngle = DEFAULT_FILL_ANGLE_DEG;
  private fillWholeFace = false;
  private fillRegion: { key: string; region: FillRegion } | undefined;
  /** Active marker colour (brush circle, fill preview). */
  private brushColor = NO_MARKER_COLOR;
  /** Shift held: a Brush press erases (slicer convention). */
  private shiftDown = false;
  private wheelResizePx = 0;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private get selectEnabled(): boolean {
    return this.tool === 'select';
  }
  /**
   * Left press on the canvas that may become a click (released within CLICK_SLOP_PX) or, when
   * `canBox`, a box select once it moves further (`boxing`).
   */
  private press:
    | { pointerId: number; x: number; y: number; canBox: boolean; boxing: boolean; alt: boolean }
    | undefined;
  /** Rectangle drawn while box selecting. */
  private readonly boxOverlay = document.createElement('div');
  private filter: SelectionFilter = DEFAULT_FILTER;
  /** Left clicks in a row without a drag in between (a double click must be two real clicks). */
  private clicksInRow = 0;

  constructor(private readonly container: HTMLElement) {
    this.renderer = new WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);

    // CAD convention: Z up.
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(220, -260, 180);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // No damping/inertia: the camera moves only while the pointer moves (feels less "sticky").
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.applyNavigationStyle();
    installFreeOrbit(
      this.controls,
      this.camera,
      () => this.orbitStyle === 'free' && !this.cameraMove,
    );
    // Capture phase on the container runs before OrbitControls' own wheel listener on the canvas,
    // so trackpad swipes can be turned into orbit/pan instead of zoom.
    container.addEventListener('wheel', this.onWheel, { capture: true, passive: false });
    this.controls.addEventListener('change', () => {
      this.requestRender();
      // Wheel zoom moves the model under a resting cursor: pick again.
      if (!this.navigating) this.requestHover();
    });
    // The user grabbing the camera cancels a running preset/fit move.
    this.controls.addEventListener('start', () => {
      this.finishCameraMove();
      this.navigating = true;
      this.setHovered(undefined);
      this.setSurfaceHover(undefined);
    });
    this.controls.addEventListener('end', () => {
      this.navigating = false;
      if (this.pinOverlay.count > 0) this.schedulePinSettle();
      this.requestHover();
    });
    // Capture phase: the view cube gets clicks before OrbitControls (listening on the canvas).
    container.addEventListener('pointerdown', this.onCubePointerDown, { capture: true });
    container.addEventListener('pointerup', this.onCubePointerUp, { capture: true });
    container.addEventListener('pointermove', this.onCubePointerMove);
    container.addEventListener('pointerleave', this.onCubePointerLeave);
    container.addEventListener('pointermove', this.onHoverPointerMove);
    container.addEventListener('pointerleave', this.onHoverPointerLeave);
    container.addEventListener('pointerdown', this.onClickPointerDown, { capture: true });
    container.addEventListener('pointerup', this.onClickPointerUp, { capture: true });
    container.addEventListener('dblclick', this.onDoubleClickEvent);
    container.addEventListener('pointerdown', this.onRightPointerDown, { capture: true });
    container.addEventListener('pointermove', this.onRightPointerMove, { capture: true });
    container.addEventListener('pointerup', this.onRightPointerUp, { capture: true });
    container.addEventListener('pointermove', this.onBoxPointerMove);
    container.addEventListener('pointercancel', this.cancelBox);
    window.addEventListener('keydown', this.onBoxKey, { capture: true });
    window.addEventListener('keyup', this.onBoxKey, { capture: true });
    this.boxOverlay.className = 'box-select-rect';
    this.boxOverlay.hidden = true;
    container.appendChild(this.boxOverlay);
    container.appendChild(this.dimensionOverlay.el);
    container.appendChild(this.pinOverlay.el);
    this.pinOverlay.onClick = (id, detail) => {
      this.onPinClick?.(id, detail);
    };
    this.renderer.domElement.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    this.scene.add(new HemisphereLight(0xffffff, 0x8a8f99, 2));
    const sun = new DirectionalLight(0xffffff, 1.5);
    sun.position.set(1, -1, 2);
    this.scene.add(sun);

    const axes = new AxesHelper(GRID_SIZE / 4);
    // Axes win over the grid's centre lines (the grid writes no depth and draws first) but stay
    // depth-tested, so the model hides them like any other geometry.
    axes.renderOrder = 1;
    this.scene.add(axes);
    this.scene.add(this.brushCursor.root);
    this.scene.add(this.revision.root);

    this.resizeObserver = new ResizeObserver(() => {
      this.resize();
    });
    this.resizeObserver.observe(container);
    this.watchPixelRatio();
    this.resize();
  }

  /**
   * The floating left panel now covers `px` CSS px of the view's left side. The picture moves
   * so the view's middle (where the orbit target is drawn) is the middle of the free part; the
   * camera and its orbit target stay put, so orbiting turns the model in place.
   */
  setLeftCover(px: number): void {
    const cover = Number.isFinite(px) ? Math.max(px, 0) : 0;
    if (cover === this.leftCover) return;
    this.leftCover = cover;
    this.applyViewOffset();
    this.requestRender();
  }

  /** Mouse/trackpad mapping (see navigation.ts). Mouse wheel vs trackpad is auto-detected per gesture. */
  setNavigation(style: NavigationStyle): void {
    this.navStyle = style;
    this.applyNavigationStyle();
  }

  /** Turntable (upright, stops at top/bottom) or free orbit (navigation.ts `OrbitStyle`). */
  setOrbitStyle(style: OrbitStyle): void {
    if (style === this.orbitStyle) return;
    this.orbitStyle = style;
    // Back to turntable: straighten up around Z from where the camera is now.
    if (style === 'turntable') this.setView(this.currentPose().dir);
  }

  setTheme(theme: ResolvedTheme): void {
    this.viewCube.setTheme(theme);
    this.theme = theme;
    const p = PALETTE[theme];
    this.applyModelColors();
    this.model?.highlighter.setTheme(theme);
    if (this.focusMarkers) this.model?.markerEntities.set(this.entitiesForView());
    this.scene.background = new Color(p.bg);
    if (this.grid) {
      this.scene.remove(this.grid);
      this.grid.dispose();
    }
    this.grid = new GridHelper(GRID_SIZE, GRID_DIVISIONS, p.gridMajor, p.gridMinor);
    this.grid.rotation.x = Math.PI / 2; // GridHelper lies in XZ; rotate into XY (Z-up).
    for (const m of [this.grid.material].flat()) m.depthWrite = false;
    this.grid.renderOrder = -1;
    this.scene.add(this.grid);
    this.requestRender();
  }

  /**
   * Show a model CAD-style — shaded faces plus dark B-rep edge lines — and frame it. All bodies
   * share one mesh and one line object; `setBodyVisibility` only changes the drawn ranges.
   */
  /** The shown model is a mesh (STL / 3MF): no hover highlight, clicks or box select of entities. */
  private meshOnly = false;

  showModel(model: StepModel): void {
    this.meshOnly = model.meshFormat !== undefined;
    this.clearModel();
    const buffers = buildBodyBuffers(model);

    const faceGeometry = new BufferGeometry();
    faceGeometry.setAttribute('position', new BufferAttribute(model.positions, 3));
    faceGeometry.setAttribute('normal', new BufferAttribute(model.normals, 3));
    faceGeometry.setIndex(new BufferAttribute(buffers.indices, 1));
    faceGeometry.computeBoundingSphere();
    const faceMaterial = new MeshStandardMaterial({
      metalness: 0.05,
      roughness: 0.55,
      // Edge lines lie exactly on the surface. This depth bias (render-time only, geometry is
      // untouched) makes lines win the tie instead of flickering; kept small so lines behind
      // thin walls don't show through.
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    // A material array makes three.js draw only `geometry.groups` (the visible bodies).
    const faces = new Mesh(faceGeometry, [faceMaterial]);

    const edgeGeometry = new BufferGeometry();
    edgeGeometry.setAttribute('position', new BufferAttribute(buffers.edgeSegments, 3));
    edgeGeometry.computeBoundingSphere();
    const edges = new LineSegments(edgeGeometry, [new LineBasicMaterial()]);

    const picker = new Picker(model, buffers, { faces: faceGeometry, edges: edgeGeometry });
    picker.setPassKinds(pickPassKinds(this.filter));
    const highlighter = new Highlighter(model);
    highlighter.setTheme(this.theme);

    const markerEntities = new MarkerEntitiesOverlay(model, highlighter.faceTris);
    markerEntities.set(this.entitiesForView());

    const triBody = new Uint32Array(model.triangleFace.length);
    for (let t = 0; t < triBody.length; t++)
      triBody[t] = model.faceBody[model.triangleFace[t] ?? 0] ?? 0;
    const paint = new PaintOverlay(
      faceGeometry.getAttribute('position') as BufferAttribute,
      faceGeometry.getAttribute('normal') as BufferAttribute,
      model.indices,
      triBody,
    );

    const fillPreview = new FillPreview(
      faceGeometry.getAttribute('position') as BufferAttribute,
      model.indices,
    );

    const root = new Group();
    root.add(faces, paint.mesh, paint.pieceMesh, fillPreview.mesh, edges);
    root.add(markerEntities.root, highlighter.root);
    this.model = {
      root,
      faces,
      edges,
      triStart: buffers.triStart,
      edgeStart: buffers.edgeStart,
      boxes: bodyBoxes(
        model.positions,
        buffers.indices,
        buffers.triStart,
        buffers.edgeSegments,
        buffers.edgeStart,
      ),
      visible: [],
      source: model,
      picker,
      bodyOf: { face: model.faceBody, edge: model.edgeBody, vertex: model.vertexBody },
      highlighter,
      markerEntities,
      radius: faceGeometry.boundingSphere?.radius ?? 100,
      surface: new SurfaceRaycaster(model),
      paint,
      triBody,
      fillPreview,
      adjacency: undefined,
      regionRenderer: undefined,
    };
    this.focusItems = [];
    this.focusMarkers = undefined;
    this.applyHighlightViewport();
    this.applyModelColors();
    this.setBodyVisibility([]);
    this.scene.add(root);
    this.finishCameraMove();
    this.setOrbitUp(Z_UP); // a new model starts upright, even if the last one was rolled
    this.frame(faceGeometry.boundingSphere ?? new Sphere(new Vector3(), 100));
    // One throw-away pick now uploads the id buffers and compiles the pick shaders, so the first
    // hover doesn't stall (measured 38 ms on 1M triangles; adds that to the load instead).
    this.pick(0, 0);
    // Brush BVH (~270 ms on 1M triangles) and smart fill neighbours (~250 ms) in idle time after
    // the load, not on the first hover.
    const view = this.model;
    requestIdleCallback(
      () => {
        if (this.model !== view || this.disposed) return;
        view.surface.prepare();
        if (this.pinOverlay.count > 0) {
          this.pinSettle = true; // pins can find their visible spot now
          this.requestRender();
        }
        requestIdleCallback(
          () => {
            if (this.model !== view || this.disposed) return;
            this.adjacencyOf(view);
            // First brush stroke: paint code optimised and paint shader compiled.
            warmPaintCode();
            void view.paint.warm(this.renderer, this.scene, this.camera).catch(() => undefined); // only a warm-up: the first paint compiles anyway
            // AI pictures: shaders + target ready before the first render_region.
            void this.regionRendererOf(view)
              .warm(this.renderer, regionSize(undefined))
              .catch(() => undefined); // only a warm-up: the real render compiles anyway
          },
          { timeout: 4000 },
        );
      },
      { timeout: 2000 },
    );
    this.requestRender();
  }

  /** The model's AI-picture renderer, made on first use (render_region or the idle warm-up). */
  private regionRendererOf(m: ModelView): RegionRenderer {
    m.regionRenderer ??= new RegionRenderer(
      m.source,
      m.faces.geometry,
      m.edges.geometry,
      m.highlighter.faceTris,
      m.triBody,
      m.triStart,
      m.edgeStart,
    );
    return m.regionRenderer;
  }

  /** Ghosts of markers the revision transfer could not place. */
  setGhosts(shapes: readonly GhostShape[]): void {
    this.revision.setGhosts(shapes);
    this.requestRender();
  }

  /** Markers whose ghosts are drawn bold and on top (hovered row, highlighted comment). */
  setGhostBold(markerIds: ReadonlySet<string>): void {
    this.revision.setBold(markerIds);
    this.requestRender();
  }

  /** Compare with the previous version; undefined ends it. */
  setCompare(diff: VersionDiff | undefined): void {
    this.revision.setCompare(this.model ? diff : undefined);
    this.model?.paint.setFaded(this.revision.comparing); // the diff shows through paint
    this.requestRender();
  }

  /** Test hook: ghosts drawn and whether the compare overlay is on. */
  revisionStats(): { ghosts: number; comparing: boolean } {
    return { ghosts: this.revision.ghostCount, comparing: this.revision.comparing };
  }

  /** Show only bodies whose entry is true (missing entries count as visible). */
  setBodyVisibility(visible: readonly boolean[]): void {
    const m = this.model;
    if (!m) return;
    m.visible = [...visible];
    const setRuns = (geometry: BufferGeometry, starts: Uint32Array): void => {
      geometry.clearGroups();
      for (const run of visibleRuns(starts, visible)) geometry.addGroup(run.start, run.count, 0);
    };
    setRuns(m.faces.geometry, m.triStart);
    setRuns(m.edges.geometry, m.edgeStart);
    m.picker.setBodyVisibility(visible);
    m.highlighter.setBodyVisibility(visible);
    m.markerEntities.setBodyVisibility(visible);
    this.placePins();
    this.requestHover();
    // No groups → draw nothing (a material array with zero groups would draw nothing anyway).
    m.root.visible = m.faces.geometry.groups.length + m.edges.geometry.groups.length > 0;
    this.requestRender();
  }

  clearModel(): void {
    const m = this.model;
    if (!m) return;
    this.finishCameraMove();
    this.revision.dispose();
    this.scene.remove(m.root);
    m.picker.dispose();
    m.highlighter.dispose();
    m.markerEntities.dispose();
    m.surface.dispose();
    m.paint.dispose();
    m.fillPreview.dispose();
    m.regionRenderer?.dispose();
    this.fillRegion = undefined;
    this.stroke = undefined;
    for (const obj of [m.faces, m.edges]) {
      obj.geometry.dispose();
      for (const mat of obj.material) mat.dispose();
    }
    this.model = undefined;
    this.listHover = [];
    this.focusItems = [];
    this.focusMarkers = undefined;
    this.pinRequests = [];
    this.pinOverlay.set([]);
    this.dimensionOverlay.set([]);
    this.setHovered(undefined);
    this.setSurfaceHover(undefined);
    this.requestRender();
  }

  private applyModelColors(): void {
    if (!this.model) return;
    const p = PALETTE[this.theme];
    for (const mat of this.model.faces.material) mat.color.setHex(p.face);
    for (const mat of this.model.edges.material) mat.color.setHex(p.edge);
    this.requestRender();
  }

  /** Look at `sphere` from the current direction, far enough to see all of it (no animation). */
  private frame(sphere: Sphere): void {
    this.finishCameraMove();
    const pose = this.fitPose({
      center: [sphere.center.x, sphere.center.y, sphere.center.z],
      radius: sphere.radius,
    });
    this.applyOrbitPose(pose.target, pose.dir, pose.distance);
  }

  /**
   * Turn the camera to look along `dir` (target → camera), keeping target and distance.
   * `standard` (keys, Home): upright with Z as the orbit axis again. `nearest` (view cube): the
   * smallest turn from the current picture, so a roll is kept (like Fusion's view cube).
   */
  setView(dir: Vec3, mode: 'standard' | 'nearest' = 'standard'): void {
    this.finishCameraMove();
    const from = this.currentPose();
    const screenUp =
      mode === 'standard' ? standardScreenUp(dir) : nearestScreenUp(from.dir, from.screenUp, dir);
    if (mode === 'standard') this.setOrbitUp(Z_UP);
    this.moveCamera({ ...from, dir, screenUp });
  }

  /** Roll the picture 90° clockwise (`cw`) or counter-clockwise around the view direction. */
  roll(cw: boolean): void {
    this.finishCameraMove();
    const from = this.currentPose();
    this.moveCamera({ ...from, screenUp: rollScreenUp(from.dir, from.screenUp, cw) });
  }

  /** Zoom to fit all visible bodies (keeps the view direction). No-op without visible bodies. */
  fitAll(): void {
    const m = this.model;
    if (!m) return;
    const ids: number[] = [];
    for (let b = 0; b < m.triStart.length - 1; b++) if (m.visible[b] ?? true) ids.push(b);
    this.frameBodies(ids);
  }

  /**
   * Zoom to the given bodies (keeps the view direction) — zoom-to-selection. Selection passes the
   * selection's bodies here; entity-level framing can reuse `fitPose` with any bounding sphere.
   */
  frameBodies(ids: Iterable<number>): void {
    const m = this.model;
    if (!m) return;
    this.finishCameraMove();
    const sphere = sphereOfBodies(m.boxes, ids);
    if (sphere) this.moveCamera(this.fitPose(sphere));
  }

  /**
   * Zoom to the selected items (keeps the view direction). Very small selections (a vertex) zoom
   * to 2 % of the model size. Returns false (camera unchanged) when none of them is visible.
   */
  frameItems(items: readonly SelectionItem[]): boolean {
    const m = this.model;
    if (!m) return false;
    const sphere = m.highlighter.sphereOf(items);
    if (!sphere) return false;
    this.finishCameraMove();
    this.moveCamera(this.fitPose({ ...sphere, radius: Math.max(sphere.radius, m.radius * 0.02) }));
    return true;
  }

  /**
   * Focus of a comment: its markers' `items` are drawn like a hover (while nothing else is
   * hovered); `markerIds` keep their colour (shown even when hidden), all other markers fade.
   * `markerIds` empty = no fading (nothing to focus).
   */
  setCommentFocus(items: readonly SelectionItem[], markerIds: readonly string[]): void {
    this.focusItems = items;
    this.focusMarkers = markerIds.length > 0 ? new Set(markerIds) : undefined;
    this.model?.markerEntities.set(this.entitiesForView());
    this.applyHoverHighlight();
    this.requestRender();
  }

  /** Focused comment (tests): items in the hover layer, focused markers, faded paint styles. */
  commentFocusStats(): { items: number; markers: number; faded: number } {
    const focus = this.focusMarkers;
    return {
      items: this.focusItems.length,
      markers: focus?.size ?? 0,
      faded: focus ? this.markerStyles.filter((s) => !focus.has(s.id)).length : 0,
    };
  }

  private entitiesForView(): readonly ShownEntity[] {
    return focusedEntities(this.shownEntities, this.focusMarkers, PALETTE[this.theme].face);
  }

  /**
   * Zoom to `items` and painted `triangles` together (keeps the view direction), like
   * `frameItems`. Returns false (camera unchanged) when there is nothing visible to frame.
   */
  frameFocus(items: readonly SelectionItem[], triangles: ArrayLike<number>): boolean {
    const m = this.model;
    if (!m) return false;
    const sphere = m.highlighter.sphereOf(items, triangles);
    if (!sphere) return false;
    this.finishCameraMove();
    this.moveCamera(this.fitPose({ ...sphere, radius: Math.max(sphere.radius, m.radius * 0.02) }));
    return true;
  }

  /**
   * Picture of the markers in `request` for the AI: offscreen, `size` px square (clamped
   * to 64…768), their paint + entities in their colours, everything else grey, camera along the
   * region's normal and zoomed to it (region-view.ts). Hidden markers and bodies are drawn too;
   * the user's view is untouched. Undefined when there is no model or the markers hold nothing.
   */
  async renderRegion(request: RegionRequest, size?: number): Promise<RegionImage | undefined> {
    const t0 = performance.now();
    const px = regionSize(size);
    const samples = this.regionSamplesOf(request);
    const shot = samples && this.regionShot(request, samples, px);
    if (!shot) return undefined;
    const t1 = performance.now();
    const png = await encodePng(shot.rgba, px);
    return {
      png,
      size: px,
      ...cameraFacts(shot, px),
      renderMs: t1 - t0,
      encodeMs: performance.now() - t1,
    };
  }

  /**
   * Contact sheet: one picture per request (each like `renderRegion`, own camera) in one
   * image — 1 → 768², 2 → 768 × 384, 3–4 → 2 × 2 tiles of 384², numbered 1… (contact-sheet.ts).
   * Requests that show nothing are left out (`skipped`, by request index); undefined when none
   * is left or there is no model. More than 4 requests is an error.
   */
  async renderContactSheet(requests: readonly RegionRequest[]): Promise<ContactSheet | undefined> {
    if (requests.length > MAX_SHEET_REGIONS)
      throw new Error(`A contact sheet holds at most ${String(MAX_SHEET_REGIONS)} regions`);
    if (!this.model || requests.length === 0) return undefined;
    const t0 = performance.now();
    // Tile size depends on how many regions show something, so find those first.
    const sampled = requests.map((r) => this.regionSamplesOf(r));
    const shown = sampled.flatMap((s, i) => (s ? [i] : []));
    if (shown.length === 0) return undefined;
    const layout = sheetLayout(shown.length);
    const pictures: Uint8Array[] = [];
    const tiles: ContactSheetTile[] = [];
    shown.forEach((index, n) => {
      const request = requests[index];
      const samples = sampled[index];
      const shot = request && samples && this.regionShot(request, samples, layout.tile);
      const place = layout.tiles[n];
      if (!request || !shot || !place) throw new Error('Contact sheet tile could not be drawn');
      pictures.push(shot.rgba);
      tiles.push({
        number: n + 1,
        region: index,
        markerIds: request.markerIds,
        x: place.x,
        y: place.y,
        size: layout.tile,
        ...cameraFacts(shot, layout.tile),
      });
    });
    const rgba = composeSheet(layout, pictures);
    const t1 = performance.now();
    const png = await encodePng(rgba, layout.width, layout.height, (ctx) => {
      drawTileLabels(ctx, layout);
    });
    return {
      png,
      width: layout.width,
      height: layout.height,
      tiles,
      skipped: requests.flatMap((_, i) => (shown.includes(i) ? [] : [i])),
      renderMs: t1 - t0,
      encodeMs: performance.now() - t1,
    };
  }

  /** Paint layer usable for region pictures (matches the model's triangles), if any. */
  private regionLayer(): PaintLayer | undefined {
    const m = this.model;
    return m && this.paintLayer?.triangleCount === m.source.triangleFace.length
      ? this.paintLayer
      : undefined;
  }

  /** Surface samples of `request`'s markers; undefined when they hold nothing (or no model). */
  private regionSamplesOf(request: RegionRequest): RegionSamples | undefined {
    const m = this.model;
    if (!m) return undefined;
    const triangles = this.regionLayer()?.trianglesOf(request.markerIds) ?? [];
    const samples = regionSamples(
      m.source,
      m.highlighter.faceTris,
      request.entities,
      triangles,
      (b) => boxCenter(m.boxes, b),
    );
    return samples.points.length > 0 ? samples : undefined;
  }

  /** Draws `request` offscreen at `px`²; RGBA top-down + the camera used. */
  private regionShot(
    request: RegionRequest,
    samples: RegionSamples,
    px: number,
  ): RegionShot | undefined {
    const m = this.model;
    if (!m) return undefined;
    const sphere = m.faces.geometry.boundingSphere;
    // Parts in front: turn to a clearer direction if needed, ghost what still blocks.
    const ray = new Ray();
    const surface = m.surface;
    const choice = chooseRegionDir(
      samples.points,
      regionViewDir(samples),
      new Set(samples.bodies),
      (origin, dir) => {
        ray.origin.set(...origin);
        ray.direction.set(...dir);
        return surface.bodiesOnRay(ray);
      },
      Math.max(m.radius * 1e-3, 1e-4),
    );
    const view = regionView(samples.points, choice.dir, {
      center: sphere ? [sphere.center.x, sphere.center.y, sphere.center.z] : [0, 0, 0],
      radius: m.radius,
    });
    const rgba = this.regionRendererOf(m).render(this.renderer, {
      view,
      size: px,
      styles: request.styles,
      entities: request.entities,
      layer: this.regionLayer(),
      ghost: choice.ghost,
    });
    const names = m.source.bodyNames;
    const ghosted = choice.ghost.map((b) => ({
      body: b,
      name: names[b] || `Body ${String(b + 1)}`,
    }));
    return { rgba, view, ghosted };
  }

  /**
   * Comment pins: one per request, anchored on its `items` + painted `triangles` (visible
   * bodies only; a pin with nothing visible is left out). Drawn over the view, moved every frame.
   */
  setCommentPins(pins: readonly CommentPinRequest[]): void {
    this.pinRequests = pins;
    this.placePins();
  }

  /** Pin clicked (`detail` = click count, 2 = double click). */
  onPinClick: ((commentId: string, detail: number) => void) | undefined;

  /** Pins shown (tests): id, number, focused, behind the model, screen point (canvas px). */
  pinStats(): {
    id: string;
    number: number;
    focused: boolean;
    behind: boolean;
    x: number;
    y: number;
  }[] {
    const r = this.renderer.domElement.getBoundingClientRect();
    return [...this.pinOverlay.el.querySelectorAll<HTMLElement>('.comment-pin')]
      .filter((el) => !el.hidden)
      .map((el) => {
        const b = el.getBoundingClientRect();
        return {
          id: el.dataset.pin ?? '',
          number: Number(el.textContent),
          focused: el.classList.contains('focused'),
          behind: el.classList.contains('behind'),
          x: b.left - r.left,
          y: b.bottom - r.top,
        };
      });
  }

  private placePins(): void {
    const m = this.model;
    const placed: PlacedPin[] = [];
    if (m) {
      for (const req of this.pinRequests) {
        const spots = pinSpots(
          m.highlighter.buffersOf(req.items, req.triangles),
          m.source.positions,
          m.highlighter.vertexFace,
        );
        if (spots.length > 0) placed.push({ ...req.spec, spots });
      }
    }
    this.pinOverlay.set(placed);
    this.pinSettle = true;
    this.requestRender();
  }

  private readonly pinPoint = new Vector3();
  private readonly pinRay = new Raycaster();

  /**
   * Pins hop to a visible spot only once the camera has rested for a moment (not on every frame
   * of an orbit or a wheel zoom: they stay put while the camera moves).
   */
  private schedulePinSettle(): void {
    clearTimeout(this.pinSettleTimer);
    this.pinSettleTimer = setTimeout(() => {
      this.pinSettleTimer = undefined;
      if (this.navigating || this.cameraMove || this.disposed) return;
      this.pinSettle = true;
      this.requestRender();
    }, PIN_SETTLE_MS);
  }

  /** Moves the pins to their spots for the current camera (every frame). */
  private movePins(): void {
    const m = this.model;
    if (!m || this.pinOverlay.count === 0) return;
    const e = this.camera.matrixWorld.elements;
    const key = e.map((v) => v.toFixed(4)).join(',');
    if (key !== this.pinCameraKey) {
      this.pinCameraKey = key;
      this.schedulePinSettle();
    }
    // Spots can't be told apart until the BVH exists (built in idle time after a load).
    const settle = this.pinSettle && m.surface.ready;
    if (settle) this.pinSettle = false;
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    const cam = this.camera.position;
    // Anchors lie on the surface: only hits clearly in front of them hide them.
    const slack = Math.max(m.radius * 1e-3, 1e-3);
    this.pinOverlay.place(
      (p) => {
        const v = this.pinPoint.set(...p).project(this.camera);
        if (v.z < -1 || v.z > 1) return undefined;
        return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
      },
      (p) => {
        if (!m.surface.ready) return false;
        const target = this.pinPoint.set(...p);
        const dist = cam.distanceTo(target);
        if (dist <= slack) return false;
        this.pinRay.ray.origin.copy(cam);
        this.pinRay.ray.direction.copy(target).sub(cam).normalize();
        return m.surface.blocked(this.pinRay.ray, dist - slack, m.visible);
      },
      settle,
      { w, h },
    );
  }

  /** Dimensions drawn over the view: the selection's and the highlighted comment's. */
  setDimensions(specs: readonly DimensionSpec[]): void {
    this.dimensionOverlay.set(specs);
    this.requestRender();
  }

  /** Dimensions shown (tests). */
  dimensionStats(): { label: string; shown: boolean }[] {
    return this.dimensionOverlay.stats();
  }

  private readonly dimensionPoint = new Vector3();

  /** Moves the dimensions to the current camera (every frame). */
  private moveDimensions(): void {
    if (this.dimensionOverlay.count === 0) return;
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    this.dimensionOverlay.place((p) => {
      const v = this.dimensionPoint.set(...p).project(this.camera);
      if (v.z < -1 || v.z > 1) return undefined;
      return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
    });
  }

  /** Show `items` as the selection (highlighted until replaced). */
  setSelection(items: readonly SelectionItem[]): void {
    this.model?.highlighter.set('selection', items);
    this.requestRender();
  }

  /**
   * Active tool. Select: the hovered entity is highlighted and left clicks go to `onClick`. Other
   * tools: hover is only reported (`onHover`), nothing is highlighted; the pointer shows the
   * tool's cursor over the model (brush circle / crosshair). In Slicer style a left press on the
   * model is the tool's action for every tool, on the background it orbits.
   */
  setTool(tool: ToolId): void {
    if (tool === this.tool) return;
    this.tool = tool;
    this.cancelBox();
    this.press = undefined;
    this.endStroke();
    this.clicksInRow = 0;
    this.applyHoverHighlight();
    this.setSurfaceHover(undefined);
    this.requestHover();
  }

  /**
   * Smart fill: fill across edges bent at most `angleDeg`, or (`wholeFace`) exactly the
   * clicked B-rep face.
   */
  setFill(angleDeg: number, wholeFace: boolean): void {
    if (angleDeg === this.fillAngle && wholeFace === this.fillWholeFace) return;
    this.fillAngle = angleDeg;
    this.fillWholeFace = wholeFace;
    this.fillRegion = undefined;
    this.requestHover();
  }

  /** Brush / erase radius in mm (the circle cursor's and the paint ball's size). */
  setBrushRadius(mm: number): void {
    this.brushRadius = Math.max(0.01, mm);
    this.requestHover();
  }

  /**
   * Paint to show over the model (undefined = none). Call `paintChanged` after changing it.
   * Triangle ids are the shown model's import ids.
   */
  setPaint(layer: PaintLayer | undefined): void {
    this.paintLayer = layer;
    this.paintChanged();
  }

  /** Marker colours and visibility for the paint (hidden markers' paint is not drawn). */
  setMarkerStyles(styles: readonly MarkerStyle[]): void {
    this.markerStyles = styles;
    this.paintChanged();
  }

  /** The paint layer changed: redraw (the overlay rebuilds once per frame at most). */
  paintChanged(): void {
    this.requestRender();
  }

  /**
   * A paint stroke starts (`erase`: Shift held at the press).
   */
  onStrokeStart: ((erase: boolean) => void) | undefined;
  /**
   * Triangles to paint or erase (import ids, visible bodies only): what the brush ball touched
   * this frame, or a Smart fill region. Called at most once per frame while a stroke runs.
   * `spheres`: the brush stamps of this frame (Brush, also Shift-erase; paint follows the ball);
   * undefined for Smart fill (whole triangles).
   */
  onStroke:
    | ((triangles: Iterable<number>, erase: boolean, spheres?: readonly PaintSphere[]) => void)
    | undefined;
  /** The stroke ended (pointer released / cancelled / tool changed). */
  onStrokeEnd: (() => void) | undefined;
  /**
   * Alt + scroll over the view with a paint tool: brush size / fill angle by `steps` (+ = larger).
   */
  onSizeStep: ((steps: number) => void) | undefined;

  /** Brush tool (paints with a ball), not Select / Smart fill. */
  private get brushTool(): boolean {
    return toolDef(this.tool).cursor === 'circle';
  }

  /** A tool that acts on the surface under the pointer: Brush, Smart fill. */
  private get surfaceTool(): boolean {
    return toolDef(this.tool).cursor !== 'pick';
  }

  /** During a stroke: its mode (fixed at the press). Otherwise: what a press would do now. */
  private get erasing(): boolean {
    if (this.stroke) return this.stroke.erase;
    return (this.tool === 'brush' || this.tool === 'smart-fill') && this.shiftDown;
  }

  /** Triangle neighbours of `m`, built now if the idle-time build hasn't run yet. */
  private adjacencyOf(m: ModelView): TriangleAdjacency {
    m.adjacency ??= TriangleAdjacency.build(m.source.positions, m.source.indices, m.source.normals);
    return m.adjacency;
  }

  /**
   * Region Smart fill takes at `hit`: the connected surface within the angle on the hit body, or
   * the hit B-rep face. A hit inside the last region reuses it (same settings → same region).
   */
  private fillRegionAt(hit: SurfaceHit): FillRegion | undefined {
    const m = this.model;
    if (!m) return undefined;
    const key = this.fillWholeFace ? 'face' : String(this.fillAngle);
    const cached = this.fillRegion;
    if (cached?.key === key && cached.region.contains[hit.triangle]) return cached.region;
    const body = hit.body;
    const triBody = m.triBody;
    const region = this.fillWholeFace
      ? faceRegion(m.source.triangleFace, hit.face)
      : smartFill(this.adjacencyOf(m), hit.triangle, this.fillAngle, (t) => triBody[t] === body);
    this.fillRegion = { key, region };
    return region;
  }

  /** Surface point under canvas point `p` (CSS px) on a visible body, or undefined. */
  private surfaceHitAt(p: { x: number; y: number }): SurfaceHit | undefined {
    const m = this.model;
    if (!m?.root.visible) return undefined;
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    this.ndc.set((p.x / w) * 2 - 1, 1 - (p.y / h) * 2);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return m.surface.hit(this.raycaster.ray, m.visible);
  }

  /**
   * Continue the stroke to canvas point `p` (surface `hit` there): stamps from the last stamp to
   * here no further apart than `STROKE_SPACING` × radius (screen points in between are raycast,
   * so the stroke follows the surface), then one `onStroke` with all touched triangles.
   */
  private strokeTo(p: { x: number; y: number }, hit: SurfaceHit | undefined): void {
    const stroke = this.stroke;
    const m = this.model;
    if (!stroke || !m) return;
    if (!hit) {
      stroke.last = undefined; // left the model: the next stamp starts afresh
      return;
    }
    if (stroke.fill) {
      const region = this.fillRegionAt(hit);
      if (!region || region === stroke.lastRegion) return;
      stroke.lastRegion = region;
      this.onStroke?.(region.triangles, stroke.erase);
      return;
    }
    const r = this.brushRadius;
    const stamps: SurfaceHit[] = [];
    const last = stroke.last;
    if (last) {
      const d = Math.hypot(
        hit.point[0] - last.point[0],
        hit.point[1] - last.point[1],
        hit.point[2] - last.point[2],
      );
      const n = Math.min(MAX_STROKE_FILL, Math.ceil(d / (r * STROKE_SPACING)));
      for (let i = 1; i < n; i++) {
        const f = i / n;
        const between = this.surfaceHitAt({
          x: last.x + (p.x - last.x) * f,
          y: last.y + (p.y - last.y) * f,
        });
        if (between) stamps.push(between);
      }
    }
    stamps.push(hit);
    stroke.last = { x: p.x, y: p.y, point: hit.point };
    // Slicer rule: per stamp, only the camera-facing triangles of the ball connected to the one
    // under it — not the back of a thin wall or a separate part the ball reaches into.
    const adj = this.adjacencyOf(m);
    const facing = this.facingCamera(m, adj);
    const touched = new Set<number>();
    for (const stamp of stamps) {
      const inBall = new Set(m.surface.trianglesInSphere(stamp.point, r, m.visible));
      for (const t of brushPatch(adj, stamp.triangle, inBall, facing)) touched.add(t);
    }
    if (touched.size > 0)
      this.onStroke?.(
        [...touched],
        this.erasing,
        stamps.map((s) => ({ center: s.point, radius: r })),
      );
  }

  /** Triangle `t` faces the camera (its outward facet normal points towards the eye); degenerate ones pass. */
  private facingCamera(m: ModelView, adj: TriangleAdjacency): (t: number) => boolean {
    const { x: ex, y: ey, z: ez } = this.camera.position;
    const P = m.source.positions;
    const I = m.source.indices;
    const N = adj.normals;
    return (t) => {
      const nx = N[t * 3] ?? 0;
      const ny = N[t * 3 + 1] ?? 0;
      const nz = N[t * 3 + 2] ?? 0;
      if (nx === 0 && ny === 0 && nz === 0) return true;
      const a = (I[t * 3] ?? 0) * 3;
      const b = (I[t * 3 + 1] ?? 0) * 3;
      const c = (I[t * 3 + 2] ?? 0) * 3;
      const cx = ((P[a] ?? 0) + (P[b] ?? 0) + (P[c] ?? 0)) / 3;
      const cy = ((P[a + 1] ?? 0) + (P[b + 1] ?? 0) + (P[c + 1] ?? 0)) / 3;
      const cz = ((P[a + 2] ?? 0) + (P[b + 2] ?? 0) + (P[c + 2] ?? 0)) / 3;
      return nx * (ex - cx) + ny * (ey - cy) + nz * (ez - cz) > 0;
    };
  }

  private endStroke(): void {
    if (!this.stroke) return;
    this.stroke = undefined;
    this.onStrokeEnd?.();
  }

  /** Import triangles the paint overlay drew in the last frame, whole or in pieces (tests). */
  paintShownTriangles(): number {
    const p = this.model?.paint;
    return p && (p.mesh.visible || p.pieceMesh.visible) ? p.shownTriangles : 0;
  }

  /** Pieces of cut triangles the paint overlay drew in the last frame (tests). */
  paintShownPieces(): number {
    const p = this.model?.paint;
    return p?.pieceMesh.visible ? p.shownPieces : 0;
  }

  /** A brush stroke is running (tests). */
  isStroking(): boolean {
    return this.stroke !== undefined;
  }

  /** Brush circle / fill preview colour as 0xrrggbb: the active marker's. Erase stays red. */
  setBrushColor(color: number): void {
    this.brushColor = color;
    this.brushCursor.setBrushColor(color);
    this.requestHover();
  }

  /** Triangles the Smart fill preview shows now (0 = hidden), tests. */
  fillPreviewTriangles(): number {
    return this.model?.fillPreview.shownTriangles() ?? 0;
  }

  /** The brush circle as shown now, or undefined when hidden (tests). */
  brushCursorState(): BrushCursorState | undefined {
    return this.brushCursor.current();
  }

  /** Selection filter: which kinds hover and clicks may pick. The selection is kept. */
  setSelectionFilter(filter: SelectionFilter): void {
    this.filter = filter;
    this.model?.picker.setPassKinds(pickPassKinds(filter));
    this.requestHover();
  }

  /**
   * Highlight these items as hovered (pointer over a row in the body list or a marker's entity
   * list); [] = none.
   */
  setListHover(items: readonly SelectionItem[]): void {
    this.listHover = items;
    this.applyHoverHighlight();
  }

  /** Entities held by markers, already resolved to one colour each. */
  setMarkerEntities(entities: readonly ShownEntity[]): void {
    this.shownEntities = entities;
    this.model?.markerEntities.set(this.entitiesForView());
    this.requestRender();
  }

  /** Drawn marker entities (tests): tinted triangles, line segments, dots. */
  markerEntityStats(): { tris: number; lines: number; bodyLines: number; dots: number } {
    return this.model?.markerEntities.stats() ?? { tris: 0, lines: 0, bodyLines: 0, dots: 0 };
  }

  /**
   * Called for a right click (press + release of the right button without dragging, so a
   * right-drag still navigates) with the entity under it (Select tool only, else undefined) and
   * the pointer's page position, for a context menu.
   */
  onContextMenu: ((hit: PickHit | undefined, at: { x: number; y: number }) => void) | undefined;

  private rightPress: { pointerId: number; x: number; y: number } | undefined;

  private readonly onRightPointerDown = (e: PointerEvent): void => {
    if (e.button !== 2 || e.target !== this.renderer.domElement) return;
    this.rightPress = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
  };

  private readonly onRightPointerMove = (e: PointerEvent): void => {
    const press = this.rightPress;
    if (press?.pointerId !== e.pointerId) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX)
      this.rightPress = undefined; // a drag (orbit / pan), not a click
  };

  private readonly onRightPointerUp = (e: PointerEvent): void => {
    const press = this.rightPress;
    if (e.button !== 2 || press?.pointerId !== e.pointerId) return;
    this.rightPress = undefined;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > CLICK_SLOP_PX) return;
    if (this.cubeDirAt(e)) return;
    const p = this.canvasPoint(e);
    const hit = this.selectEnabled ? this.pick(p.x, p.y) : undefined;
    this.onContextMenu?.(hit, { x: e.clientX, y: e.clientY });
  };

  /** Hover layer = entity under the pointer (Select tool), else the body-list hover. */
  private applyHoverHighlight(): void {
    if (!this.model) return;
    const hit = this.selectEnabled ? this.hovered : undefined;
    const fallback = this.listHover.length > 0 ? this.listHover : this.focusItems;
    this.model.highlighter.set('hover', hit ? [hit] : fallback);
    this.requestRender();
  }

  /**
   * Called for a left click (press + release without dragging) in the select tool: the entity
   * under the cursor, or undefined for background / hidden bodies; `triangle` = import triangle
   * under the cursor on a visible body (paint there), if any.
   */
  onClick: ((hit: PickHit | undefined, triangle: number | undefined) => void) | undefined;

  /**
   * Called after the second `onClick` of a double click (the system's double-click speed; both
   * clicks without a drag) with the entity the filter allows under the cursor (as `onClick` got
   * it) and the body under the cursor, whatever the filter allows (undefined = background).
   */
  onDoubleClick: ((hit: PickHit | undefined, body: number | undefined) => void) | undefined;

  private canvasPoint(e: MouseEvent): { x: number; y: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Capture phase on the container: runs before OrbitControls (on the canvas) and after the view
  // cube's handler, which stops propagation for its own clicks.
  private readonly onClickPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.target !== this.renderer.domElement || this.cubePress) return;
    if (this.cubeDirAt(e)) {
      this.clicksInRow = 0;
      return;
    }
    const p = this.canvasPoint(e);
    // A left drag of the Select tool draws a box. Fusion / Onshape: anywhere (left-drag
    // doesn't navigate there). Slicer style, where left-drag orbits: a press on the model (even
    // where the filter allows nothing), or Shift + press anywhere (instead of OrbitControls'
    // Shift-pan); Alt + press there still orbits, for when the model fills the view. Decided once.
    const slicer = leftDragNavigates(this.navStyle);
    // Paint tools (Brush, Smart fill) follow the same rule, without the
    // Shift exception; they decide "on the model" with the same surface ray as their cursor.
    const surfaceHit = this.surfaceTool && !e.altKey ? this.surfaceHitAt(p) : undefined;
    const onModel = (): boolean =>
      !e.altKey &&
      (this.surfaceTool ? surfaceHit !== undefined : this.rawPick(p.x, p.y) !== undefined);
    const toolOwnsDrag = this.selectEnabled
      ? !this.meshOnly && (!slicer || e.shiftKey || onModel())
      : !slicer || onModel();
    this.press = {
      pointerId: e.pointerId,
      ...p,
      canBox: toolOwnsDrag && this.selectEnabled && !this.meshOnly,
      boxing: false,
      alt: e.altKey,
    };
    if (toolOwnsDrag && this.surfaceTool) {
      this.shiftDown = e.shiftKey;
      this.stroke = { last: undefined, erase: this.erasing, fill: !this.brushTool };
      this.setHovered(undefined); // no hover label while painting
      this.onStrokeStart?.(this.erasing);
      this.strokeTo(p, surfaceHit);
    }
    if (toolOwnsDrag) {
      if (slicer) e.stopPropagation();
      // Keep receiving moves (and the release) when the box is dragged past the canvas edge.
      this.renderer.domElement.setPointerCapture(e.pointerId);
    }
  };

  /**
   * Called when a box select ends with the entities inside it ([] = none), what to do with them
   * (left→right = add, right→left = remove) and how they were chosen (Alt = crossing).
   */
  onBoxSelect: ((items: SelectionItem[], action: BoxAction, mode: BoxMode) => void) | undefined;

  private readonly onBoxPointerMove = (e: PointerEvent): void => {
    const press = this.press;
    if (press?.pointerId !== e.pointerId || !press.canBox) return;
    const p = this.canvasPoint(e);
    if (!press.boxing && Math.hypot(p.x - press.x, p.y - press.y) <= CLICK_SLOP_PX) return;
    if (!press.boxing) {
      press.boxing = true;
      this.setHovered(undefined);
    }
    press.alt = e.altKey;
    this.drawBox(p);
  };

  /** Alt pressed/released during a box drag switches window ↔ crossing without moving the mouse. */
  private readonly onBoxKey = (e: KeyboardEvent): void => {
    if (e.key === 'Shift' && this.surfaceTool && this.shiftDown !== (e.type === 'keydown')) {
      this.shiftDown = e.type === 'keydown';
      // Brush ⇄ erase circle without moving the mouse. A running stroke keeps its mode (and is
      // not re-stamped), else Shift during a stroke would erase what it just painted.
      if (!this.stroke) this.requestHover();
    }
    // Windows: a lone Alt would focus the menu bar; Alt + scroll resizes the brush over the view.
    if (e.key === 'Alt' && this.surfaceTool && this.pointer) e.preventDefault();
    const press = this.press;
    if (!press?.boxing) return;
    if (e.key === 'Escape') {
      e.stopPropagation(); // cancel the box, keep the selection
      this.cancelBox();
      return;
    }
    if (e.key !== 'Alt') return;
    e.preventDefault(); // Windows: a lone Alt would focus the menu bar
    press.alt = e.type === 'keydown';
    if (this.boxEnd) this.drawBox(this.boxEnd);
  };

  private boxEnd: { x: number; y: number } | undefined;

  private drawBox(end: { x: number; y: number }): void {
    const press = this.press;
    if (!press) return;
    this.boxEnd = end;
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    const r = boxRect(press, end, w, h);
    const style = this.boxOverlay.style;
    style.left = `${String(r.x0)}px`;
    style.top = `${String(r.y0)}px`;
    style.width = `${String(r.x1 - r.x0)}px`;
    style.height = `${String(r.y1 - r.y0)}px`;
    const mode = boxMode(press.alt);
    const action = boxAction(press.x, end.x);
    this.boxOverlay.classList.toggle('crossing', mode === 'crossing');
    this.boxOverlay.classList.toggle('remove', action === 'remove');
    this.boxOverlay.dataset['label'] = boxLabel(action, mode);
    this.boxOverlay.hidden = false;
  }

  private readonly cancelBox = (): void => {
    if (this.press?.boxing) this.press = undefined;
    if (this.stroke) {
      this.press = undefined;
      this.endStroke();
    }
    this.boxEnd = undefined;
    this.boxOverlay.hidden = true;
  };

  /**
   * Entities a box from canvas point `a` to `b` (CSS px) selects with the current filter:
   * visible ones only; `window` = fully inside, `crossing` = touching. For tests and the box drag.
   */
  boxSelect(
    a: { x: number; y: number },
    b: { x: number; y: number },
    mode: BoxMode,
  ): SelectionItem[] {
    const m = this.model;
    if (!m?.root.visible) return [];
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    const rect = boxRect(a, b, w, h);
    if (rect.x1 - rect.x0 < 1 || rect.y1 - rect.y0 < 1) return [];
    const passes = m.picker.renderRegion(this.renderer, this.camera, rect, {
      vertex: this.filter.vertex,
      edge: this.filter.edge,
    });
    const visible = passes.reduce((acc, px) => visibleIds(px, acc), visibleIds(new Uint8Array()));
    this.camera.updateMatrixWorld();
    const matrix = this.camera.projectionMatrix.clone().multiply(this.camera.matrixWorldInverse);
    return boxSelectItems(
      visible,
      m.source,
      m.highlighter.faceTris,
      { matrix: matrix.elements, width: w, height: h },
      rect,
      mode,
      this.filter,
    );
  }

  private readonly onClickPointerUp = (e: PointerEvent): void => {
    const press = this.press;
    if (press?.pointerId !== e.pointerId) return;
    this.press = undefined;
    this.endStroke();
    const p = this.canvasPoint(e);
    if (press.boxing) {
      this.boxOverlay.hidden = true;
      this.boxEnd = undefined;
      this.clicksInRow = 0;
      const mode = boxMode(e.altKey);
      this.onBoxSelect?.(this.boxSelect(press, p, mode), boxAction(press.x, p.x), mode);
      this.requestHover();
      return;
    }
    if (Math.hypot(p.x - press.x, p.y - press.y) > CLICK_SLOP_PX || !this.selectEnabled) {
      this.clicksInRow = 0; // a drag between two clicks breaks the pair
      return;
    }
    const hit = this.pick(p.x, p.y);
    this.clicksInRow++;
    this.onClick?.(hit, this.surfaceHitAt(p)?.triangle);
  };

  // The browser's dblclick follows the OS double-click speed, but also fires after a drag ending
  // in a click; `clicksInRow` makes sure both presses were real clicks of the select tool.
  private readonly onDoubleClickEvent = (e: MouseEvent): void => {
    if (e.button !== 0 || e.target !== this.renderer.domElement || this.clicksInRow < 2) return;
    if (!this.selectEnabled || this.cubeDirAt(e)) return;
    const p = this.canvasPoint(e);
    if (this.meshOnly) return;
    const raw = this.rawPick(p.x, p.y);
    if (!raw) {
      this.onDoubleClick?.(undefined, undefined);
      return;
    }
    const item = applyFilter(raw.ref, raw.body, this.filter);
    this.onDoubleClick?.(item && { kind: item.kind, id: item.id, body: raw.body }, raw.body);
  };

  /** Canvas position (CSS px) of a world point — for tests and overlays. */
  projectToCanvas(point: Vec3): { x: number; y: number } {
    const v = new Vector3(...point).project(this.camera);
    const { clientWidth: w, clientHeight: h } = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  private applyHighlightViewport(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    const size = new Vector2(w, h);
    this.model?.highlighter.setViewport(size, this.renderer.getPixelRatio());
    this.model?.markerEntities.setViewport(size, this.renderer.getPixelRatio());
    this.revision.setViewport(size);
  }

  /**
   * Frame `sphere` around its centre (the new orbit target), sized to the part of the view the
   * floating left panel leaves free; the view offset (`applyViewOffset`) draws it in that part's
   * middle.
   */
  private fitPose(sphere: BoundingSphere): CameraPose {
    const pose = this.currentPose();
    const { clientWidth: w, clientHeight: h } = this.container;
    const distance =
      w && h && this.leftCover > 0
        ? fitInFreeArea(sphere.radius, this.camera.fov, w, h, this.leftCover)
        : fitDistance(sphere.radius, this.camera.fov, this.camera.aspect);
    return { ...pose, target: sphere.center, distance };
  }

  /**
   * Shift the whole picture right by half the left panel's cover (a view offset: the projection
   * moves, not the camera). Everything drawn or picked with `this.camera` follows; the view cube
   * and `render_region` use their own cameras and get no shift.
   */
  private applyViewOffset(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    const shift = w && h ? freeAreaShift(w, this.leftCover) : 0;
    if (shift > 0) this.camera.setViewOffset(w, h, -shift, 0, w, h);
    else this.camera.clearViewOffset();
  }

  private currentPose(): CameraPose {
    const offset = this.camera.position.clone().sub(this.controls.target);
    const distance = offset.length() || 1;
    offset.divideScalar(distance);
    const t = this.controls.target;
    const dir: Vec3 = [offset.x, offset.y, offset.z];
    const up = screenUp(this.controls, this.camera);
    return { target: [t.x, t.y, t.z], dir, distance, screenUp: [up.x, up.y, up.z] };
  }

  /** Place the orbit camera (OrbitControls decides the roll from its axis). */
  private applyOrbitPose(target: Vec3, dir: Vec3, distance: number): void {
    this.controls.target.set(...target);
    this.camera.position.set(...target).addScaledVector(new Vector3(...dir), distance);
    this.setClipping(distance);
    this.controls.update();
    this.requestRender();
  }

  private setClipping(distance: number): void {
    this.camera.near = Math.max(distance / 1000, 0.01);
    this.camera.far = distance * 100;
    this.camera.updateProjectionMatrix();
  }

  private setOrbitUp(up: Vec3): void {
    setOrbitAxis(this.controls, this.camera, new Vector3(...up));
  }

  /**
   * Eased move from the current pose to `to` over CAMERA_MOVE_MS: target and distance are
   * interpolated, the camera's rotation slerped (any turn or roll, no pole flips). At the end the
   * orbit axis is set so OrbitControls keeps exactly that picture (`orbitSetup`).
   */
  private moveCamera(to: CameraPose): void {
    this.stopCameraMove();
    const from = this.currentPose();
    const qFrom = this.camera.quaternion.clone();
    const qTo = lookRotation(to.dir, to.screenUp);
    const setup = orbitSetup(to.dir, to.screenUp, [
      this.camera.up.x,
      this.camera.up.y,
      this.camera.up.z,
    ]);
    const finish = (): void => {
      this.cameraMove = undefined;
      // Land exactly on the target rotation (a cut-short move is mid-slerp); free orbit keeps it.
      this.camera.quaternion.copy(qTo);
      this.setOrbitUp(setup.orbitUp);
      this.applyOrbitPose(to.target, setup.cameraDir, to.distance);
      this.requestHover(); // the model moved under a resting cursor
    };
    const start = performance.now();
    const step = (now: number): void => {
      const t = Math.min((now - start) / CAMERA_MOVE_MS, 1);
      if (t >= 1) {
        finish();
        return;
      }
      const e = easeInOut(t);
      const q = qFrom.clone().slerp(qTo, e);
      const lerp = (a: number, b: number): number => a + (b - a) * e;
      const target = new Vector3(
        lerp(from.target[0], to.target[0]),
        lerp(from.target[1], to.target[1]),
        lerp(from.target[2], to.target[2]),
      );
      // Zoom geometrically so big distance changes feel even.
      const distance = from.distance * (to.distance / from.distance) ** e;
      this.controls.target.copy(target);
      this.camera.quaternion.copy(q);
      // Camera looks along its local −Z; it sits `distance` behind the target.
      this.camera.position
        .copy(target)
        .addScaledVector(new Vector3(0, 0, 1).applyQuaternion(q), distance);
      this.setClipping(distance);
      this.cameraMove = { frame: requestAnimationFrame(step), finish };
      this.renderNow();
    };
    this.cameraMove = { frame: requestAnimationFrame(step), finish };
  }

  /** Cancel a running camera move where it is (only for dispose). */
  private stopCameraMove(): void {
    if (this.cameraMove) cancelAnimationFrame(this.cameraMove.frame);
    this.cameraMove = undefined;
    this.requestHover();
  }

  /** Jump a running camera move to its end (user grabs the camera, new move, new model). */
  private finishCameraMove(): void {
    const move = this.cameraMove;
    if (!move) return;
    cancelAnimationFrame(move.frame);
    move.finish();
  }

  private cubeDirAt(e: MouseEvent): Vec3 | undefined {
    const r = this.container.getBoundingClientRect();
    return this.viewCube.pick(e.clientX - r.left, e.clientY - r.top, r.width, this.camera);
  }

  private readonly onCubePointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || e.target !== this.renderer.domElement) return;
    const dir = this.cubeDirAt(e);
    if (!dir) return;
    e.preventDefault();
    e.stopPropagation(); // don't start an orbit
    this.clicksInRow = 0; // a cube click is not a model click (no double click on the cube)
    this.cubePress = { pointerId: e.pointerId, dir };
  };

  private readonly onCubePointerUp = (e: PointerEvent): void => {
    const press = this.cubePress;
    if (press?.pointerId !== e.pointerId) return;
    this.cubePress = undefined;
    const dir = this.cubeDirAt(e);
    if (dir?.every((c, i) => Math.abs(c - (press.dir[i] ?? 0)) < 1e-9))
      this.setView(dir, 'nearest');
  };

  private readonly onCubePointerMove = (e: PointerEvent): void => {
    if (e.buttons !== 0 && !this.cubePress) return; // orbiting: leave the highlight alone
    const dir = this.cubeDirAt(e);
    this.overCube = dir !== undefined;
    this.applyCanvasCursor();
    if (this.viewCube.setHover(dir)) this.requestRender();
  };

  private readonly onCubePointerLeave = (): void => {
    this.overCube = false;
    this.applyCanvasCursor();
    if (this.viewCube.setHover(undefined)) this.requestRender();
  };

  /**
   * Entity under canvas position (`x`, `y`, CSS px from the canvas' top-left) as the
   * selection filter allows it, or undefined over background / hidden bodies / filtered-out
   * kinds. Synchronous: renders a small ID square and reads it back.
   */
  pick(x: number, y: number): PickHit | undefined {
    if (this.meshOnly) return undefined; // no entity selection on STL / 3MF
    const raw = this.rawPick(x, y);
    if (!raw) return undefined;
    const item = applyFilter(raw.ref, raw.body, this.filter);
    return item && { kind: item.kind, id: item.id, body: raw.body };
  }

  /** What the pick pass hit (vertices/edges only if the filter allows them) and its body. */
  private rawPick(x: number, y: number): { ref: EntityRef; body: number } | undefined {
    const m = this.model;
    if (!m?.root.visible) return undefined;
    const ref = m.picker.pick(this.renderer, this.camera, x, y, PICK_RADIUS);
    return ref && { ref, body: m.bodyOf[ref.kind][ref.id] ?? 0 };
  }

  /**
   * Called when the hovered entity changes (undefined = nothing).
   * Hover picks run at most once per frame, not while orbiting/panning or over the view cube.
   */
  onHover: ((hit: PickHit | undefined) => void) | undefined;

  private readonly onHoverPointerMove = (e: PointerEvent): void => {
    if (e.target !== this.renderer.domElement) return;
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
    this.shiftDown = e.shiftKey;
    // Dragging: the camera moves (hover is cleared on 'start') — unless a brush tool owns the
    // press, then its circle follows the pointer.
    if (e.buttons !== 0 && (this.selectEnabled || !this.press)) return;
    this.requestHover();
  };

  private readonly onHoverPointerLeave = (): void => {
    this.pointer = undefined;
    this.setHovered(undefined);
    this.setSurfaceHover(undefined);
  };

  private requestHover(): void {
    if (this.hoverRequested || !this.pointer) return;
    this.hoverRequested = true;
    requestAnimationFrame(() => {
      this.hoverRequested = false;
      this.updateHover();
    });
  }

  private updateHover(): void {
    const p = this.pointer;
    if (!p || this.navigating || this.cameraMove || this.cubePress) return;
    const width = this.container.clientWidth;
    if (this.viewCube.pick(p.x, p.y, width, this.camera)) {
      this.setHovered(undefined);
      this.setSurfaceHover(undefined);
      return;
    }
    // While painting: no entity hover (no label, and no pick pass on big models).
    this.setHovered(this.stroke ? undefined : this.pick(p.x, p.y));
    this.updateSurfaceHover(p);
  }

  /** Brush tools: find the surface point under `p` and place the cursor there. */
  private updateSurfaceHover(p: { x: number; y: number }): void {
    const m = this.model;
    if (this.selectEnabled || !m?.root.visible) {
      this.setSurfaceHover(undefined);
      return;
    }
    const hit = this.surfaceHitAt(p);
    const h = this.renderer.domElement.clientHeight;
    this.setSurfaceHover(hit && { hit, pxWorld: this.worldPerPixel(hit.point, h) });
    this.strokeTo(p, hit);
  }

  /** World size of one CSS pixel at `point` (perspective camera). */
  private worldPerPixel(point: Vec3, canvasHeight: number): number {
    const dist = this.camera.position.distanceTo(new Vector3(...point));
    return (2 * dist * Math.tan((this.camera.fov * Math.PI) / 360)) / Math.max(1, canvasHeight);
  }

  private setSurfaceHover(at: { hit: SurfaceHit; pxWorld: number } | undefined): void {
    const cursor = toolDef(this.tool).cursor;
    const wasShown = this.brushCursor.current() !== undefined;
    if (at && cursor === 'circle') {
      this.brushCursor.show(at.hit, this.brushRadius, at.pxWorld, this.erasing ? 'erase' : 'brush');
    } else {
      this.brushCursor.hide();
    }
    const preview = this.model?.fillPreview;
    const region = at && this.tool === 'smart-fill' ? this.fillRegionAt(at.hit) : undefined;
    if (preview && (region || preview.mesh.visible)) {
      if (region) preview.show(region.triangles, this.erasing ? ERASE_COLOR : this.brushColor);
      else preview.hide();
      this.requestRender();
    }
    this.overSurface = at !== undefined && cursor !== 'pick';
    this.applyCanvasCursor();
    if (wasShown || this.brushCursor.current()) this.requestRender();
  }

  /** CSS cursor: pointer over the view cube, crosshair over the model with a brush tool. */
  private applyCanvasCursor(): void {
    this.renderer.domElement.style.cursor = this.overCube
      ? 'pointer'
      : this.overSurface
        ? 'crosshair'
        : '';
  }

  private setHovered(hit: PickHit | undefined): void {
    const old = this.hovered;
    if (old?.kind === hit?.kind && old?.id === hit?.id) return;
    this.hovered = hit;
    this.applyHoverHighlight();
    this.onHover?.(hit);
  }

  /**
   * Perf benchmark (dev): one pick per frame at `count` pseudo-random canvas positions (fixed seed),
   * like hovering — each pick waits for the GPU to finish the frame before reading back. Returns
   * the durations in ms.
   */
  benchPick(count: number): Promise<number[]> {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const times: number[] = [];
    let rnd = 12345;
    const next = (): number => {
      rnd = (rnd * 1103515245 + 12345) & 0x7fffffff;
      return rnd / 0x7fffffff;
    };
    return new Promise((done) => {
      const step = (): void => {
        if (times.length >= count) {
          done(times);
          return;
        }
        this.renderNow(); // a real frame first, as during hover
        const t0 = performance.now();
        this.pick(next() * w, next() * h);
        times.push(performance.now() - t0);
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  dispose(): void {
    this.disposed = true;
    this.stopCameraMove();
    this.clearModel();
    this.viewCube.dispose();
    this.container.removeEventListener('pointerdown', this.onCubePointerDown, { capture: true });
    this.container.removeEventListener('pointerup', this.onCubePointerUp, { capture: true });
    this.container.removeEventListener('pointermove', this.onCubePointerMove);
    this.container.removeEventListener('pointerleave', this.onCubePointerLeave);
    this.container.removeEventListener('pointermove', this.onHoverPointerMove);
    this.container.removeEventListener('pointerleave', this.onHoverPointerLeave);
    this.container.removeEventListener('pointerdown', this.onClickPointerDown, { capture: true });
    this.container.removeEventListener('pointerup', this.onClickPointerUp, { capture: true });
    this.container.removeEventListener('dblclick', this.onDoubleClickEvent);
    this.container.removeEventListener('pointerdown', this.onRightPointerDown, { capture: true });
    this.container.removeEventListener('pointermove', this.onRightPointerMove, { capture: true });
    this.container.removeEventListener('pointerup', this.onRightPointerUp, { capture: true });
    this.container.removeEventListener('pointermove', this.onBoxPointerMove);
    this.container.removeEventListener('pointercancel', this.cancelBox);
    window.removeEventListener('keydown', this.onBoxKey, { capture: true });
    window.removeEventListener('keyup', this.onBoxKey, { capture: true });
    this.boxOverlay.remove();
    this.pinOverlay.dispose();
    this.dimensionOverlay.dispose();
    clearTimeout(this.pinSettleTimer);
    this.brushCursor.dispose();
    this.resizeObserver.disconnect();
    this.container.removeEventListener('wheel', this.onWheel, { capture: true });
    this.controls.dispose();
    this.grid?.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private applyNavigationStyle(): void {
    const { left, middle, right } = this.navStyle.mouse;
    this.controls.mouseButtons = {
      LEFT: MOUSE_FOR[left],
      MIDDLE: MOUSE_FOR[middle],
      RIGHT: MOUSE_FOR[right],
    };
  }

  /**
   * Trackpad two-finger swipe → orbit/pan per style. Everything else (mouse wheel, pinch — which
   * arrives as ctrlKey+wheel on macOS and Windows precision touchpads) falls through to
   * OrbitControls, which zooms to the cursor.
   */
  private readonly onWheel = (e: WheelEvent): void => {
    if (e.altKey && this.surfaceTool) {
      // Alt + scroll = brush size / fill angle (OrcaSlicer / PrusaSlicer). Up / away = larger.
      e.preventDefault();
      e.stopPropagation();
      const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      this.wheelResizePx -= px;
      const steps = Math.trunc(this.wheelResizePx / WHEEL_PX_PER_RADIUS_STEP);
      if (steps !== 0) {
        this.wheelResizePx -= steps * WHEEL_PX_PER_RADIUS_STEP;
        this.onSizeStep?.(steps);
      }
      return;
    }
    if (e.ctrlKey) return; // pinch (or Ctrl+wheel): zoom
    const kind = this.wheelClassifier.classify({
      deltaX: e.deltaX,
      deltaY: e.deltaY,
      deltaMode: e.deltaMode,
      shiftKey: e.shiftKey,
      timeStamp: e.timeStamp,
      wheelDeltaY: (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY,
    });
    if (kind !== 'trackpad') return;

    e.preventDefault();
    e.stopPropagation();
    this.finishCameraMove();
    // Natural scrolling: fingers moving right give negative deltaX, like dragging right.
    const dx = -e.deltaX;
    const dy = -e.deltaY;
    if (trackpadSwipeAction(this.navStyle, e.shiftKey) === 'orbit') {
      const h = this.renderer.domElement.clientHeight || 1;
      // Same scale as OrbitControls' mouse rotation (full height = one turn).
      this.controls.rotateLeft((2 * Math.PI * dx * this.controls.rotateSpeed) / h);
      this.controls.rotateUp((2 * Math.PI * dy * this.controls.rotateSpeed) / h);
    } else {
      this.controls.pan(dx * this.controls.panSpeed, dy * this.controls.panSpeed);
    }
    this.requestRender();
  };

  /** Re-apply devicePixelRatio when the window moves between displays (Retina ↔ non-Retina). */
  private watchPixelRatio(): void {
    const query = window.matchMedia(`(resolution: ${String(window.devicePixelRatio)}dppx)`);
    query.addEventListener(
      'change',
      () => {
        if (this.disposed) return;
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.resize();
        this.watchPixelRatio(); // the query is tied to the old ratio; listen for the next change
      },
      { once: true },
    );
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.applyViewOffset(); // also updates the projection
    this.applyHighlightViewport();
    // Render synchronously so the canvas never shows a stretched frame while resizing.
    this.render();
  }

  private requestRender(): void {
    if (this.frameRequested) return;
    this.frameRequested = true;
    requestAnimationFrame(() => {
      this.frameRequested = false;
      this.render();
    });
  }

  private render(): void {
    // During a camera move the camera is placed directly (may be rolled off the orbit axis).
    if (!this.cameraMove) this.controls.update();
    this.renderNow();
  }

  private renderNow(): void {
    const t0 = performance.now();
    this.paintBuildMs = 0;
    const m = this.model;
    if (m && this.paintLayer?.triangleCount === m.source.triangleFace.length) {
      const styles = focusedStyles(this.markerStyles, this.focusMarkers, PALETTE[this.theme].face);
      this.paintBuildMs = m.paint.update(this.paintLayer, styles, m.visible);
    } else if (m) {
      m.paint.mesh.visible = false;
      m.paint.pieceMesh.visible = false;
    }
    this.renderer.render(this.scene, this.camera);
    this.movePins();
    this.moveDimensions();
    this.viewCube.render(this.renderer, this.camera, this.container.clientWidth);
    this.onFrame?.(t0, performance.now() - t0);
  }

  /** Paint overlay rebuild time of the last drawn frame, ms (0 = nothing changed; perf probe). */
  paintBuildMs = 0;

  /** Perf probe (dev): called after every drawn frame with its start time and CPU draw time. */
  onFrame: ((timestampMs: number, cpuMs: number) => void) | undefined;

  /** Called when the user starts / stops orbiting, panning or zooming with the pointer. */
  onNavigate(listener: (active: boolean) => void): void {
    this.controls.addEventListener('start', () => {
      listener(true);
    });
    this.controls.addEventListener('end', () => {
      listener(false);
    });
  }

  /** Resolves after the next frame has been drawn (and the one after, so it reached the screen). */
  afterNextFrame(): Promise<void> {
    this.requestRender();
    return new Promise((done) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          done();
        });
      });
    });
  }

  /**
   * Perf benchmark (dev): one brush stroke of `frames` steps (one per frame) across the middle of
   * the view with a gentle wave, as a drag in the current tool would run it. Returns the time
   * each step took on the CPU (raycast + sphere query + `onStroke`), ms; the paint overlay rebuild
   * shows up in the frame times.
   */
  benchStroke(frames: number): Promise<number[]> {
    this.finishCameraMove();
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    const times: number[] = [];
    this.stroke = { last: undefined, erase: false, fill: !this.brushTool };
    this.onStrokeStart?.(false);
    return new Promise((done) => {
      let i = 0;
      const step = (): void => {
        if (i >= frames) {
          this.endStroke();
          this.requestRender();
          done(times);
          return;
        }
        const f = i++ / Math.max(1, frames - 1);
        const p = { x: w * (0.15 + 0.7 * f), y: h * (0.5 + 0.15 * Math.sin(f * 4 * Math.PI)) };
        const t0 = performance.now();
        this.strokeTo(p, this.surfaceHitAt(p));
        times.push(performance.now() - t0);
        this.requestRender();
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  /** Perf benchmark (dev): orbit once around the model in `frames` steps, one per frame. */
  benchOrbit(frames: number): Promise<void> {
    this.finishCameraMove();
    return new Promise((done) => {
      let i = 0;
      const step = (): void => {
        if (i++ >= frames) {
          done();
          return;
        }
        this.controls.rotateLeft((2 * Math.PI) / frames);
        // A gentle up/down wobble so views from above and below are included.
        // Each rotate* updates the controls → 'change' → one render on the next frame.
        this.controls.rotateUp(0.6 * Math.sin((4 * Math.PI * i) / frames) * (Math.PI / frames));
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }
}
