/**
 * Annotation schema: what `<model>.thirdwheel.json` holds and what the review payload is
 * built from. Pure zod, no I/O (saving / loading is elsewhere; the written spec is docs/file-format.md).
 *
 * Markers are separate from comments: a marker holds paint and / or
 * exact B-rep entities; a comment references markers by id only. There is no separate
 * "selections" list — a selection the user wants to keep becomes a marker.
 *
 * Unknown keys are dropped on read (a newer v1 writer may add optional fields); a higher
 * `schemaVersion` is refused with a clear message instead of being misread.
 */
import { z } from 'zod';

export const SCHEMA_VERSION = 1;

/** Upper bounds keep a broken or hostile file from blowing up the UI. */
export const MAX_ID_LENGTH = 64;
export const MAX_NAME_LENGTH = 60;
export const MAX_COMMENT_LENGTH = 10_000;
/** Linked model files per comment and the longest file name kept. */
export const MAX_LINKED_MODELS = 8;
export const MAX_LINKED_MODEL_NAME = 255;
/** Replies per comment. */
export const MAX_REPLIES = 500;
/** Part items per comment, parameters per part, and the longest text in a part (part requests). */
export const MAX_PART_ITEMS = 50;
export const MAX_PART_PARAMS = 12;
export const MAX_PART_TEXT = 2000;

const id = z.string().min(1).max(MAX_ID_LENGTH);
const index = z.number().int().nonnegative();
const isoTime = z.iso.datetime({ offset: true });

/** `#rrggbb`, lower case (as `normalizeColor` in the app writes it). */
export const colorSchema = z
  .string()
  .regex(/^#[0-9a-f]{6}$/, 'colour must be #rrggbb (lower case)');

export const modelFormatSchema = z.enum(['step', 'stl', '3mf']);
export type ModelFormat = z.infer<typeof modelFormatSchema>;

export const modelInfoSchema = z.object({
  /** File name only (no folder): the sidecar sits next to the model. */
  fileName: z
    .string()
    .min(1)
    .refine((n) => !/[/\\]/.test(n), 'fileName must be a file name, not a path'),
  format: modelFormatSchema,
  /** `sha256:<64 hex>` of the model file's bytes. Mismatch → revision transfer via `samples`. */
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/, 'contentHash must be sha256:<64 hex>'),
  /**
   * `sha256:<64 hex>` of our mesh + entity maps (geometry `meshHash`). Same mesh hash on a
   * changed file = same geometry: the annotations fit as they are. A malformed one is dropped.
   */
  meshHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional()
    .catch(undefined),
});
export type ModelInfo = z.infer<typeof modelInfoSchema>;

/** Same fields as `TessellationSettings` in `@third-wheel/geometry` (mm, radians). */
export const tessellationSchema = z.object({
  linearDeflection: z.number().positive(),
  angularDeflection: z.number().positive(),
});
export type Tessellation = z.infer<typeof tessellationSchema>;

export const entityKindSchema = z.enum(['vertex', 'edge', 'face', 'body']);
export type EntityKind = z.infer<typeof entityKindSchema>;

const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/**
 * What a held entity looked like when saved, so a later model revision can find it again
 * by geometry: ids change between revisions, type / size / position mostly don't. Written by
 * the app, never needed to load; a malformed one is dropped, not the file. Lengths in mm.
 */
