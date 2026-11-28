/**
 * App bridge methods for the MCP tools: params (checked by the app with these schemas)
 * and results. The MCP server (`packages/mcp-server`) turns them into tools; spec in
 * `docs/mcp-tools.md`. Pure — shared by the app window and the MCP server.
 */
import { z } from 'zod';
import {
  commentStatusSchema,
  MAX_COMMENT_LENGTH,
  MAX_PART_ITEMS,
  MAX_PART_TEXT,
  partResultStatusSchema,
  type CommentStatus,
} from './schema.js';

/** Hex characters of the content hash used as the model id. */
const MODEL_ID_HEX = 12;

/**
 * Short id the AI uses for a model file: the first 12 hex digits of its `sha256:` content hash.
 * A new export of the CAD gives a new id (old annotations then come over by revision transfer).
 */
export function modelIdOf(contentHash: string): string {
  return contentHash.replace(/^sha256:/, '').slice(0, MODEL_ID_HEX);
}

/** STEP files: full experience (entity selection, versions). */
export const STEP_EXTENSIONS: readonly string[] = ['.step', '.stp'];
/** Mesh files (mesh-only mode): brush + comments, no entity selection. */
export const MESH_EXTENSIONS: readonly string[] = ['.stl', '.3mf'];
/** Model files `load_model` and the Open dialog open. */
export const LOADABLE_EXTENSIONS: readonly string[] = [...STEP_EXTENSIONS, ...MESH_EXTENSIONS];

/** Longest `wait_for_review` long-poll, seconds. */
export const MAX_WAIT_SECONDS = 300;
/** Region pictures: default and largest square size, px (kept small: fewer tokens for the AI). */
export const DEFAULT_RENDER_SIZE = 384;
export const MAX_RENDER_SIZE = 768;
export const MIN_RENDER_SIZE = 64;
/** Most groups in one contact sheet. */
export const MAX_RENDER_GROUPS = 4;
const MAX_IDS = 200;
const idText = z.string().min(1).max(64);
const modelId = z.string().min(1).max(64);

/**
 * `load` (main reads the file, then the window shows it). `revisionOf`: modelId of a model
 * loaded earlier in this session that the new file is a new version of (another file name).
 */
export const loadParamsSchema = z.object({
  path: z.string().min(1).max(4096),
  revisionOf: modelId.optional(),
});

/**
 * How the previous version's annotations came to the new one: `carried` = same geometry,
 * moved over exactly; `moved` = geometry changed, moved over by matching geometry (see
 * `transfer`); `waiting` = geometry changed and the move failed (kept, not shown); `none` = it had
 * none; `own` = the new file already has its own annotations (they are used).
 */
export type RevisionAnnotations = 'carried' | 'moved' | 'waiting' | 'none' | 'own';

/** A marker the transfer could not place exactly. */
export interface TransferredMarker {
  readonly id: string;
  readonly name: string;
  /** `changed` moved / resized (please confirm); `lost` nothing matched; `check` mirrored body. */
  readonly status: 'changed' | 'lost' | 'check';
}

/** Result of moving annotations onto changed geometry. */
export interface TransferSummary {
  readonly found: number;
  readonly changed: number;
  readonly lost: number;
  readonly check: number;
  /** Every marker not found where it was. */
  readonly flagged: readonly TransferredMarker[];
  /** Paint moved from a mesh file (STL / 3MF) onto this STEP — how well it matched. */
  readonly fromMesh?: MeshCoverage;
  /**
   * STEP → STEP: why the new file looks like another part, not a version (most markers lost, or a
   * very different size), e.g. "6 of 8 markers lost". The markers were moved anyway.
   */
  readonly looksDifferent?: string;
}

/** Mesh → STEP coverage report: paint points of a mesh's notes landed on the STEP surface. */
export interface MeshCoverage {
  /** Painted sample points in all markers. */
  readonly points: number;
  /** Of those, on the STEP surface within `toleranceMm`. */
  readonly matched: number;
  /** Share (0..1) of the mesh's surface lying on the STEP surface once lined up. */
  readonly surface: number;
  /** max(0.5 mm, 1 % of the STEP model's largest side). */
  readonly toleranceMm: number;
  /** The mesh only fits as a mirror image: every marker is "check". */
  readonly mirrored: boolean;
  /** False: the mesh file couldn't be read; `surface` is then the share of the paint points. */
  readonly meshRead: boolean;
}

export interface RevisionInfo {
  /** File name of the previous version. */
  readonly of: string;
  readonly path: string;
  readonly annotations: RevisionAnnotations;
  /** The previous version's markers and comments. */
  readonly markers: number;
  readonly comments: number;
  /** Set when `annotations` is `moved`. */
  readonly transfer?: TransferSummary;
  /**
   * `own`: names of the new file's markers that are the part's markers of the same name (they
   * took that marker's id, colour and comments).
   */
  readonly matched?: readonly string[];
  /** `own`: its markers that got a free colour (`taken` = the colour another marker has). */
  readonly recoloured?: readonly { readonly name: string; readonly taken: string }[];
}

