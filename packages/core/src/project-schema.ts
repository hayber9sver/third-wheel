/**
 * Project format, schema version 2: one project per folder, stored in `<folder>/.thirdwheel/`:
 *
 * - `project.json` — parts and their versions, markers (name / colour), comments with threads,
 *   body-list folders per part, the chats index, sidecars already merged.
 * - `marks/<version-id>.json` — each version's paint and held entities (large; one file per
 *   version so a stroke rewrites only that version).
 * - `chats/<chat-id>.jsonl` — one chat entry per line, append-only.
 *
 * Pure zod, no I/O (`project-store.ts` reads and writes). Unlike v1, **unknown fields are kept**
 * (loose objects): a file touched by a newer or forked app loses nothing when this app saves it.
 * A higher `schemaVersion` is refused with a clear message.
 */
import { z } from 'zod';
import {
  MAX_BODY_NAME_LENGTH,
  MAX_COMMENT_LENGTH,
  MAX_ID_LENGTH,
  MAX_LINKED_MODEL_NAME,
  MAX_LINKED_MODELS,
  MAX_NAME_LENGTH,
  MAX_PART_ITEMS,
  MAX_REPLIES,
  MAX_VERSION_PATH,
  checkMarkerPaint,
  colorSchema,
  commentAuthorSchema,
  commentStatusSchema,
  entityKindSchema,
  modelFormatSchema,
  partItemSchema,
  pieceTreeSchema,
  tessellationSchema,
  transferStatusSchema,
} from './schema.js';

export const PROJECT_SCHEMA_VERSION = 2;

/** Folder inside the project folder that holds the project files. */
export const PROJECT_DIR = '.thirdwheel';
export const PROJECT_FILE = 'project.json';
export const MARKS_DIR = 'marks';
export const CHATS_DIR = 'chats';
export const LOCK_FILE = 'lock';
/** Written into a project's folder when missing: chats and the lock stay out of git by default. */
export const GITIGNORE_FILE = '.gitignore';
export const PROJECT_GITIGNORE = `# Third Wheel: chats and the lock stay out of git. Remove a line to share it.\n${CHATS_DIR}/\n${LOCK_FILE}\n`;

/** Most versions per part and parts per project (a broken file can't blow up the UI). */
export const MAX_VERSIONS = 1000;
export const MAX_PARTS = 1000;
export const MAX_CHAT_TEXT = 100_000;

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/, 'must be sha256:<64 hex>');
const isoTime = z.iso.datetime({ offset: true });
const index = z.number().int().nonnegative();
const vec3 = z.tuple([z.number(), z.number(), z.number()]);

/** Ids inside the files (markers, comments, replies, folders): any short string, as in v1. */
const id = z.string().min(1).max(MAX_ID_LENGTH);

/**
 * Ids that become file names (versions → `marks/<id>.json`, chats → `chats/<id>.jsonl`) and new
 * ids of every kind: lower-case `a-z0-9`, 1–32 characters, never a Windows device name. Safe on
 * every file system, case-insensitive ones included (`newId` in `project-paths.ts` makes them).
 */
export const FILE_ID_PATTERN = /^[0-9a-z]{1,32}$/;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;
export function isFileId(s: string): boolean {
  return FILE_ID_PATTERN.test(s) && !WINDOWS_DEVICE.test(s);
}
export const fileIdSchema = z
  .string()
  .refine(isFileId, 'id must be 1–32 characters a-z / 0-9 (and not a Windows device name)');

/**
 * A stored version path relative to the project folder: `/` between parts, `..` allowed
 * (`../exports/part.step`), never `\`, never absolute, no empty or `.` parts.
 */