export const entityFingerprintSchema = z.object({
  /** Index into `bodies` (this file's body fingerprints). */
  body: index.optional(),
  /** Surface / curve type: `plane`, `cylinder`, `line`, `circle`, … */
  type: z.string().max(MAX_ID_LENGTH).optional(),
  /** Vertex position; face: area-weighted centre of its mesh; edge: midpoint along it; body: bbox centre. */
  point: vec3.optional(),
  /** Edge length. */
  length: z.number().optional(),
  /** Face / body mesh area (mm²). */
  area: z.number().optional(),
  /** Circle, cylinder, sphere radius; torus major radius. */
  radius: z.number().optional(),
  minorRadius: z.number().optional(),
  /** Plane normal, line direction, or axis (circle, cylinder, cone, torus). */
  dir: vec3.optional(),
  /** Cone half-angle, degrees. */
  halfAngle: z.number().optional(),
  form: z.enum(['hole', 'shaft', 'hollow', 'ball']).optional(),
  /** Body: bounding-box size. */
  size: vec3.optional(),
  /**
   * Face: bounding box of its mesh, `[min, max]`: tells apart turns that fit a
   * mark equally well (a stroke on a flat top), unlike the centre it ignores cut-outs inside.
   */
  bounds: z.tuple([vec3, vec3]).optional(),
});
export type EntityFingerprint = z.infer<typeof entityFingerprintSchema>;

/** An exact B-rep entity held by a marker. `seq` grows with every add (across markers): last added wins when drawn. */
export const markerEntitySchema = z.object({
  kind: entityKindSchema,
  /** OCCT traversal index (ADR 001), never an OCCT hash. */
  id: index,
  seq: index,
  fingerprint: entityFingerprintSchema.optional().catch(undefined),
});
export type MarkerEntityData = z.infer<typeof markerEntitySchema>;

/**
 * Paint of one cut triangle for one marker: 1 = painted, 0 = not, or 4 pieces — children
 * 0 (a, ab, ca), 1 (ab, b, bc), 2 (ca, bc, c), 3 (ab, bc, ca), where ab… are edge midpoints
 * (same order as `PaintNode` in the app).
 */
export type PieceTree = 0 | 1 | readonly [PieceTree, PieceTree, PieceTree, PieceTree];

export const pieceTreeSchema: z.ZodType<PieceTree> = z.lazy(() =>
  z.union([
    z.literal(0),
    z.literal(1),
    z.tuple([pieceTreeSchema, pieceTreeSchema, pieceTreeSchema, pieceTreeSchema]),
  ]),
);

/** A triangle partly painted by this marker. The tree's root is always cut (4 children). */
export const paintPiecesSchema = z.object({
  triangle: index,
  tree: z.tuple([pieceTreeSchema, pieceTreeSchema, pieceTreeSchema, pieceTreeSchema]),
});
export type PaintPieces = z.infer<typeof paintPiecesSchema>;

/**
 * Runs of consecutive triangle numbers: `[first, count]` = triangles first … first + count − 1.
 * Our tessellation numbers triangles face by face, so a painted area is mostly a few long runs
 * (a whole painted face is one run) — keeps sidecars small.
 */
export const triangleRunSchema = z.tuple([index, z.number().int().positive()]);
export type TriangleRun = z.infer<typeof triangleRunSchema>;

/** Paint of one marker on one CAD face. Triangle numbers are indices in the whole import (our tessellation). */
/** Flat `x y z` triples (mm). */
const pointsSchema = z
  .array(z.number())
  .refine((a) => a.length % 3 === 0, 'samples must be x y z triples');

export const facePaintSchema = z.object({
  faceId: index,
  /** Wholly painted triangles, as runs (ascending, not overlapping). */
  triangles: z.array(triangleRunSchema),
  /** Triangles the brush cut into pieces. */
  pieces: z.array(paintPiecesSchema).optional(),
  /**
   * Points spread evenly over this face's paint: where the paint goes on a new revision of
   * the model. Written by the app, never needed to load.
   */
  samples: pointsSchema.optional().catch(undefined),
  /**
   * Points on this face just outside the paint: where the paint ends, so a moved brush
   * stroke keeps its outline.
   */
  clear: pointsSchema.optional().catch(undefined),
  /** What the painted CAD face looked like, as for held entities. */
  fingerprint: entityFingerprintSchema.optional().catch(undefined),
});
export type FacePaint = z.infer<typeof facePaintSchema>;

export const markerPaintSchema = z.object({
  faces: z.array(facePaintSchema),
  /**
   * Painted triangles' centres (older files; newer ones keep points per face in
   * `faces[].samples`). Still read: the revision transfer falls back to them for older files.
   */
  samples: pointsSchema.optional(),
});