export interface LoadResult {
  readonly modelId: string;
  readonly name: string;
  readonly path: string;
  readonly bodies: number;
  readonly faces: number;
  /** Set for a mesh file: paint + comments only, no entity ids (`faces` = bodies). */
  readonly mesh?: 'stl' | '3mf';
  readonly markers: number;
  /** Comments by status. */
  readonly comments: Readonly<Record<CommentStatus, number>>;
  /** Set when the file is a new version of a model loaded before. */
  readonly revision?: RevisionInfo;
  /**
   * The file looks like a newer copy of a model loaded this session, but `revisionOf` was
   * not given — what to do about it.
   */
  readonly hint?: string;
  /** A version link was moved, or refused (a circle). */
  readonly warning?: string;
  /**
   * With `revisionOf`: the user's body names from the previous version are mostly gone from this file
   * (a CAD round trip dropped them) — how to put them back.
   */
  readonly namesLost?: string;
  /** The project the model belongs to: save new versions into `folder`. */
  readonly project?: { readonly name: string; readonly folder: string };
  /** A free path in the project folder for the next export (`part_v2.step` → `part_v3.step`). */
  readonly saveNextAs?: string;
}

/** `annotations`: the review payload (geometry `reviewPayload`) as an object. */
export const annotationsParamsSchema = z.object({
  modelId,
  /** Comment statuses to include (default: open only). */
  statuses: z.array(commentStatusSchema).min(1).max(3).optional(),
});

/** Most other models one review request can cover. */
export const MAX_ALSO_MODELS = 3;

/**
 * `request_review`: show the user a review request with an optional message. `modelId` is the shown
 * model; `alsoModelIds` are other models loaded this session that belong to the same review (
 * two parts that must fit) — the banner lets the user switch between them, one Send answers all.
 */
export const requestReviewParamsSchema = z.object({
  modelId,
  alsoModelIds: z.array(modelId).max(MAX_ALSO_MODELS).optional(),
  message: z.string().max(2000).optional(),
});
export interface RequestReviewResult {
  readonly reviewId: string;
}

/** `wait_review`: long-poll until the user sends the review, dismisses it, or time runs out. */
export const waitReviewParamsSchema = z.object({
  reviewId: idText,
  timeoutSec: z.number().min(0).max(MAX_WAIT_SECONDS),
});
/**
 * `sent`: the user clicked "Send review" (read the annotations now). `waiting`: time ran out, call
 * again. `cancelled`: the user dismissed it, another request replaced it, or another model opened.
 */
export type ReviewState = 'sent' | 'waiting' | 'cancelled';
/** One model of a review that covers several. */
export interface ReviewModelCount {
  readonly modelId: string;
  readonly name: string;
  /** Open comments when the review was sent. */
  readonly openComments: number;
}
export interface WaitReviewResult {
  readonly reviewId: string;
  readonly state: ReviewState;
  readonly modelId: string;
  /** Open comments when the review was sent (all its models together). */
  readonly openComments?: number;
  /** Per model, when the request named `alsoModelIds` and the review was sent. */
  readonly models?: readonly ReviewModelCount[];
  readonly reason?: string;
}

/** `render`: one picture of `markerIds`, or a contact sheet of up to 4 `groups`. */
export const renderParamsSchema = z
  .object({
    modelId,
    markerIds: z.array(idText).min(1).max(MAX_IDS).optional(),
    groups: z.array(z.array(idText).min(1).max(MAX_IDS)).min(1).max(MAX_RENDER_GROUPS).optional(),
    size: z.number().int().min(MIN_RENDER_SIZE).max(MAX_RENDER_SIZE).optional(),
  })
  .refine((p) => (p.markerIds === undefined) !== (p.groups === undefined), {
    message: 'Give either markerIds or groups',
  });

type V3 = readonly [number, number, number];
/** How one picture / tile was taken; numbers rounded for the AI. */
export interface RenderView {
  readonly viewDir: V3;
  readonly up: V3;
  readonly center: V3;
  readonly mmPerPx: number;
  /** Bodies in front of the region, drawn faint and see-through. */
  readonly ghosted: readonly { readonly body: number; readonly name: string }[];
}
export interface RenderTile extends RenderView {
  /** Label in the tile's top-left corner (none when the sheet has one tile). */
  readonly number: number;
  /** Index into `groups`. */
  readonly group: number;
  readonly markerIds: readonly string[];
  /** Pixel rect in the sheet. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
}
export interface RenderResult {
  /** PNG, base64. */
  readonly png: string;
  readonly width: number;
  readonly height: number;
  /** One picture (`markerIds`). */
  readonly view?: RenderView;
  /** Contact sheet (`groups`). */
  readonly tiles?: readonly RenderTile[];
  /** Group indices that showed nothing. */
  readonly skipped?: readonly number[];
}