export function isRelativeStoredPath(p: string): boolean {
  if (p.length === 0 || p.includes('\\') || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return false;
  return p.split('/').every((s) => s.length > 0 && s !== '.');
}
/** An absolute path as the OS wrote it (`outside` entries): `/…`, `C:\…`, `C:/…`, `\\host\share\…`. */
export function isAbsoluteStoredPath(p: string): boolean {
  return /^(\/|[a-zA-Z]:[\\/]|\\\\)/.test(p);
}

// --- loose copies of the v1 shapes (unknown fields kept) ---------------------------------------

export const entityFingerprintV2Schema = z.looseObject({
  body: index.optional(),
  type: z.string().max(MAX_ID_LENGTH).optional(),
  point: vec3.optional(),
  length: z.number().optional(),
  area: z.number().optional(),
  radius: z.number().optional(),
  minorRadius: z.number().optional(),
  dir: vec3.optional(),
  halfAngle: z.number().optional(),
  form: z.enum(['hole', 'shaft', 'hollow', 'ball']).optional(),
  size: vec3.optional(),
  bounds: z.tuple([vec3, vec3]).optional(),
});
const fingerprint = entityFingerprintV2Schema.optional().catch(undefined);

const pointsSchema = z
  .array(z.number())
  .refine((a) => a.length % 3 === 0, 'samples must be x y z triples');

export const markerEntityV2Schema = z.looseObject({
  kind: entityKindSchema,
  id: index,
  seq: index,
  fingerprint,
});

export const facePaintV2Schema = z.looseObject({
  faceId: index,
  triangles: z.array(z.tuple([index, z.number().int().positive()])),
  pieces: z
    .array(
      z.looseObject({
        triangle: index,
        tree: z.tuple([pieceTreeSchema, pieceTreeSchema, pieceTreeSchema, pieceTreeSchema]),
      }),
    )
    .optional(),
  samples: pointsSchema.optional().catch(undefined),
  clear: pointsSchema.optional().catch(undefined),
  fingerprint,
});

export const markerTransferV2Schema = z.looseObject({
  status: transferStatusSchema,
  from: z.string().min(1).max(1000),
  ghost: z
    .looseObject({
      faces: z
        .array(
          z.looseObject({
            samples: pointsSchema,
            clear: pointsSchema.optional(),
            fingerprint: entityFingerprintV2Schema.optional(),
          }),
        )
        .optional(),
      entities: z.array(entityFingerprintV2Schema.extend({ kind: entityKindSchema })).optional(),
    })
    .optional(),
});

export const bodyFingerprintV2Schema = z.looseObject({
  name: z.string().max(MAX_BODY_NAME_LENGTH),
  path: z.string().max(MAX_BODY_NAME_LENGTH).optional(),
  size: vec3,
  centre: vec3,
  area: z.number(),
});

export const commentReplyV2Schema = z.looseObject({
  id,
  text: z.string().min(1).max(MAX_COMMENT_LENGTH),
  author: commentAuthorSchema,
  createdAt: isoTime,
  updatedAt: isoTime,
  status: commentStatusSchema.optional(),
});

// --- project.json --------------------------------------------------------------------------------

/**
 * One version of a part. `path` is relative to the project folder with `/`; a file with no
 * relative path (another drive on Windows) is stored absolute with `outside: true`.
 * `from` = the version it was made from (a tree: several versions may share one `from`).
 */
export const projectVersionSchema = z
  .looseObject({
    id: fileIdSchema,
    path: z.string().min(1).max(MAX_VERSION_PATH),
    contentHash: sha256,
    meshHash: sha256.optional().catch(undefined),
    format: modelFormatSchema,
    added: isoTime,
    from: fileIdSchema.optional(),
    /** A newer version was saved over this path: these contents are gone from disk. */
    overwritten: z.literal(true).optional(),
    outside: z.literal(true).optional(),
    /** The user removed it from its versions (Remove from versions): left out of "new version?" guesses. */
    unlinked: isoTime.optional().catch(undefined),
  })
  .superRefine((v, ctx) => {
    const ok = v.outside ? isAbsoluteStoredPath(v.path) : isRelativeStoredPath(v.path);
    if (!ok) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: v.outside
          ? 'an outside path must be absolute'
          : 'path must be relative to the project folder, with / between parts',
      });
    }
  });
export type ProjectVersion = z.infer<typeof projectVersionSchema>;

/**
 * A body in the body list, by name (survives new versions, where indices may shift); `path` =
 * enclosing assemblies as in v1 `bodies[].path`; `index` = fallback when names repeat or are empty.
 */
export const bodyRefSchema = z.looseObject({
  name: z.string().max(MAX_BODY_NAME_LENGTH),
  path: z.string().max(MAX_BODY_NAME_LENGTH).optional(),
  index: index.optional(),
});
export type BodyRef = z.infer<typeof bodyRefSchema>;