/**
 * How a marker came over from the previous version of the model, left out when it was found
 * where it was. `changed` = moved or resized (the user confirms); `lost` = nothing matched;
 * `check` = not moved on purpose (a mirrored body). Cleared when the user says it looks right.
 */
export const transferStatusSchema = z.enum(['changed', 'lost', 'check']);

export const markerTransferSchema = z.object({
  status: transferStatusSchema,
  /** File name of the previous version. */
  from: z.string().min(1).max(1000),
  /**
   * The parts of the marker that could not be placed, where they would be on this model (moved
   * with their body; drawn as ghosts): painted faces' points and fingerprints, held entities'
   * fingerprints (`body` = index into this file's `bodies`). Tried again on the next version.
   */
  ghost: z
    .object({
      faces: z
        .array(
          z.object({
            samples: pointsSchema,
            clear: pointsSchema.optional(),
            fingerprint: entityFingerprintSchema.optional(),
          }),
        )
        .optional(),
      entities: z.array(entityFingerprintSchema.extend({ kind: entityKindSchema })).optional(),
    })
    .optional(),
});
export type MarkerTransfer = z.infer<typeof markerTransferSchema>;

export const markerSchema = z.object({
  id,
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  color: colorSchema,
  visible: z.boolean(),
  /** Exact entities in the order they were added. */
  entities: z.array(markerEntitySchema),
  paint: markerPaintSchema,
  /** A malformed one is dropped (the marker counts as found), never the marker. */
  transfer: markerTransferSchema.optional().catch(undefined),
});
export type MarkerData = z.infer<typeof markerSchema>;

export const commentStatusSchema = z.enum(['open', 'resolved', 'wontfix']);
export type CommentStatus = z.infer<typeof commentStatusSchema>;

export const commentAuthorSchema = z.enum(['human', 'ai']);
export type CommentAuthor = z.infer<typeof commentAuthorSchema>;

/**
 * A reply in a comment's thread, by the user or the AI. `status` = the status the comment
 * was set to with this reply (the AI's "resolved: added a 2 mm fillet"; a user's reply on a
 * closed comment reopens it → "open").
 */
export const commentReplySchema = z.object({
  /** Unique within its comment ("r1", "r2", …). */
  id,
  text: z.string().min(1).max(MAX_COMMENT_LENGTH),
  author: commentAuthorSchema,
  createdAt: isoTime,
  updatedAt: isoTime,
  status: commentStatusSchema.optional(),
});
export type CommentReplyData = z.infer<typeof commentReplySchema>;

/** A build parameter of a part, e.g. `size: "M5-0.8"`, `length: 16`, `simple: true`. */
const partParamValueSchema = z.union([z.string().max(100), z.number(), z.boolean()]);

/**
 * Where a requested part comes from. Only the parts library so far; a part cut out of another model
 * file will be another `kind`.
 */
export const partSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('library'),
    /** "bd_warehouse". */
    library: z.string().min(1).max(40),
    /** The library version the class and parameters are meant for (names and sizes change). */
    version: z.string().max(40).optional(),
    /** The class, e.g. "SocketHeadCapScrew". */
    cls: z.string().min(1).max(80),
    /** What the user chose; left out = the AI chooses (for example the size from the hole it goes in). */
    params: z
      .record(z.string().min(1).max(40), partParamValueSchema)
      .refine(
        (p) => Object.keys(p).length <= MAX_PART_PARAMS,
        `at most ${String(MAX_PART_PARAMS)} parameters`,
      ),
  }),
]);
export type PartSource = z.infer<typeof partSourceSchema>;

/** The whole part, or only named sub-parts of it (names without the " [n]" the app adds to repeats). */
export const partScopeSchema = z.union([
  z.literal('whole'),
  z.object({ subparts: z.array(z.string().min(1).max(100)).min(1).max(20) }),
]);
export type PartScope = z.infer<typeof partScopeSchema>;

