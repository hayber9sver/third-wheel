/**
 * The MCP tools (T7.2): each one is a bridge call to the running app (T7.1). Spec:
 * `docs/mcp-tools.md`. Compact JSON text first; pictures only from `render_region`.
 */
import { isAbsolute, resolve } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  commentStatusSchema,
  DEFAULT_RENDER_SIZE,
  MAX_ALSO_MODELS,
  MAX_COMMENT_LENGTH,
  MAX_RENDER_GROUPS,
  MAX_RENDER_SIZE,
  MAX_WAIT_SECONDS,
  MIN_RENDER_SIZE,
  partResultInputSchema,
  MAX_PART_ITEMS,
  type RenderResult,
} from '@third-wheel/core';
import { z } from 'zod';
import { BridgeError, type BridgeClient } from './bridge-client.js';

export const SERVER_NAME = 'third-wheel';

/** Default `wait_for_review` long-poll, seconds (the AI calls again on `waiting`). */
export const DEFAULT_WAIT_SECONDS = 120;
/** Bridge-call time limits: opening big assemblies takes minutes. */
const LOAD_MS = 10 * 60_000 + 10_000;
const RENDER_MS = 120_000 + 10_000;
/** Extra time over a long-poll before the client gives up on the app. */
const WAIT_GRACE_MS = 20_000;

export interface ToolServerOptions {
  /** Connect to the app (default: `connectBridge()`); one connection per tool call. */
  readonly connect: () => Promise<BridgeClient>;
  /** Folder relative `load_model` paths start from (default: the server's working folder). */
  readonly cwd?: string;
  readonly version?: string;
}

const modelId = z
  .string()
  .min(1)
  .max(64)
  .describe('Id from load_model (first 12 hex digits of the file hash)');

