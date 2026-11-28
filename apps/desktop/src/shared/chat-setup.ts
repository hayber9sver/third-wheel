/**
 * The Connect pop-up's "Chat in Third Wheel" part (pure): the terminal line that starts the agent
 * in the project folder, the live status (waiting → connected → listening), and "Ask fewer
 * permission questions" — the rules an agent's description file (`chat.allow`) pre-allows, merged
 * into its settings file in that folder without losing what is there.
 */
import type { AllowSpec } from './agent-desc.js';
import { MCP_SERVER_NAME } from './ai-status.js';
import type { ChatStatus } from './chat.js';
import { lastPart, samePath } from './claude-setup.js';

/** The CAD command the pre-allow rule names until the user changes it. */
export const DEFAULT_CAD_COMMAND = 'python *.py';
const MAX_CAD_COMMAND_LENGTH = 200;

/**
 * The line to paste in a terminal: go to `folder`, start the agent. Single quotes: the shell takes
 * the folder as it is (no `$`, no globbing). macOS / Linux = zsh / bash; Windows = PowerShell (the
 * default in Windows Terminal).
 */
export function startCommand(program: string, folder: string, platform: string): string {
  // PowerShell: -LiteralPath (no wildcards: "Bracket [v2]"); it reads ‘ ’ ‚ ‛ as quotes too.
  if (platform === 'win32')
    return `cd -LiteralPath '${folder.replace(/['\u2018-\u201b]/g, (q) => q + q)}'; ${program}`;
  return `cd '${folder.replaceAll("'", "'\\''")}' && ${program}`;
}

/** `inner` is `outer` or a folder below it. */
export function isInside(inner: string, outer: string, platform: string): boolean {
  if (samePath(inner, outer, platform)) return true;
  const norm = (p: string): string => {
    const s = platform === 'win32' ? p.replaceAll('\\', '/').toLowerCase() : p;
    return s.endsWith('/') ? s : `${s}/`;
  };
  return norm(inner).startsWith(norm(outer));
}

export interface ChatSetupLine {
  readonly state: 'waiting' | 'connected' | 'listening' | 'stopped';
  readonly text: string;
  /** A problem to show under the line (amber). */
  readonly warn?: string;
}

/**
 * The live status under the steps. `folder` = the project folder the steps name; `label` = the
 * agent's name in sentences ("Claude Code").
 */
export function chatSetupLine(
  status: Pick<ChatStatus, 'state' | 'started'>,
  folder: string | undefined,
  label: string,
  platform: string,
): ChatSetupLine {
  const s = status.state;
  if (s === 'listening' || s === 'working')
    return { state: 'listening', text: `Listening ✓ — type in the Agent tab.` };
  // A start that hasn't listened yet is newer than the one that stopped.
  const started = status.started?.listened ? undefined : status.started;
  if (!started && (s === 'not-listening' || s === 'stopped'))
    return {
      state: 'stopped',
      text: 'Stopped listening. Paste the start phrase (step 2) in its terminal again.',
    };
  if (!started) return { state: 'waiting', text: `Waiting for ${label} to start…` };
  const where = started.folder;
  const warn =
    where !== undefined && folder !== undefined && !isInside(where, folder, platform)
      ? `It started in “${lastPart(where)}”, not in the project folder “${lastPart(folder)}”: files it exports there can’t be opened. Quit it and start it with step 1.`
      : undefined;
  return {
    state: 'connected',
    text: `Connected${where === undefined ? '' : ` (started in “${lastPart(where)}”)`} — now paste the start phrase (step 2).`,
    ...(warn === undefined ? {} : { warn }),
  };
}

/** Why a CAD command can't go into a rule; undefined = fine. */
export function cadCommandProblem(cad: string): string | undefined {
  const t = cad.trim();
  if (t === '') return 'Type the command your agent runs to build the model, e.g. python *.py.';
  if (t.length > MAX_CAD_COMMAND_LENGTH) return 'That command is too long.';
  const control = Array.from({ length: t.length }, (_, i) => t.charCodeAt(i)).some((c) => c < 0x20);
  if (/[()`]/.test(t) || control)
    return 'The command can’t contain brackets, back-quotes or line breaks.';
  if (/^[*\s]/.test(t))
    return 'Start with the program’s name (a lone * would allow every command).';
  return undefined;
}

/** The rules to pre-allow, placeholders filled in (`{name}` = the server's name, `{cad}`). */
export function allowRules(spec: AllowSpec, cad: string, platform: string): string[] {
  const fill = (r: string): string =>
    r.replaceAll('{name}', MCP_SERVER_NAME).replaceAll('{cad}', cad.trim());
  const rules = [...spec.rules, ...(platform === 'win32' ? (spec.windowsRules ?? []) : [])];
  return [...new Set(rules.map(fill))];
}

export type AllowMerge =
  | {
      readonly ok: true;
      /** Rules not in the file yet (empty: nothing to do). */
      readonly add: readonly string[];
      /** The file's new text (unchanged text when `add` is empty). */
      readonly text: string;
    }
  | { readonly ok: false; readonly error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Add `rules` to the list at `key` in a JSON settings file's text (undefined: no file yet). Keeps
 * every other setting and the rules already there; never adds one twice. Refuses a file it can't
 * read as a JSON object, or a `key` that holds something other than a list.
 */
export function mergeAllow(
  text: string | undefined,
  key: readonly string[],
  rules: readonly string[],
): AllowMerge {
  let root: unknown = {};
  if (text !== undefined && text.trim() !== '') {
    try {
      root = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown; // Windows editors may add a BOM
    } catch {
      return { ok: false, error: 'it isn’t valid JSON — fix or remove it first' };
    }
  }
  if (!isRecord(root)) return { ok: false, error: 'it doesn’t hold a JSON object' };
  let at: Record<string, unknown> = root;
  for (const k of key.slice(0, -1)) {
    const next = at[k] ?? {};
    if (!isRecord(next)) return { ok: false, error: `“${k}” in it isn’t an object` };
    at[k] = next;
    at = next;
  }
  const last = key.at(-1);
  if (last === undefined) return { ok: false, error: 'no place for the rules' };
  const list = at[last] ?? [];
  if (!Array.isArray(list)) return { ok: false, error: `“${last}” in it isn’t a list` };
  const add = rules.filter((r) => !list.includes(r));
  if (add.length === 0) return { ok: true, add, text: text ?? '' };
  at[last] = [...(list as unknown[]), ...add];
  return { ok: true, add, text: `${JSON.stringify(root, null, 2)}\n` };
}

/**
 * The lines the box shows before writing: where (`file` relative to `folder`, as the description
 * names it), and exactly what is added.
 */
export function allowPreview(
  file: string,
  folder: string,
  exists: boolean,
  add: readonly string[],
): string {
  const where = `${file} in “${lastPart(folder)}”`;
  const head = exists ? `Adds to ${where}:` : `Creates ${where} with:`;
  return [head, ...add.map((r) => `  "${r}"`)].join('\n');
}

/** What "Allow these" would do (main reads the file; nothing written yet). */
export interface AllowPlan {
  /** The settings file (absolute). */
  readonly file: string;
  readonly exists: boolean;
  /** Rules not in it yet. */
  readonly add: readonly string[];
  /** Why it can't be written (bad CAD command, unreadable file, no folder). */
  readonly error?: string;
}

export type AllowResult =
  | { readonly ok: true; readonly file: string; readonly added: readonly string[] }
  /** `changed`: the file changed since the preview: show it again. */
  | { readonly ok: false; readonly error: string; readonly changed?: boolean };