/**
 * Where the part goes in this model: markers of the comment. `each` (default): one set of copies per
 * marker; `pattern`: spread the copies over the marker's painted area.
 */
export const partTargetSchema = z.object({
  markerIds: z.array(id).max(50),
  mode: z.enum(['each', 'pattern']).optional(),
  /** Distance between copies in a pattern, mm. */
  spacing: z.number().positive().optional(),
});
export type PartTarget = z.infer<typeof partTargetSchema>;

/** What the AI did with a part, written through the bridge. */
export const partResultStatusSchema = z.enum(['placed', 'skipped', 'failed', 'needs-info']);
export type PartResultStatus = z.infer<typeof partResultStatusSchema>;
export const partResultSchema = z.object({
  status: partResultStatusSchema,
  /** Names of the bodies it created, so later comments can refer to them. */
  bodies: z.array(z.string().max(1000)).max(200).optional(),
  note: z.string().max(MAX_PART_TEXT).optional(),
  updatedAt: isoTime,
});
export type PartResult = z.infer<typeof partResultSchema>;

export const partItemSchema = z.object({
  /** Unique within its comment ("p1", "p2", …). */
  id,
  source: partSourceSchema,
  copies: z.number().int().min(1).max(999),
  scope: partScopeSchema,
  /** Left out = the comment's text says where. Its markers must be among the comment's. */
  target: partTargetSchema.optional(),
  /** The user's words about this part ("M5, 16 mm long, flush with the surface"). */
  note: z.string().max(MAX_PART_TEXT).optional(),
  result: partResultSchema.optional(),
});
export type PartItemData = z.infer<typeof partItemSchema>;

export const commentSchema = z.object({
  id,
  text: z.string().min(1).max(MAX_COMMENT_LENGTH),
  /** Markers this comment is about (may be empty: a general remark). One marker may serve several comments. */
  markerIds: z.array(id),
  status: commentStatusSchema,
  author: commentAuthorSchema,
  createdAt: isoTime,
  updatedAt: isoTime,
  /**
   * Before threads: the AI's note on the last status change. Still read (shown as the thread's first
   * reply, see `commentThread`); never written any more.
   */
  note: z.string().max(MAX_COMMENT_LENGTH).optional(),
  /** The thread under the comment, oldest first. Left out when empty. */
  replies: z.array(commentReplySchema).max(MAX_REPLIES).optional(),
  /**
   * Other model files this comment is about, by file name ("this pocket must fit the
   * lid"). Names, not paths: the files may move. Left out when empty.
   */
  linkedModels: z
    .array(z.string().min(1).max(MAX_LINKED_MODEL_NAME))
    .max(MAX_LINKED_MODELS)
    .optional(),
  /**
   * The AI closed it (resolved / won't fix) and the user hasn't confirmed yet: stays in the
   * list until they click Confirm or Reopen. Left out otherwise.
   */
  awaitingConfirm: z.literal(true).optional().catch(undefined),
  /**
   * Parts the user asks for (part requests): the comment's text is the instruction, these are the
   * choices. A malformed list is dropped (the comment stays), never the file. Left out when empty.
   */
  parts: z.array(partItemSchema).max(MAX_PART_ITEMS).optional().catch(undefined),
});
export type CommentData = z.infer<typeof commentSchema>;

/**
 * Where a row of the body list sits: the top level, a STEP assembly (index into the model's
 * assemblies) or a user folder.
 */
export const treePlaceSchema = z.union([
  z.literal('top'),
  z.object({ assembly: index }),
  z.object({ folder: id }),
]);
export type TreePlace = z.infer<typeof treePlaceSchema>;

export const userFolderSchema = z.object({
  id,
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  parent: treePlaceSchema,
});
export type UserFolderData = z.infer<typeof userFolderSchema>;

/**
 * The user's own folders in the body list and the bodies / STEP assemblies moved out of their STEP
 * place. Only sorts the list: the model file is never changed. Rows not listed stay where
 * the STEP puts them. Entries that don't fit the model (unknown folder, id out of range, a folder
 * inside itself) are dropped by the app, not refused here, so a bad entry never costs the paint.
 */
