/**
 * AI connection status: what the status-bar item and the "Set up your AI agent" pop-up show.
 * The MCP server opens one bridge connection per tool call, so the app never knows an agent is
 * "connected" — only whether the bridge runs and when the last tool call came in.
 */
import { MAX_CHAT_WAIT_SECONDS } from '@third-wheel/core';
import type { FoundEntry, SetupCheck } from './claude-setup.js';
import type { McpScope } from './agent-desc.js';

/** Bridge methods the MCP tools call → the tool name the user sees in Claude Code. */
const TOOL_OF_METHOD: Readonly<Record<string, string>> = {
  load: 'load_model',
  request_review: 'request_review',
  wait_review: 'wait_for_review',
  annotations: 'get_annotations',
  render: 'render_region',
  set_comment_status: 'set_comment_status',
  reply_comment: 'reply_to_comment',
  chat_wait: 'wait_for_message',
  chat_send: 'send_chat_message',
  chat_progress: 'post_progress',
  chat_history: 'get_chat_history',
  chat_summary: 'post_chat_summary',
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
   * (with {@link MCP_RUN_AS_NODE}), so users need no Node install.
   */
  readonly command: string;
  /** Extra environment for `command`. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * macOS: the app runs from the disk image or a quarantine copy (App Translocation), so the paths
   * above stop working once it is moved: connect after moving it to Applications.
   */
  readonly temporaryLocation: boolean;
}

/** Makes the app's Electron binary run the MCP server as plain Node (packaged app). */
export const MCP_RUN_AS_NODE: Readonly<Record<string, string>> = { ELECTRON_RUN_AS_NODE: '1' };

/** Name of the MCP server in Claude Code's config. */
export const MCP_SERVER_NAME = 'third-wheel';

/** What a one-click Connect is for (Claude Code: the switch + folder). */
export interface ConnectTarget {
  readonly scope: McpScope;
  /** "This folder only": the folder chosen in the pop-up (main checks it). */
  readonly folder?: string | undefined;
  /** Without `folder`: the shown project's folder is the default … */
  readonly projectFolder?: string | undefined;
  /** … else the shown model's folder. */
  readonly modelPath?: string | undefined;
  /**
   * Connect: the program the "about to run" box showed. Main runs only that one; if its own
   * lookup finds another now, it refuses (`changed`) and the pop-up shows the plan again.
   */
  readonly program?: string | undefined;
  /** The user agreed to replace the entry the plan showed (same scope). */
  readonly replace?: boolean | undefined;
}

/** What a one-click Connect would do, shown before it runs. Reads files only. */
export interface ConnectPlan {
  /** The program that runs (`claude` / `gemini`); null = not found. */
  readonly program: string | null;
  /** "This folder only": the folder it runs in (real path). */
  readonly folder?: string;
  /** Why it can't run (no folder chosen, a path cmd.exe can't pass on …). */
  readonly blocked?: string;
  /** The commands, in order, as the user would type them. */
  readonly steps: readonly string[];
  /** An entry of the same scope that Connect would replace (asked first). */
  readonly replace?: FoundEntry;
  /** Claude Code: what it will use now for that folder. */
  readonly check?: SetupCheck;
}

/** Outcome of a one-click Connect button (other agents use the same shape). */
export type ConnectResult =
  /** `path`: the program run, the file written or the link opened. */
  | {
      readonly ok: true;
      readonly path: string;
      /** Claude Code: what it will use afterwards; green only when `state` is ok. */
      readonly check?: SetupCheck;
    }
  | {
      readonly ok: false;
      /**
       * `exists`: an entry appeared since the plan was shown; `changed`: the program differs
       * from the one the box showed — show the plan again.
       */
      readonly reason: 'not-found' | 'temporary-location' | 'failed' | 'exists' | 'changed';
      /** `failed`: what Claude Code printed (trimmed). */
      readonly detail?: string;
    };

/**
 * A call within this many ms counts as recent (green dot). Calls are recorded when they start and
 * end, so this outlasts the longest chat wait: a listening agent keeps the dot green.
 */
export const RECENT_CALL_MS = (MAX_CHAT_WAIT_SECONDS + 5 * 60) * 1000;

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

/**
 * The status-bar item: grey = no agent yet / quiet, green = an agent listens in the Agent tab
 * (`listening`: a chat wait is open) or a recent call (`RECENT_CALL_MS`), red = bridge down.
 * Never "ready" or "connected" (read as "an AI is connected").
 */
export function aiStatusView(activity: AiActivity, now: number, listening = false): StatusView {
  const setupHint = 'Click to see how to set up an AI agent.';
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
  if (listening)
    return {
      dot: 'active',
      label: 'AI: listening',
      title: `An AI agent is waiting for your messages in the Agent tab. ${setupHint}`,
    };
  const last = activity.lastCall;
  if (!last)
    return {
      dot: 'idle',
      label: 'AI: no agent yet',
      title: `No AI agent has used the app yet this session. ${setupHint}`,
    };
  const since = now - last.at;
  return {
    dot: since <= RECENT_CALL_MS ? 'active' : 'idle',
    label: `AI: last call ${ago(since)}`,
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

export type { McpScope } from './agent-desc.js';

/** Save indicator in the same dot + label style. */
export function saveStatusView(state: 'pending' | 'saving' | 'saved' | 'error'): {
  readonly dot: DotState;
  readonly label: string;
} {
  if (state === 'saved') return { dot: 'idle', label: 'Saved' };
  if (state === 'error') return { dot: 'error', label: 'Not saved — hover for details' };
  return { dot: 'busy', label: 'Saving…' };
}