export const treePlaceV2Schema = z.union([
  z.literal('top'),
  z.looseObject({ assembly: index }),
  z.looseObject({ folder: id }),
]);

/** Body-list folders of a part (v1 `bodyTree`, bodies by name instead of index). */
export const projectBodyTreeSchema = z.looseObject({
  folders: z.array(
    z.looseObject({ id, name: z.string().min(1).max(MAX_NAME_LENGTH), parent: treePlaceV2Schema }),
  ),
  bodies: z.array(z.looseObject({ body: bodyRefSchema, parent: treePlaceV2Schema })),
  assemblies: z.array(z.looseObject({ assembly: index, parent: treePlaceV2Schema })),
});
export type ProjectBodyTree = z.infer<typeof projectBodyTreeSchema>;

export const projectPartSchema = z.looseObject({
  id: fileIdSchema,
  name: z.string().min(1).max(MAX_LINKED_MODEL_NAME),
  versions: z.array(projectVersionSchema).max(MAX_VERSIONS),
  /** A malformed one is dropped (folders lost), never the project. */
  bodyTree: projectBodyTreeSchema.optional().catch(undefined),
});
export type ProjectPart = z.infer<typeof projectPartSchema>;

/** A marker's name and colour; its paint and entities are per version in `marks/`. */
export const projectMarkerSchema = z.looseObject({
  id,
  name: z.string().min(1).max(MAX_NAME_LENGTH),
  color: colorSchema,
  visible: z.boolean(),
});
export type ProjectMarker = z.infer<typeof projectMarkerSchema>;

/** A comment, stored once for the project. `modelId` = the part it is about. */
export const projectCommentSchema = z.looseObject({
  id,
  modelId: fileIdSchema,
  text: z.string().min(1).max(MAX_COMMENT_LENGTH),
  markerIds: z.array(id),
  status: commentStatusSchema,
  author: commentAuthorSchema,
  createdAt: isoTime,
  updatedAt: isoTime,
  /** v1's AI note before threads; still read, never written. */
  note: z.string().max(MAX_COMMENT_LENGTH).optional(),
  replies: z.array(commentReplyV2Schema).max(MAX_REPLIES).optional(),
  /** Other model files by name, as in v1. */
  linkedModels: z
    .array(z.string().min(1).max(MAX_LINKED_MODEL_NAME))
    .max(MAX_LINKED_MODELS)
    .optional(),
  /** Parts of this project the comment links to (from `linkedModels` names that matched a part). */
  linkedParts: z.array(fileIdSchema).max(MAX_LINKED_MODELS).optional(),
  awaitingConfirm: z.literal(true).optional().catch(undefined),
  /**
   * Part requests (library parts the user asks for), as in v1 sidecars. A malformed list is dropped,
   * never the comment. Target markers the window doesn't show are left out when notes are read.
   */
  parts: z.array(partItemSchema).max(MAX_PART_ITEMS).optional().catch(undefined),
});
export type ProjectComment = z.infer<typeof projectCommentSchema>;

export const chatInfoSchema = z.looseObject({
  id: fileIdSchema,
  /** The first message, shortened. */
  title: z.string().max(200),
  created: isoTime,
  last: isoTime,
  entries: index,
  /** The agent's own summary (it may store one, like `/compact`). */
  summary: z.string().max(MAX_CHAT_TEXT).optional(),
});
export type ChatInfo = z.infer<typeof chatInfoSchema>;

/** A v1 sidecar already taken into the project (merged once, never again). */
export const mergedSidecarSchema = z.looseObject({
  path: z.string().min(1).max(MAX_VERSION_PATH),
  contentHash: sha256,
  at: isoTime,
});