export const bodyTreeSchema = z.object({
  folders: z.array(userFolderSchema),
  bodies: z.array(z.object({ body: index, parent: treePlaceSchema })),
  assemblies: z.array(z.object({ assembly: index, parent: treePlaceSchema })),
});
export type BodyTreeData = z.infer<typeof bodyTreeSchema>;

export const MAX_BODY_NAME_LENGTH = 1000;

/**
 * Every body of the model when saved, by body index: name and size, so bodies (and what
 * points at them: entities, `bodyTree`) can be matched by name, then size, after the STEP changes
 *. Mesh numbers, mm.
 */
export const bodyFingerprintSchema = z.object({
  name: z.string().max(MAX_BODY_NAME_LENGTH),
  /** Enclosing assemblies, outermost first, joined with " › "; left out at the top level. */
  path: z.string().max(MAX_BODY_NAME_LENGTH).optional(),
  /** Bounding-box size and centre. */
  size: vec3,
  centre: vec3,
  area: z.number(),
});
export type BodyFingerprint = z.infer<typeof bodyFingerprintSchema>;

/** Most links kept per list of a version chain; older ones are dropped first. */
export const MAX_VERSION_LINKS = 100;
export const MAX_VERSION_PATH = 4096;

/**
 * One other version of the model in its version chain: where the file was, its name and
 * the content hash of the version meant (a moved file is found again by it), and when the link
 * was made. `overwritten`: the file at `path` was replaced by a newer version (Reload with
 * changes), so these contents are gone from disk.
 */
export const versionLinkSchema = z.object({
  path: z.string().min(1).max(MAX_VERSION_PATH),
  name: z.string().min(1).max(MAX_LINKED_MODEL_NAME),
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  date: isoTime,
  overwritten: z.literal(true).optional(),
});
export type VersionLink = z.infer<typeof versionLinkSchema>;

/**
 * Version chain (a tree: one earlier version per file): made only by "Import new version", "Bring my notes
 * over" and the AI's `load_model` with `revisionOf` (and a file overwritten in place), never by
 * names. `earlier[0]` is the one version this file was made from — **the truth** of the chain; the
 * rest of `earlier` is a cache of that version's own earlier ones, used only where their notes
 * can't be read (file moved, overwritten). `newer`: signposts to versions made from this one,
 * trusted only when that file's `earlier[0]` names this one (several = variants). `unlinked`: the
 * user removed this file from its chain; the automatic version guesses leave it out until
 * it is linked again.
 */
export const versionChainSchema = z.object({
  earlier: z.array(versionLinkSchema).max(MAX_VERSION_LINKS).optional(),
  newer: z.array(versionLinkSchema).max(MAX_VERSION_LINKS).optional(),
  unlinked: isoTime.optional(),
});
export type VersionChain = z.infer<typeof versionChainSchema>;