/**
 * What the AI did with one requested part (part requests): sent with `set_comment_status` or
 * `reply_comment` as `partResults`, stored as the part's `result`.
 */
export const partResultInputSchema = z.object({
  /** The part's id in the comment's `parts` (the payload lists it). */
  partId: idText,
  status: partResultStatusSchema,
  /** Names of the bodies it made, as they are named in the new model file. */
  bodies: z.array(z.string().min(1).max(200)).max(200).optional(),
  note: z.string().max(MAX_PART_TEXT).optional(),
});
export type PartResultInput = z.infer<typeof partResultInputSchema>;
const partResults = z.array(partResultInputSchema).min(1).max(MAX_PART_ITEMS).optional();

/** `set_comment_status`: the AI resolves / reopens a comment of the shown model. */
export const setCommentStatusParamsSchema = z.object({
  modelId,
  commentId: idText,
  status: commentStatusSchema,
  note: z.string().max(MAX_COMMENT_LENGTH).optional(),
  /** Results for the comment's requested parts (stored on each part). */
  partResults,
});
export interface SetCommentStatusResult {
  readonly commentId: string;
  readonly status: CommentStatus;
  /** The AI reply the note became; missing without a note. */
  readonly replyId?: string;
  /** False when it already had this status and no note was given. */
  readonly changed: boolean;
  /** Parts whose result was written. */
  readonly partsUpdated?: number;
}

/** `reply_comment`: the AI answers in a comment's thread without changing its status. */
export const replyCommentParamsSchema = z.object({
  modelId,
  commentId: idText,
  text: z.string().min(1).max(MAX_COMMENT_LENGTH),
  partResults,
});
export interface ReplyCommentResult {
  readonly commentId: string;
  readonly replyId: string;
  /** The comment's status (unchanged). */
  readonly status: CommentStatus;
  /** Parts whose result was written. */
  readonly partsUpdated?: number;
}

/**
 * `search_parts`: look up the parts library the app ships (the catalogue behind the Library panel).
 * Give `query` (English or Chinese words, as in the panel's search box) to find parts, or `cls` (a class
 * name from an earlier result) to get everything chosen for one class: all standard sizes, types, numbers.
 */
export const searchPartsParamsSchema = z
  .object({
    query: z.string().trim().min(1).max(200).optional(),
    cls: z.string().trim().min(1).max(80).optional(),
    limit: z.number().int().min(1).max(30).optional(),
  })
  .refine((p) => (p.query === undefined) !== (p.cls === undefined), {
    message: 'Give either query or cls',
  });

export type SearchPartsParams = z.infer<typeof searchPartsParamsSchema>;

/** One thing that can be chosen for a part. A long list is summarised (`count`, `examples`) unless `cls` was asked for. */
export interface PartOptionInfo {
  readonly name: string;
  readonly kind: 'choice' | 'size' | 'flag' | 'number';
  /** `choice`: the values (or `count` + `examples` when long). */
  readonly choices?: readonly (string | number)[];
  /** `size`: standard sizes, or by standard when they depend on it (`typeParam` names that choice). */
  readonly sizes?: readonly string[] | Readonly<Record<string, readonly string[]>>;
  readonly typeParam?: string;
  readonly count?: number;
  readonly examples?: readonly (string | number)[];
  /** `number`: what the preview used, and the unit. */
  readonly default?: number;
  readonly unit?: string;
  /** `flag`: what `true` and `false` mean. */
  readonly on?: string;
  readonly off?: string;
}

export interface SearchPartHit {
  /** The class name: goes into a request's `source.cls`. */
  readonly cls: string;
  readonly label: string;
  readonly module: string;
  readonly group: string;
  /** Cuts a hole or slot into a model instead of adding a part. */
  readonly operation: boolean;
  /** How many of the query's words matched (more = better). */
  readonly matched?: number;
  /** Size of the example the catalogue shows, mm; its solids; named sub-parts and counts. */
  readonly exampleSize?: readonly [number, number, number];
  readonly solids?: number;
  readonly subparts?: Readonly<Record<string, number>>;
  /** What the example was built with. */
  readonly builtWith?: Readonly<Record<string, string | number | boolean>>;
  readonly options: readonly PartOptionInfo[];
}

export interface SearchPartsResult {
  readonly library: string;
  readonly version: string;
  /** Parts that matched; `hits` is the best `limit` of them (default 10). */
  readonly total: number;
  readonly hits: readonly SearchPartHit[];
  /** Missing or odd results: what to try. */
  readonly note?: string;
}

/** Checks bridge params; a readable error names what is wrong. */
export function parseParams<T>(schema: z.ZodType<T>, params: unknown, method: string): T {
  const r = schema.safeParse(params ?? {});
  if (!r.success) throw new Error(`Bad params for "${method}": ${z.prettifyError(r.error)}`);
  return r.data;
}