export const projectSchema = z
  .looseObject({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    id: fileIdSchema,
    name: z.string().min(1).max(MAX_LINKED_MODEL_NAME),
    created: isoTime,
    tessellation: tessellationSchema.optional(),
    models: z.array(projectPartSchema).max(MAX_PARTS),
    markers: z.array(projectMarkerSchema),
    comments: z.array(projectCommentSchema),
    chats: z.array(chatInfoSchema),
    sidecars: z.array(mergedSidecarSchema).optional(),
  })
  .superRefine((doc, ctx) => {
    unique(doc.models, (m) => m.id, ['models'], 'part id', ctx);
    unique(
      doc.models.flatMap((m) => m.versions),
      (v) => v.id,
      ['models'],
      'version id',
      ctx,
    );
    unique(doc.markers, (m) => m.id, ['markers'], 'marker id', ctx);
    unique(doc.comments, (c) => c.id, ['comments'], 'comment id', ctx);
    unique(doc.chats, (c) => c.id, ['chats'], 'chat id', ctx);
    const parts = new Set(doc.models.map((m) => m.id));
    const markers = new Set(doc.markers.map((m) => m.id));
    doc.models.forEach((m, mi) => {
      const own = new Set(m.versions.map((v) => v.id));
      m.versions.forEach((v, vi) => {
        if (v.from !== undefined && (!own.has(v.from) || v.from === v.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['models', mi, 'versions', vi, 'from'],
            message: `"${v.from}" is not another version of this part`,
          });
        }
      });
      const loop = firstCycle(m.versions);
      if (loop) {
        ctx.addIssue({
          code: 'custom',
          path: ['models', mi, 'versions'],
          message: `versions made from each other in a circle (${loop})`,
        });
      }
    });
    doc.comments.forEach((c, ci) => {
      if (!parts.has(c.modelId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['comments', ci, 'modelId'],
          message: `unknown part "${c.modelId}"`,
        });
      }
      unique(c.markerIds, (m) => m, ['comments', ci, 'markerIds'], 'marker reference', ctx);
      unique(c.replies ?? [], (r) => r.id, ['comments', ci, 'replies'], 'reply id', ctx);
      c.markerIds.forEach((m, mi) => {
        if (!markers.has(m)) {
          ctx.addIssue({
            code: 'custom',
            path: ['comments', ci, 'markerIds', mi],
            message: `unknown marker "${m}"`,
          });
        }
      });
    });
  });
export type Project = z.infer<typeof projectSchema>;

/** A version id that is its own ancestor through `from`, if any. */
function firstCycle(versions: readonly ProjectVersion[]): string | undefined {
  const parent = new Map(versions.map((v) => [v.id, v.from]));
  for (const v of versions) {
    const seen = new Set<string>();
    for (let at: string | undefined = v.id; at !== undefined; at = parent.get(at)) {
      if (seen.has(at)) return at;
      seen.add(at);
    }
  }
  return undefined;
}

// --- marks/<version-id>.json -------------------------------------------------------------------

export const versionMarkSchema = z.looseObject({
  /** The marker in `project.json` `markers`. */
  id,
  entities: z.array(markerEntityV2Schema),
  paint: z.looseObject({ faces: z.array(facePaintV2Schema), samples: pointsSchema.optional() }),
  transfer: markerTransferV2Schema.optional().catch(undefined),
});
export type VersionMark = z.infer<typeof versionMarkSchema>;

/**
 * One version's paint and held entities. Also records what the numbers refer to (`contentHash`,
 * `meshHash`, `tessellation`, `bodies`), so a changed file or setting is caught as in v1.
 */
export const versionMarksSchema = z
  .looseObject({
    schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
    versionId: fileIdSchema,
    contentHash: sha256,
    meshHash: sha256.optional().catch(undefined),
    tessellation: tessellationSchema.optional(),
    bodies: z.array(bodyFingerprintV2Schema).optional().catch(undefined),
    markers: z.array(versionMarkSchema),
  })
  .superRefine((doc, ctx) => {
    unique(doc.markers, (m) => m.id, ['markers'], 'marker id', ctx);
    checkMarkerPaint(doc.markers, ['markers'], ctx);
  });
export type VersionMarks = z.infer<typeof versionMarksSchema>;

// --- chats/<chat-id>.jsonl ---------------------------------------------------------------------

/**
 * One line of a chat log. `kind`: `user`, `agent`, `progress`, `event` (model opened, review
 * sent), … — kept as a string so a newer app's kinds survive. `ref` points at a comment by id and
 * part (not the card number), so an old link opens the comment on the version shown now.
 */