export const annotationsSchema = z
  .object({
    schemaVersion: z.literal(SCHEMA_VERSION),
    model: modelInfoSchema,
    /** Required for STEP (triangle numbers depend on it); meshes (STL / 3MF) are used as they are. */
    tessellation: tessellationSchema.optional(),
    markers: z.array(markerSchema),
    comments: z.array(commentSchema),
    /** Left out while the user has no folders and moved nothing. */
    /** A malformed one is dropped (folders lost), never the whole file (paint kept). */
    bodyTree: bodyTreeSchema.optional().catch(undefined),
    /** Body fingerprints by body index; for revision matching only, never needed to load. */
    bodies: z.array(bodyFingerprintSchema).optional().catch(undefined),
    /** Other versions of this model. A malformed chain is dropped, never the file. */
    versions: versionChainSchema.optional().catch(undefined),
  })
  .superRefine((doc, ctx) => {
    if (doc.model.format === 'step' && !doc.tessellation) {
      ctx.addIssue({
        code: 'custom',
        path: ['tessellation'],
        message: 'STEP models need tessellation settings',
      });
    }
    checkUnique(doc.markers, (m) => m.id, ['markers'], 'marker id', ctx);
    checkUnique(doc.comments, (c) => c.id, ['comments'], 'comment id', ctx);

    const markerIds = new Set(doc.markers.map((m) => m.id));
    doc.comments.forEach((c, ci) => {
      checkUnique(c.markerIds, (m) => m, ['comments', ci, 'markerIds'], 'marker reference', ctx);
      checkUnique(c.replies ?? [], (r) => r.id, ['comments', ci, 'replies'], 'reply id', ctx);
      checkUnique(c.parts ?? [], (p) => p.id, ['comments', ci, 'parts'], 'part id', ctx);
      (c.parts ?? []).forEach((p, pi) => {
        (p.target?.markerIds ?? []).forEach((m, mi) => {
          if (!c.markerIds.includes(m)) {
            ctx.addIssue({
              code: 'custom',
              path: ['comments', ci, 'parts', pi, 'target', 'markerIds', mi],
              message: `part "${p.id}" is for marker "${m}", which the comment does not name`,
            });
          }
        });
      });
      c.markerIds.forEach((m, mi) => {
        if (!markerIds.has(m)) {
          ctx.addIssue({
            code: 'custom',
            path: ['comments', ci, 'markerIds', mi],
            message: `unknown marker "${m}"`,
          });
        }
      });
    });

    checkMarkerPaint(doc.markers, ['markers'], ctx);
  });
export type Annotations = z.infer<typeof annotationsSchema>;

/**
 * Paint and entity checks shared by v1 sidecars and v2 marks files: unique entities and faces per
 * marker, one marker per whole triangle, a whole triangle never also cut.
 */
export function checkMarkerPaint(
  markers: readonly Pick<MarkerData, 'id' | 'entities' | 'paint'>[],
  base: (string | number)[],
  ctx: z.RefinementCtx,
): void {
  // One marker per whole triangle; a whole triangle is never also cut. Pieces of one cut
  // triangle may belong to several markers (each marker stores its own tree). Runs are checked
  // as intervals (never expanded: a hostile count can't blow up memory).
  const runs: { first: number; end: number; marker: string; path: (string | number)[] }[] = [];
  const cut: { t: number; path: (string | number)[] }[] = [];
  markers.forEach((m, mi) => {
    checkUnique(
      m.entities,
      (e) => `${e.kind}:${String(e.id)}`,
      [...base, mi, 'entities'],
      'entity',
      ctx,
    );
    checkUnique(
      m.paint.faces,
      (f) => String(f.faceId),
      [...base, mi, 'paint', 'faces'],
      'face',
      ctx,
    );
    const ownCut = new Set<number>();
    m.paint.faces.forEach((f, fi) => {
      const at = [...base, mi, 'paint', 'faces', fi];
      for (const [first, n] of f.triangles) {
        runs.push({ first, end: first + n, marker: m.id, path: [...at, 'triangles'] });
      }
      for (const p of f.pieces ?? []) {
        if (ownCut.has(p.triangle)) {
          ctx.addIssue({
            code: 'custom',
            path: [...at, 'pieces'],
            message: `triangle ${String(p.triangle)} is listed twice in this marker`,
          });
        }
        ownCut.add(p.triangle);
        cut.push({ t: p.triangle, path: [...at, 'pieces'] });
      }
    });
  });
  runs.sort((a, b) => a.first - b.first);
  let reach: (typeof runs)[number] | undefined;
  for (const r of runs) {
    if (reach && r.first < reach.end) {
      const by = reach.marker === r.marker ? 'this marker' : `marker "${reach.marker}"`;
      ctx.addIssue({
        code: 'custom',
        path: r.path,
        message: `triangle ${String(r.first)} is already painted by ${by}`,
      });
    }
    if (!reach || r.end > reach.end) reach = r;
  }
  for (const c of cut) {
    const by = runCovering(runs, c.t);
    if (by !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: base,
        message: `triangle ${String(c.t)} is painted whole by marker "${by}" and cut into pieces`,
      });
    }
  }
}