export function createToolServer(options: ToolServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? '0.0.0' },
    {
      instructions:
        'Third Wheel shows a STEP model to the user, who marks spots (markers) and writes comments. To suggest or choose library parts use search_parts (the real catalogue). In a new session call get_open_model first: it tells you which model the user has open (modelId, path) and how many comments wait. Loop: export STEP → load_model → request_review → wait_for_review (repeat while "waiting") → get_annotations → render_region only where text is not enough → edit the CAD → set_comment_status with a short note (it shows as your reply under the comment) → export a new STEP → load_model again. Units mm. ' +
        "Versions: export each iteration under a new file name (part.step → part_v2.step → part_v3.step), never over the previous file — the app keeps no copies, so an overwritten version can't be compared. Then load_model the new file with revisionOf = the previous version's modelId: the app moves the markers and comments over. " +
        'The app shows one model at a time; loading a model outside an open review request cancels it. get_annotations also reads a model loaded earlier in this app session without loading it again (render_region, set_comment_status and reply_to_comment need it shown). ' +
        'Each comment has a thread (replies[]); the user reviews in the app, not in this chat. When a comment is unclear (what is meant, which direction, which option, where to make the edit), ask in its thread with reply_to_comment — not in the chat — then call request_review (message e.g. "2 questions in the comments") and wait_for_review; the user answers in the thread and clicks Send to AI; read the latest replies with get_annotations. In the chat, at most a one-line summary. ' +
        'STL / 3MF files open too (mesh-only mode: the user can only paint and comment; markers have paint but no entities, payloads carry mesh: "stl" | "3mf"). Prefer STEP when you can export it. When you make a STEP of a mesh the user marked, load_model the STEP with revisionOf = the mesh modelId: the app lines the files up and moves the paint onto the STEP faces (transfer.fromMesh says how much matched). Notes never move onto a mesh. ' +
        'Comments may name other model files in linkedModels ("this pocket must fit that part"). ' +
        'Two-part fit check (when the user asks how parts meet or fit): load part B, then load part A and request_review with modelId = A and alsoModelIds = [B]; the user switches between them in the app and marks the matching regions; one "Send to AI" answers for both; read each with get_annotations. The files may use different origins: align them on matching features first (say which and how well they match), then compare the marked faces and report the gap per feature in a small table (side walls, radii, depth, chamfers), what it means for how the parts are made (FDM / resin / machined), and ask before changing anything. Answer each comment with set_comment_status (fixed / won’t fix) or reply_to_comment (a question or a finding).' +
        ' Keep the user’s names: when you change a model with build123d, the exported file must keep the body names and the assembly nesting the user sees (read them from the previous STEP’s PRODUCT names; set .label on each solid; Compound(label=…, children=[…])). A new file whose bodies are all SOLID / COMPOUND makes the Bodies list unreadable for the user; load_model warns with namesLost when that happens. The Third Wheel repository has recipes (docs/recipes.md) and a helper that restores the names after you export: scripts/ai/restore_step_names.py previous.step new.step restored.step.' +
        ' Part requests: a comment may carry parts[] (library parts the user picked: id, source.cls from bd_warehouse, params = the standard type / size / numbers the user fixed — a missing one is yours to choose, e.g. the size from the hole; simple: false = the user wants a real thread, simple: true = none (bd_warehouse screws and nuts default to no thread) —, copies, scope whole or {subparts}, target.markerIds, note = a special requirement). Build them with build123d / bd_warehouse (source.version is the bd_warehouse version the choices were made for; if yours differs, check that the size still builds and say so in your reply), place them at the target markers, export a new model file, load it with revisionOf, then report per part with partResults on set_comment_status or reply_to_comment: { partId, status: placed | skipped | failed | needs-info, bodies?: body names in the new file, note? }.',
    },
  );
  const cwd = options.cwd ?? process.cwd();

  /** One bridge call; errors become a tool error the AI can read. */
  async function call(
    method: string,
    params: unknown,
    timeoutMs?: number,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: CallToolResult }> {
    let client: BridgeClient | undefined;
    try {
      client = await options.connect();
      return { ok: true, result: await client.call(method, params, timeoutMs) };
    } catch (err) {
      return { ok: false, error: toolError(err) };
    } finally {
      client?.close();
    }
  }

  const json = (value: unknown): CallToolResult => ({
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
  });

  server.registerTool(
    'load_model',
    {
      title: 'Open a model',
      description:
        "Open a STEP file (.step/.stp) in the Third Wheel app (must be running). STL / 3MF also open, in mesh-only mode (paint + comments, no entity ids; the result has mesh: 'stl' | '3mf'; a mesh can't be loaded with revisionOf, but it can be the revisionOf of a STEP: its paint goes onto the STEP's faces). Relative paths start from the MCP server's folder. Annotations saved next to the file come back with it. After you changed the CAD: load the new export the same way. Export each new version under a new file name (part_v2.step) and pass revisionOf = the previous version's modelId (the same file name also works but overwrites the previous version on disk). Returns { modelId, name, path, bodies, faces, mesh?, markers, comments: { open, resolved, wontfix }, revision?, hint?, warning?, namesLost? }. namesLost = the user's body names from the previous version are mostly missing in this file (build123d's import_step, boolean results and export_step drop them; the Bodies list then shows SOLID / COMPOUND / codes): set .label on every solid before export_step, keep the assembly nesting, export again and load it again. hint = the file looks like a new version of a model you loaded and revisionOf was missing: load it again with the revisionOf it names. warning = this load overwrote the previous version on disk: use a new name next time; or a version link was changed: a file has one earlier version, so revisionOf moves it from the one it had, and a file that is already an earlier version of revisionOf is not linked (a circle). revision = { of, path, annotations, markers, comments, transfer? } for a new version: annotations 'carried' (same geometry, all moved over), 'moved' (geometry changed: the app moved the markers by matching geometry), 'waiting' (moving them failed: kept, the new model starts empty), 'none' (it had none) or 'own' (the new file already has notes of its own: they are kept and nothing is moved; an empty notes file counts as none). transfer = { found, changed, lost, check, flagged: [{ id, name, status }] }: 'changed' = moved or resized (it is now where the app thinks it went), 'lost' = no match (holds nothing, its comments stay), 'check' = its body is mirrored, not moved. From a mesh (revisionOf = an STL / 3MF): transfer.fromMesh = { points, matched, surface, toleranceMm, mirrored, meshRead } — painted points that landed on a STEP face within toleranceMm, and the share of the mesh's surface on the STEP (low = different part or version). You know what you changed: if a flagged marker matters, say so in a reply_to_comment on its comment (e.g. “hole moved to x 40, as asked”) so the user can confirm it.",
      inputSchema: {
        path: z.string().min(1).max(4096).describe('STEP (or STL / 3MF) file path'),
        revisionOf: z
          .string()
          .min(1)
          .max(64)
          .optional()
          .describe(
            'modelId of a model loaded earlier this session that this file is a new version of (only needed when the file name changed)',
          ),
      },
    },
    async ({ path, revisionOf }) => {
      const absolute = isAbsolute(path) ? path : resolve(cwd, path);
      const r = await call(
        'load',
        { path: absolute, ...(revisionOf ? { revisionOf } : {}) },
        LOAD_MS,
      );
      return r.ok ? json(r.result) : r.error;
    },
  );

  server.registerTool(
    'get_open_model',
    {
      title: 'Which model is open',
      description:
        'The model the user has open in Third Wheel right now, without loading anything: { model: { modelId, name, path, contentHash } | null, summary?: { bodies, markers, comments: { open, resolved, wontfix }, mesh? } }. Call it first in a new session: the modelId goes into get_annotations, request_review and the other tools, and path is the file to edit (write the next version beside it under a new name). model null = nothing is open; ask the user to open a file or load_model one.',
      inputSchema: {},
    },
    async () => {
      const r = await call('open_model', {});
      return r.ok ? json(r.result) : r.error;
    },
  );

  server.registerTool(
    'search_parts',
    {
      title: 'Find a library part',
      description:
        'Search the parts library the app ships (bd_warehouse: screws, nuts, washers, bearings, gears, sprockets, O-rings, keys, snap rings, flanges, pipes, bushings, threads, OpenBuilds). It is the same catalogue and search as the Library panel, so classes and sizes are ones the library can build. Give query (English or Chinese words, e.g. "螺絲", "seal", "bearing 8 mm shaft") to find parts: returns { library, version, total, hits[], note? }; each hit has cls (the class name for a request), label, module, group, operation (cuts a hole or slot instead of adding a part), exampleSize (mm), solids, subparts (named parts and counts), builtWith, and options (what can be chosen: standard types, sizes, fixed choices, numbers with a default, flags such as thread yes/no); long lists come as count + examples. Give cls (a class name from a hit) to get that class’s full lists, e.g. every buildable standard size. Use it to recommend parts to the user from real data instead of memory, then tell them which to add in the Library panel (Add to request) or build it yourself. Only sizes in the catalogue are offered: bd_warehouse lists some it cannot build and those are left out.',
      inputSchema: {
        query: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe('Words describing the part, English or Chinese'),
        cls: z
          .string()
          .min(1)
          .max(80)
          .optional()
          .describe('A class name from an earlier result, for its full lists'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(30)
          .optional()
          .describe('Most hits to return (default 10)'),
      },
    },
    async (args) => {
      if ((args.query === undefined) === (args.cls === undefined))
        return errorResult('Give either query or cls');
      const r = await call('search_parts', args);
      return r.ok ? json(r.result) : r.error;
    },
  );

  server.registerTool(
    'request_review',
    {
      title: 'Ask the user for a review',
      description:
        'Show the user a review request in the app (with an optional message, e.g. what changed). The user marks and comments, then clicks "Send to AI". modelId = the shown model; alsoModelIds = other models loaded earlier in this session that belong to the same review (e.g. two parts that must fit) — the user switches between them in the app and one Send answers for all. Returns { reviewId }. Then call wait_for_review right away, in the same turn, and keep calling it while it answers "waiting" — don\'t stop to ask the user to tell you when they are done. A click made before you start waiting is kept, so a later wait_for_review still answers "sent". A new request replaces an open one.',
      inputSchema: {
        modelId,
        alsoModelIds: z
          .array(modelId)
          .max(MAX_ALSO_MODELS)
          .optional()
          .describe('Other models of the same review, from earlier load_model calls'),
        message: z.string().max(2000).optional().describe('Shown to the user, one or two lines'),
      },
    },
    async (args) => {
      const r = await call('request_review', args);
      if (!r.ok) return r.error;
      const answer = json(r.result);
      return {
        ...answer,
        content: [
          { type: 'text' as const, text: 'Now call wait_for_review with this reviewId.' },
          ...answer.content,
        ],
      };
    },
  );

  server.registerTool(
    'wait_for_review',
    {
      title: 'Wait for the review',
      description: `Wait until the user sends the review (long-poll, default ${String(DEFAULT_WAIT_SECONDS)} s, max ${String(MAX_WAIT_SECONDS)} s). Returns { reviewId, state, modelId, openComments?, models?, reason? }; models = { modelId, name, openComments } per model of a request with alsoModelIds. state "sent" → call get_annotations (for each model); "waiting" → time ran out, call again; "cancelled" → the user dismissed it or opened a model outside the request (reason says which).`,
      inputSchema: {
        reviewId: z.string().min(1).max(64),
        timeoutSec: z.number().min(1).max(MAX_WAIT_SECONDS).optional(),
      },
    },
    async ({ reviewId, timeoutSec = DEFAULT_WAIT_SECONDS }) => {
      const r = await call(
        'wait_review',
        { reviewId, timeoutSec },
        timeoutSec * 1000 + WAIT_GRACE_MS,
      );
      return r.ok ? json(r.result) : r.error;
    },
  );

  server.registerTool(
    'get_annotations',
    {
      title: 'Read the review',
      description:
        "The user's comments and the markers they point at, as compact JSON (mm). Works for the shown model and for models loaded earlier in this app session. Default: open comments only. comments[]: { id, text, status, by, markers[], linkedModels?, replies?, moreReplies? } (linkedModels = other model file names the comment is about; replies = the thread, oldest first, last 10: { by, text, status? }, status = what the comment was set to with that reply; read the latest reply — the user may have answered you). markers[]: { id, name, paint?: { area, centre, size, normal, flatness, patchCount, patches?, faces[] }, entities? }; faces / entities: { kind, id, body, type?, radius?, length?, area?, point?, dir?, covered? }. bodies: body index → name. Fields are explained in docs/mcp-tools.md.",
      inputSchema: {
        modelId,
        statuses: z
          .array(commentStatusSchema)
          .min(1)
          .max(3)
          .optional()
          .describe('Comment statuses to include (default ["open"])'),
      },
    },
    async (args) => {
      const r = await call('annotations', args);
      return r.ok ? json(r.result) : r.error;
    },
  );

  server.registerTool(
    'render_region',
    {
      title: 'Picture of marked spots',
      description: `Orthographic PNG of markers, drawn in their own colours, rest grey; parts in front are drawn see-through (listed in "ghosted"). Give markerIds for one picture (size ${String(DEFAULT_RENDER_SIZE)} px default, max ${String(MAX_RENDER_SIZE)}), or groups (≤ ${String(MAX_RENDER_GROUPS)} marker lists) for one contact sheet with numbered tiles. Next to the image: viewDir (from the region to the camera), up, center (mm), mmPerPx, ghosted. Use only when the JSON from get_annotations is not enough.`,
      inputSchema: {
        modelId,
        markerIds: z.array(z.string().min(1).max(64)).min(1).max(200).optional(),
        groups: z
          .array(z.array(z.string().min(1).max(64)).min(1).max(200))
          .min(1)
          .max(MAX_RENDER_GROUPS)
          .optional(),
        size: z.number().int().min(MIN_RENDER_SIZE).max(MAX_RENDER_SIZE).optional(),
      },
    },
    async (args) => {
      if ((args.markerIds === undefined) === (args.groups === undefined))
        return errorResult('Give either markerIds (one picture) or groups (contact sheet).');
      const r = await call('render', args, RENDER_MS);
      if (!r.ok) return r.error;
      const { png, ...facts } = r.result as RenderResult;
      return {
        content: [
          { type: 'image', data: png, mimeType: 'image/png' },
          { type: 'text', text: JSON.stringify(facts) },
        ],
      };
    },
  );

  server.registerTool(
    'set_comment_status',
    {
      title: 'Resolve a comment',
      description:
        'Set a comment of the shown model (load_model it first) to "resolved" (you fixed it), "wontfix" (with a reason) or back to "open", with a short note, e.g. "added a 2 mm fillet". The note is added as your reply in the comment’s thread. The user checks it in the app: Confirm closes it, Reopen sends it back to you as open. For a part request pass partResults ({ partId, status: placed | skipped | failed | needs-info, bodies?, note? } per part) so each part shows what happened; an unknown partId is an error and nothing is changed.',
      inputSchema: {
        modelId,
        commentId: z.string().min(1).max(64),
        status: commentStatusSchema,
        note: z.string().max(MAX_COMMENT_LENGTH).optional(),
        partResults: z
          .array(partResultInputSchema)
          .min(1)
          .max(MAX_PART_ITEMS)
          .optional()
          .describe(
            'What you did with the requested parts of the comment (comments[].parts): one entry per part id',
          ),
      },
    },
    async (args) => {
      const r = await call('set_comment_status', args);
      return r.ok ? json(r.result) : r.error;
    },
  );

  server.registerTool(
    'reply_to_comment',
    {
      title: 'Reply to a comment',
      description:
        "Add your reply to a comment's thread on the shown model (load_model it first) without changing its status: answer the user, ask a question, or report a finding. Questions about a comment belong here, not in the chat. To mark a comment fixed or won't fix use set_comment_status instead. partResults reports requested parts the same way as in set_comment_status (e.g. needs-info with the question in the text).",
      inputSchema: {
        modelId,
        commentId: z.string().min(1).max(64),
        text: z.string().min(1).max(MAX_COMMENT_LENGTH),
        partResults: z
          .array(partResultInputSchema)
          .min(1)
          .max(MAX_PART_ITEMS)
          .optional()
          .describe(
            'What you did with the requested parts of the comment (comments[].parts): one entry per part id',
          ),
      },
    },
    async (args) => {
      const r = await call('reply_comment', args);
      if (!r.ok) return r.error;
      const answer = json(r.result);
      return {
        ...answer,
        content: [{ type: 'text' as const, text: REPLY_NEXT_STEP }, ...answer.content],
      };
    },
  );

  return server;
}

/** Said after each reply, so the user's answer comes back through the app (T7.5). */
export const REPLY_NEXT_STEP =
  'Once you have replied to every comment you mean to, call request_review (say what you asked) and wait_for_review, so the user can answer in the app.';

function errorResult(text: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

/** A bridge failure as a tool error; `not_running` gets a friendly hint. */
export function toolError(err: unknown): CallToolResult {
  if (err instanceof BridgeError) {
    if (err.code === 'not_running')
      return errorResult(
        'Third Wheel is not running. Ask the user to open the Third Wheel app, then try again.',
      );
    if (err.code === 'unknown_method')
      return errorResult(
        `${err.message} — the open Third Wheel app is older than this MCP server; update the app.`,
      );
    return errorResult(err.message);
  }
  return errorResult(err instanceof Error ? err.message : String(err));
}
