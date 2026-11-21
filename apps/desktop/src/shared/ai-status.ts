/**
 * AI connection status (T7.6): what the status-bar item and the "Connect an AI agent" pop-up show.
 * The MCP server opens one bridge connection per tool call, so the app never knows an agent is
 * "connected" — only whether the bridge runs and when the last tool call came in.
 */

/** Bridge methods the MCP tools call → the tool name the user sees in Claude Code. */
const TOOL_OF_METHOD: Readonly<Record<string, string>> = {
  load: 'load_model',
  request_review: 'request_review',
  wait_review: 'wait_for_review',
  annotations: 'get_annotations',
  render: 'render_region',
  set_comment_status: 'set_comment_status',
  reply_comment: 'reply_to_comment',
  open_model: 'get_open_model',
  search_parts: 'search_parts',
};

/** The MCP tool behind a bridge method; undefined for methods no tool calls (ping, status). */
export function toolOfMethod(method: string): string | undefined {
  return Object.hasOwn(TOOL_OF_METHOD, method) ? TOOL_OF_METHOD[method] : undefined;
}

export interface AiActivity {
  /** `on` = listening; `off` = turned off (THIRD_WHEEL_BRIDGE=0, dev); `failed` = could not start. */
  readonly bridge: 'starting' | 'on' | 'off' | 'failed';
  /** Why it failed (`failed` only). */
  readonly error?: string;
  /** The last MCP tool call this session. */
  readonly lastCall?: { readonly tool: string; readonly at: number };
}

/** Where the MCP server file is and how to start it (main fills it in). */
export interface McpSetup {
  /** Absolute path of `third-wheel-mcp.js`. */
  readonly serverPath: string;
  readonly exists: boolean;
  /** Packaged app (the server ships inside the app) vs a dev build from the repo. */
  readonly packaged: boolean;
  readonly platform: string;
  /**
   * Program that runs the server: `node` for a dev build; the app's own executable when packaged
   * (with {@link MCP_RUN_AS_NODE}), so users need no Node install (R4).
   */
  readonly command: string;
  /** Extra environment for `command`. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * macOS: the app runs from the disk image or a quarantine copy (App Translocation), so the paths
   * above stop working once it is moved: connect after moving it to Applications (R4).
   */
  readonly temporaryLocation: boolean;
}

/** Makes the app's Electron binary run the MCP server as plain Node (packaged app, R4). */
export const MCP_RUN_AS_NODE: Readonly<Record<string, string>> = { ELECTRON_RUN_AS_NODE: '1' };

/** Name of the MCP server in Claude Code's config. */
export const MCP_SERVER_NAME = 'third-wheel';

/** Outcome of a one-click Connect button (R4; other agents T14.2). */
export type ConnectResult =
  /** `path`: the program run, the file written or the link opened. */
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false;
      readonly reason: 'not-found' | 'temporary-location' | 'failed';
      /** `failed`: what Claude Code printed (trimmed). */
      readonly detail?: string;
    };

/** A call within this many ms counts as recent (green dot). */
export const RECENT_CALL_MS = 10 * 60_000;

export type DotState = 'idle' | 'active' | 'busy' | 'error';

export interface StatusView {
  readonly dot: DotState;
  readonly label: string;
  readonly title: string;
}

/** "just now", "1 min ago", "2 h ago", "3 days ago". */
export function ago(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${String(min)} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${String(h)} h ago`;
  const d = Math.floor(h / 24);
  return `${String(d)} ${d === 1 ? 'day' : 'days'} ago`;
}

/** The status-bar item: grey = no call yet / quiet, green = a call in the last 10 min, red = bridge down. */
export function aiStatusView(activity: AiActivity, now: number): StatusView {
  const setupHint = 'Click to see how to connect an AI agent.';
  if (activity.bridge === 'failed')
    return {
      dot: 'error',
      label: "AI: off — couldn't start",
      title: `AI agents can't reach the app: ${activity.error ?? 'the connection could not start'}. Restart the app to try again.`,
    };
  if (activity.bridge === 'off')
    return {
      dot: 'error',
      label: 'AI: off',
      title: 'The AI connection is turned off (THIRD_WHEEL_BRIDGE=0).',
    };
  if (activity.bridge === 'starting')
    return { dot: 'idle', label: 'AI: starting…', title: setupHint };
  const last = activity.lastCall;
  if (!last)
    return {
      dot: 'idle',
      label: 'AI: ready · no calls yet',
      title: `No AI agent has used the app yet this session. ${setupHint}`,
    };
  const since = now - last.at;
  return {
    dot: since <= RECENT_CALL_MS ? 'active' : 'idle',
    label: `AI: ready · last call ${ago(since)}`,
    title: `Last AI call: ${last.tool} at ${new Date(last.at).toLocaleTimeString()}. ${setupHint}`,
  };
}

/** Quote a path for the user's shell: cmd / PowerShell on Windows, sh / zsh elsewhere. */
export function shellQuote(path: string, platform: string): string {
  // Windows paths can't contain `"`; double quotes work in cmd and PowerShell alike.
  if (platform === 'win32') return `"${path}"`;
  // Double quotes read best; switch to single quotes when the path has characters sh expands.
  if (!/["$`\\!]/.test(path)) return `"${path}"`;
  return `'${path.replaceAll("'", `'\\''`)}'`;
}

export type McpScope = 'folder' | 'user';

/** The arguments after `claude` for `claude mcp add …` (the button runs these without a shell). */
export function claudeAddArgs(setup: McpSetup, scope: McpScope): string[] {
  return [
    'mcp',
    'add',
    ...(scope === 'user' ? ['--scope', 'user'] : []),
    MCP_SERVER_NAME,
    // After the name: `--env` takes several values and would swallow it.
    ...Object.entries(setup.env).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
    '--',
    setup.command,
    setup.serverPath,
  ];
}

/** `claude mcp add …` for this app's MCP server. `folder` = Claude Code's default (local) scope. */
export function claudeAddCommand(setup: McpSetup, scope: McpScope): string {
  const scopeFlag = scope === 'user' ? ' --scope user' : '';
  const env = Object.entries(setup.env)
    .map(([k, v]) => ` --env ${k}=${v}`)
    .join('');
  const command = setup.command === 'node' ? 'node' : shellQuote(setup.command, setup.platform);
  return `claude mcp add${scopeFlag} ${MCP_SERVER_NAME}${env} -- ${command} ${shellQuote(setup.serverPath, setup.platform)}`;
}

/** `.mcp.json` for a project folder (JSON escapes Windows backslashes). */
export function mcpJsonSnippet(setup: McpSetup): string {
  const env = Object.keys(setup.env).length > 0 ? { env: setup.env } : {};
  return JSON.stringify(
    {
      mcpServers: {
        [MCP_SERVER_NAME]: { command: setup.command, args: [setup.serverPath], ...env },
      },
    },
    null,
    2,
  );
}

/** Save indicator in the same dot + label style (T7.6). */
export function saveStatusView(state: 'pending' | 'saving' | 'saved' | 'error'): {
  readonly dot: DotState;
  readonly label: string;
} {
  if (state === 'saved') return { dot: 'idle', label: 'Saved' };
  if (state === 'error') return { dot: 'error', label: 'Not saved — hover for details' };
  return { dot: 'busy', label: 'Saving…' };
}