/** Marker of a run (sorted by `first`) holding triangle `t`, if any. */
function runCovering(
  runs: readonly { first: number; end: number; marker: string }[],
  t: number,
): string | undefined {
  // Last run starting at or before t (overlapping runs are reported separately).
  let lo = 0;
  let hi = runs.length - 1;
  let at: (typeof runs)[number] | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = runs[mid];
    if (r && r.first <= t) {
      at = r;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (at && t < at.end) return at.marker;
  return undefined;
}

function checkUnique<T>(
  items: readonly T[],
  key: (item: T) => string,
  path: (string | number)[],
  what: string,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    const k = key(item);
    if (seen.has(k))
      ctx.addIssue({ code: 'custom', path: [...path, i], message: `duplicate ${what} "${k}"` });
    seen.add(k);
  });
}

/** An annotation set with no markers and no comments. STEP models need `tessellation`. */
export function emptyAnnotations(
  model: ModelInfo & { format: 'step' },
  tessellation: Tessellation,
): Annotations;
export function emptyAnnotations(
  model: ModelInfo & { format: 'stl' | '3mf' },
  tessellation?: Tessellation,
): Annotations;
export function emptyAnnotations(model: ModelInfo, tessellation?: Tessellation): Annotations {
  return {
    schemaVersion: SCHEMA_VERSION,
    model: { ...model },
    ...(tessellation ? { tessellation: { ...tessellation } } : {}),
    markers: [],
    comments: [],
  };
}

export type ParseResult =
  | {
      readonly ok: true;
      readonly data: Annotations;
      /**
       * Paths of fields in the file that were dropped on read (unknown keys, e.g. from a newer
       * writer, or a malformed `bodyTree`): `markers.0.label`. They are lost on the next save.
       */
      readonly droppedFields: readonly string[];
    }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Check parsed JSON. Errors are short, readable lines like `markers.0.color: colour must be #rrggbb`. */
export function parseAnnotations(input: unknown): ParseResult {
  const version =
    typeof input === 'object' && input !== null && 'schemaVersion' in input
      ? input.schemaVersion
      : undefined;
  if (typeof version !== 'number') {
    return { ok: false, errors: ['not a Third Wheel annotation file (no schemaVersion)'] };
  }
  if (version > SCHEMA_VERSION) {
    return {
      ok: false,
      errors: [
        `made by a newer version of Third Wheel (schema ${String(version)}; this app reads ${String(SCHEMA_VERSION)}) — please update the app`,
      ],
    };
  }
  const result = annotationsSchema.safeParse(input);
  if (result.success) {
    return { ok: true, data: result.data, droppedFields: droppedFields(input, result.data) };
  }
  return {
    ok: false,
    errors: result.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.map(String).join('.')}: ${i.message}` : i.message,
    ),
  };
}

/** Parse a sidecar's text (JSON syntax errors become a readable error, not a throw). */
export function parseAnnotationsJson(text: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ok: false, errors: [`not valid JSON: ${e instanceof Error ? e.message : String(e)}`] };
  }
  return parseAnnotations(json);
}

/** Fields present in `raw` (parsed JSON) but missing from what the schema kept. */
export function droppedFields(raw: unknown, kept: unknown, path = ''): string[] {
  const out: string[] = [];
  const at = (k: string | number): string => (path ? `${path}.${String(k)}` : String(k));
  if (Array.isArray(raw) && Array.isArray(kept)) {
    raw.forEach((x, i) => out.push(...droppedFields(x, kept[i], at(i))));
  } else if (isRecord(raw) && isRecord(kept)) {
    for (const [k, x] of Object.entries(raw)) {
      if (x === undefined) continue;
      if (kept[k] === undefined) out.push(at(k));
      else out.push(...droppedFields(x, kept[k], at(k)));
    }
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