export const chatEntrySchema = z.looseObject({
  seq: index,
  kind: z.string().min(1).max(32),
  text: z.string().max(MAX_CHAT_TEXT),
  at: isoTime,
  ref: z.looseObject({ commentId: id, modelId: fileIdSchema }).optional().catch(undefined),
  /** The version shown when the entry was written. */
  model: fileIdSchema.optional().catch(undefined),
  /** `joined` / `left` / `agent`: the MCP server's id for that start, and the agent's own name. */
  connection: z.string().max(64).optional().catch(undefined),
  agent: z.string().max(80).optional().catch(undefined),
  /** `caught-up` / `summary`: what was passed / stored (shown folded). */
  detail: z.string().max(MAX_CHAT_TEXT).optional().catch(undefined),
  /** `elsewhere`: the topic the agent's answer went to (another project: its folder's name). */
  topic: z
    .looseObject({
      title: z.string().max(200),
      chat: z.string().max(64).optional(),
      project: z.string().max(260).optional(),
    })
    .optional()
    .catch(undefined),
});
export type ChatEntry = z.infer<typeof chatEntrySchema>;

// --- parsing -------------------------------------------------------------------------------------

export type V2ParseResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      /** `newer`: made by a newer app (refused, "please update"); `invalid`: anything else. */
      readonly reason: 'newer' | 'invalid';
      readonly errors: readonly string[];
    };

function parseWith<T>(schema: z.ZodType<T>, input: unknown, what: string): V2ParseResult<T> {
  const version =
    typeof input === 'object' && input !== null && 'schemaVersion' in input
      ? input.schemaVersion
      : undefined;
  if (typeof version !== 'number') {
    return {
      ok: false,
      reason: 'invalid',
      errors: [`not a Third Wheel ${what} (no schemaVersion)`],
    };
  }
  if (version > PROJECT_SCHEMA_VERSION) {
    return {
      ok: false,
      reason: 'newer',
      errors: [
        `made by a newer version of Third Wheel (schema ${String(version)}; this app reads ${String(PROJECT_SCHEMA_VERSION)}) — please update the app`,
      ],
    };
  }
  const result = schema.safeParse(input);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    reason: 'invalid',
    errors: result.error.issues.map((i) =>
      i.path.length > 0 ? `${i.path.map(String).join('.')}: ${i.message}` : i.message,
    ),
  };
}

/** JSON text → value; a syntax error becomes a readable error. A UTF-8 BOM is skipped. */
export function parseJsonText(
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text.replace(/^\uFEFF/, '')) };
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export function parseProject(input: unknown): V2ParseResult<Project> {
  return parseWith(projectSchema, input, 'project file');
}
export function parseProjectJson(text: string): V2ParseResult<Project> {
  const j = parseJsonText(text);
  return j.ok ? parseProject(j.value) : { ok: false, reason: 'invalid', errors: [j.error] };
}
export function parseVersionMarks(input: unknown): V2ParseResult<VersionMarks> {
  return parseWith(versionMarksSchema, input, 'marks file');
}
export function parseVersionMarksJson(text: string): V2ParseResult<VersionMarks> {
  const j = parseJsonText(text);
  return j.ok ? parseVersionMarks(j.value) : { ok: false, reason: 'invalid', errors: [j.error] };
}

export interface ChatParse {
  readonly entries: ChatEntry[];
  /** Lines that were not a valid entry (1-based), e.g. a half-written last line after a crash. */
  readonly badLines: number[];
}

/**
 * A chat log: one JSON entry per line; `\r\n` (git autocrlf on Windows) and blank lines are fine;
 * a broken line is skipped and reported, never the whole log.
 */
export function parseChatLog(text: string): ChatParse {
  const entries: ChatEntry[] = [];
  const badLines: number[] = [];
  text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.trim();
      if (line === '') return;
      const j = parseJsonText(line);
      const r = j.ok ? chatEntrySchema.safeParse(j.value) : undefined;
      if (r?.success) entries.push(r.data);
      else badLines.push(i + 1);
    });
  return { entries, badLines };
}

/** One chat entry as a line to append (`\n`-terminated, no line breaks inside). */
export function chatLine(entry: ChatEntry): string {
  return `${JSON.stringify(chatEntrySchema.parse(entry))}\n`;
}

function unique<T>(
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
