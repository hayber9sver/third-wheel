/**
 * App bridge protocol: how the MCP server talks to the running app over a localhost
 * WebSocket. Pure — the app (`apps/desktop/src/main/bridge.ts`) and the client
 * (`packages/mcp-server/src/bridge-client.ts`) share it.
 *
 * Discovery: the app writes a bridge file (port + random token, readable only by the user) and
 * removes it on quit. The client connects to `ws://127.0.0.1:<port>` with
 * `Authorization: Bearer <token>`; anything else is refused before the WebSocket opens.
 * Messages are JSON: request `{ id, method, params? }` → response `{ id, result }` or
 * `{ id, error: { code, message } }`. Requests may overlap; answers match by `id`.
 */
import { z } from 'zod';

/** Bumped on any incompatible change to the bridge file or messages. */
export const BRIDGE_PROTOCOL = 1;

/** Overrides the bridge file location in the app and the client (tests, two dev setups). */
export const BRIDGE_FILE_ENV = 'THIRD_WHEEL_BRIDGE_FILE';

/** Largest message the app accepts from a client (bytes). Answers may be bigger (pictures). */
export const BRIDGE_MAX_REQUEST_BYTES = 1024 * 1024;

export const bridgeFileSchema = z.object({
  app: z.literal('third-wheel'),
  protocol: z.number().int(),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(32),
  pid: z.number().int(),
  version: z.string(),
});
export type BridgeFile = z.infer<typeof bridgeFileSchema>;

/**
 * Path segments of the default bridge file (join them with Node's `path.join`): the per-user
 * app-data folder, then `third-wheel/bridge.json`. `env[BRIDGE_FILE_ENV]` replaces it.
 * macOS `~/Library/Application Support`, Windows `%APPDATA%`, else `$XDG_CONFIG_HOME` / `~/.config`.
 */
export function bridgeFileSegments(
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string[] {
  const override = env[BRIDGE_FILE_ENV];
  if (override) return [override];
  let base: string[];
  if (platform === 'darwin') base = [home, 'Library', 'Application Support'];
  else if (platform === 'win32')
    base = env['APPDATA'] ? [env['APPDATA']] : [home, 'AppData', 'Roaming'];
  else base = env['XDG_CONFIG_HOME'] ? [env['XDG_CONFIG_HOME']] : [home, '.config'];
  return [...base, 'third-wheel', 'bridge.json'];
}

export const bridgeRequestSchema = z.object({
  id: z.union([z.number(), z.string()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});
export type BridgeRequest = z.infer<typeof bridgeRequestSchema>;

/** Error codes in `{ error: { code } }`. */
export type BridgeErrorCode =
  | 'bad_request' // not JSON or not a request
  | 'unknown_method'
  | 'no_window' // the app has no window to ask
  | 'timeout' // the window did not answer in time
  | 'failed'; // the handler threw

export interface BridgeErrorBody {
  readonly code: BridgeErrorCode;
  readonly message: string;
}

export type BridgeResponse =
  | { readonly id: number | string | null; readonly result: unknown }
  | { readonly id: number | string | null; readonly error: BridgeErrorBody };

export const bridgeResponseSchema = z.union([
  z.object({ id: z.union([z.number(), z.string(), z.null()]), result: z.unknown() }),
  z.object({
    id: z.union([z.number(), z.string(), z.null()]),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);

/** Parse one incoming message; a bad one → the error response to send back. */
export function parseBridgeRequest(
  text: string,
):
  | { readonly ok: true; readonly request: BridgeRequest }
  | { readonly ok: false; readonly response: BridgeResponse } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return badRequest(null, 'Message is not JSON');
  }
  const parsed = bridgeRequestSchema.safeParse(json);
  if (parsed.success) return { ok: true, request: parsed.data };
  const id = (json as { id?: unknown } | null)?.id;
  return badRequest(
    typeof id === 'number' || typeof id === 'string' ? id : null,
    'Expected { id, method, params? }',
  );
}

function badRequest(id: number | string | null, message: string) {
  return { ok: false as const, response: { id, error: { code: 'bad_request' as const, message } } };
}

// --- Methods ---------------------------------------------------------------------------------

/** `ping` → who is answering. Answered by the app's main process. */
export interface PingResult {
  readonly app: 'third-wheel';
  readonly version: string;
  readonly protocol: number;
}

/** `status` → the model open in the app window (asked from the window itself). */
export interface StatusResult {
  readonly model: {
    /** Absolute path of the model file. */
    readonly path: string;
    readonly name: string;
    /** `sha256:<hex>` of the file's bytes. */
    readonly contentHash: string;
    /** Short id for the MCP tools (`modelIdOf`). */
    readonly modelId: string;
  } | null;
  /** What the open model holds, so an AI that just connected knows what is waiting (missing = no model). */
  readonly summary?: {
    readonly bodies: number;
    readonly markers: number;
    /** Comments by status. */
    readonly comments: {
      readonly open: number;
      readonly resolved: number;
      readonly wontfix: number;
    };
    /** Set for a mesh file (STL / 3MF). */
    readonly mesh?: 'stl' | '3mf';
  };
}
