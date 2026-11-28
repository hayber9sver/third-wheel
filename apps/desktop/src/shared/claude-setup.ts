/**
 * What an agent will use for a folder: the Third Wheel entries in its settings (where they are:
 * its description file's `command.entries`) and whether the one it picks can start this app's MCP
 * server. Pure (main reads the files, the pop-up shows the result). Written for Claude Code, the
 * only agent with `command.check` so far.
 *
 * Claude Code 2.1 (checked by hand with `claude mcp add` / `get` in a scratch settings folder):
 * - "This folder only" (local scope) is stored in `~/.claude.json` under `projects[<folder>]`,
 *   the folder's real path — or the git project's top folder when the folder is inside one. So it
 *   counts in subfolders only inside a git project, and stops counting when the folder is moved or
 *   renamed (the entry stays under the old path).
 * - A `.mcp.json` counts in its folder and every folder below it (with or without git).
 * - "All my folders" (user scope) is `~/.claude.json` → `mcpServers`.
 * - Several at once: Claude Code uses local, then `.mcp.json`, then user, and warns about
 *   "multiple scopes" when they point to different places.
 */
import type { AgentDesc, ApprovalSpec, EntryWhere, McpScope } from './agent-desc.js';
import { removeText } from './agents.js';
import { MCP_SERVER_NAME, type ConnectPlan, type McpSetup } from './ai-status.js';

export type { EntryWhere } from './agent-desc.js';

/** A Third Wheel entry found in Claude Code's settings. */
export interface FoundEntry {
  readonly where: EntryWhere;
  /** The settings file it is in. */
  readonly file: string;
  /** local: the folder it is filed under. */
  readonly folder?: string;
  readonly command: string;
  readonly args: readonly string[];
  /** Its environment variables (text values only). */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Filled in by main for an entry the agent asks about first (a folder's `.mcp.json`): `on` =
   * the user said yes, `off` = no (the agent ignores it), `ask` = not asked yet.
   */
  readonly approval?: 'on' | 'off' | 'ask';
  /** The `.js` file it starts (or its first argument); undefined when it has none. */
  readonly serverPath?: string;
  /** Filled in by main: that file exists. */
  readonly serverExists: boolean;
}

export interface SetupCheck {
  /** ok = the entry Claude Code will use starts this app's server; none = no entry. */
  readonly state: 'ok' | 'none' | 'warn';
  /** A few words for the status line ("Set up ✓", "Won’t work yet"). */
  readonly short: string;
  /** The whole story (under "Why?" when it won't work). */
  readonly text: string;
  /** The entry Claude Code will use. */
  readonly used?: FoundEntry;
  readonly entries: readonly FoundEntry[];
  /** Entries in the way (broken, or a second one): the pop-up offers to remove each. */
  readonly fixes: readonly FoundEntry[];
}

export type RawEntry = Omit<FoundEntry, 'serverExists' | 'approval'>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Paths compared the way the platform does: Windows ignores case and `/` vs `\`. */
export function samePath(a: string, b: string, platform: string): boolean {
  const norm = (p: string): string => {
    let s = platform === 'win32' ? p.replaceAll('\\', '/').toLowerCase() : p;
    while (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/i.test(s)) s = s.slice(0, -1);
    return s;
  };
  return norm(a) === norm(b);
}

function entryOf(
  servers: Record<string, unknown>,
  name: string,
  where: EntryWhere,
  file: string,
  folder?: string,
): RawEntry | undefined {
  const e = servers[name];
  if (!isRecord(e)) return undefined;
  const command = typeof e['command'] === 'string' ? e['command'] : '';
  const args = Array.isArray(e['args'])
    ? e['args'].filter((a): a is string => typeof a === 'string')
    : [];
  const serverPath = args.find((a) => /\.[cm]?js$/i.test(a)) ?? args[0];
  const env: Record<string, string> = {};
  if (isRecord(e['env']))
    for (const [k, x] of Object.entries(e['env'])) if (typeof x === 'string') env[k] = x;
  return {
    where,
    file,
    ...(folder === undefined ? {} : { folder }),
    command,
    args,
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(serverPath === undefined ? {} : { serverPath }),
  };
}

/**
 * The entry at `key` (a path of keys, `{name}` filled in) in a settings file's parsed content.
 * A `{project}` key = `projectKey` (the folder or its git project's top folder), compared the way
 * the platform compares paths; without a `projectKey` such an entry doesn't count.
 */
export function entryInJson(
  json: unknown,
  key: readonly string[],
  where: EntryWhere,
  file: string,
  projectKey: string | undefined,
  platform: string,
): RawEntry | undefined {
  let at: unknown = json;
  let folder: string | undefined;
  for (const k of key.slice(0, -1)) {
    if (!isRecord(at)) return undefined;
    if (k === '{project}') {
      if (projectKey === undefined) return undefined;
      const found = Object.keys(at).find((x) => samePath(x, projectKey, platform));
      if (found === undefined) return undefined;
      folder = found;
      at = at[found];
    } else at = at[k];
  }
  const last = key.at(-1);
  return last === undefined || !isRecord(at) ? undefined : entryOf(at, last, where, file, folder);
}

/** The object at `key` in a settings file's parsed content (`{project}` as in {@link entryInJson}). */
export function objectAt(
  json: unknown,
  key: readonly string[],
  projectKey: string | undefined,
  platform: string,
): Record<string, unknown> | undefined {
  let at: unknown = json;
  for (const k of key) {
    if (!isRecord(at)) return undefined;
    if (k === '{project}') {
      if (projectKey === undefined) return undefined;
      const found = Object.keys(at).find((x) => samePath(x, projectKey, platform));
      at = found === undefined ? undefined : at[found];
    } else at = at[k];
  }
  return isRecord(at) ? at : undefined;
}

/**
 * The user's yes / no for a folder's entry named `name`, from the objects the approval files hold
 * (see {@link ApprovalSpec}): a no anywhere wins; else a yes (by name or "all") anywhere; else
 * not asked yet.
 */
export function approvalOf(
  objects: readonly (Record<string, unknown> | undefined)[],
  spec: Pick<ApprovalSpec, 'enabled' | 'disabled' | 'all'>,
  name: string,
): 'on' | 'off' | 'ask' {
  const named = (o: Record<string, unknown>, k: string): boolean => {
    const list = o[k];
    return Array.isArray(list) && list.includes(name);
  };
  let on = false;
  for (const o of objects) {
    if (!o) continue;
    if (named(o, spec.disabled)) return 'off';
    if (named(o, spec.enabled) || o[spec.all] === true) on = true;
  }
  return on ? 'on' : 'ask';
}

/** The last part of a path ("cad" of "/Users/me/cad"), for short sentences. */
export function lastPart(folder: string): string {
  return folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;
}

/** Where an entry is, in the pop-up's words; `folder` = the folder checked. */
export function whereText(e: FoundEntry, folder?: string, platform = ''): string {
  if (e.where === 'local')
    return folder === undefined || e.folder === undefined || samePath(e.folder, folder, platform)
      ? '“This folder only”'
      : `“This folder only” of the git project ${e.folder}`;
  if (e.where === 'project') return e.file;
  return '“All my folders”';
}

/** How to remove an entry the app doesn't touch itself. */
function removeHint(e: FoundEntry, agent: AgentDesc): string {
  return e.where === 'project' || !agent.command
    ? `delete the "${MCP_SERVER_NAME}" part of ${e.file}`
    : removeText(agent.command, e.where);
}

/** Where a one-click Connect in `scope` writes, as the agent names it. */
export function entryWhereOf(agent: AgentDesc, scope: McpScope): EntryWhere {
  return agent.command?.scopes[scope]?.where ?? (scope === 'folder' ? 'local' : 'user');
}

/** The setup facts the check compares an entry with (`command` / `env`: how this app starts it). */
export type CheckSetup = Pick<McpSetup, 'serverPath' | 'platform'> &
  Partial<Pick<McpSetup, 'command' | 'env'>>;

function baseName(p: string): string {
  return p.split(/[\\/]/).at(-1) ?? p;
}

/** Why the entry can't start the server the way this app needs; undefined = fine. */
function runProblem(e: FoundEntry, setup: CheckSetup, name: string): string | undefined {
  const want = setup.command;
  if (want === undefined) return undefined;
  const isNode = (c: string): boolean => /^node(\.exe)?$/i.test(baseName(c));
  const sameProgram =
    samePath(e.command, want, setup.platform) || (want === 'node' && isNode(e.command));
  if (!sameProgram)
    return `Its entry starts the server with ${e.command || 'no program'}, not ${want}: ${name} can’t start Third Wheel this way. Add it again to replace it.`;
  const missing = Object.entries(setup.env ?? {}).filter(([k, v]) => e.env?.[k] !== v);
  if (missing.length > 0)
    return `Its entry misses ${missing.map(([k, v]) => `${k}=${v}`).join(', ')}: the app would open a window instead of starting the server. Add it again to replace it.`;
  return undefined;
}

/**
 * Which entry Claude Code will use in `folder` (or anywhere, without one) and whether it starts
 * this app's server. Green (`ok`) only when that entry's file exists and is this app's, it is
 * started the way this app needs, and (a folder's `.mcp.json`) the user said yes to it. An entry
 * the user said no to doesn't count.
 */
export function checkSetup(
  agent: AgentDesc,
  entries: readonly FoundEntry[],
  setup: CheckSetup,
  folder: string | undefined,
): SetupCheck {
  const order = agent.command?.entries.map((e) => e.where) ?? [];
  const rank = (e: FoundEntry): number => {
    const i = order.indexOf(e.where);
    return i < 0 ? order.length : i;
  };
  const sorted = [...entries].sort((a, b) => rank(a) - rank(b));
  const active = sorted.filter((e) => e.approval !== 'off');
  const turnedOff = sorted.filter((e) => e.approval === 'off');
  const name = agent.label;
  const used = active[0];
  const forWhere = folder === undefined ? '' : ` in “${lastPart(folder)}”`;
  const where = (e: FoundEntry): string => whereText(e, folder, setup.platform);
  const offText = turnedOff
    .map((e) => ` ${where(e)} has one, but you said no to it in ${name}.`)
    .join('');
  if (!used)
    return {
      state: 'none',
      short: 'Not set up yet',
      text:
        (folder === undefined
          ? `Not set up yet: ${name} has no Third Wheel entry for all folders.`
          : `Not set up yet for ${folder}.`) + offText,
      entries: sorted,
      fixes: [],
    };
  const same = (e: FoundEntry): boolean =>
    e.serverPath !== undefined && samePath(e.serverPath, setup.serverPath, setup.platform);
  const problems: string[] = [];
  const fixes: FoundEntry[] = [];
  let usedProblem: string | undefined;
  if (!used.serverPath || !used.serverExists)
    usedProblem = `${name}${forWhere} uses the entry in ${where(used)}, and it points to ${used.serverPath ?? 'no file'}, which doesn’t exist: ${name} can’t start Third Wheel (“Connection closed”).`;
  else if (!same(used))
    usedProblem = `${name}${forWhere} uses the entry in ${where(used)}, which starts another copy of Third Wheel (${used.serverPath}), not this app.`;
  else {
    const run = runProblem(used, setup, name);
    if (run) usedProblem = `${name}${forWhere} uses the entry in ${where(used)}. ${run}`;
  }
  if (usedProblem) {
    problems.push(usedProblem);
    fixes.push(used);
  }
  const others = active
    .slice(1)
    .filter(
      (e) =>
        !(
          e.serverPath &&
          used.serverPath &&
          samePath(e.serverPath, used.serverPath, setup.platform)
        ),
    );
  for (const e of others) {
    problems.push(
      `Also set in ${where(e)} (points to ${e.serverPath ?? 'no file'}): ${name} warns about “multiple scopes”. To remove it: ${removeHint(e, agent)}.`,
    );
    fixes.push(e);
  }
  if (problems.length > 0)
    return {
      state: 'warn',
      short: 'Won’t work yet',
      text: problems.join(' ') + offText,
      used,
      entries: sorted,
      fixes,
    };
  if (used.approval === 'ask')
    return {
      state: 'warn',
      short: 'Needs your yes',
      text: `${name}${forWhere} will use the entry in ${where(used)} once you say yes: it asks when it starts in this folder (“New MCP server found in .mcp.json”).${offText}`,
      used,
      entries: sorted,
      fixes: [],
    };
  return {
    state: 'ok',
    short: 'Set up ✓',
    text: `Set up ✓ ${name}${forWhere} uses the entry in ${where(used)}, which starts this app’s server.${offText}`,
    used,
    entries: sorted,
    fixes: [],
  };
}

/** The line above the commands in the "about to run" box. */
export function confirmLead(plan: ConnectPlan, scope: McpScope): string {
  if (plan.blocked) return `Can’t run yet: ${plan.blocked}`;
  if (scope === 'user') return 'Runs, for all your folders:';
  return plan.folder ? `Runs in “${lastPart(plan.folder)}”:` : 'Runs:';
}

/** Under "Details" in the box: program, folder and where the entry goes. */
export function confirmText(plan: ConnectPlan, scope: McpScope, label = 'Claude Code'): string {
  const lines = [`Program: ${plan.program ?? 'not found'}`];
  if (scope === 'folder') lines.push(`In folder: ${plan.folder ?? 'none chosen'}`);
  lines.push(
    scope === 'folder'
      ? `Writes a “This folder only” entry into your ${label} settings.`
      : 'Writes an “All my folders” entry into the agent’s settings.',
  );
  if (plan.replace) lines.push(replaceText(plan.replace, plan.folder));
  return lines.join('\n');
}

/** One line in the box when an entry would be replaced. */
export function replaceShort(e: FoundEntry): string {
  return e.serverExists
    ? 'Replaces your existing Third Wheel entry.'
    : 'Replaces your existing Third Wheel entry (its file is missing).';
}

/** The existing entry Connect would replace, said before it does. */
export function replaceText(e: FoundEntry, folder?: string, platform = ''): string {
  const target = e.serverPath
    ? `${e.serverPath}${e.serverExists ? '' : ' (that file doesn’t exist)'}`
    : 'no file';
  return `There already is a Third Wheel entry in ${whereText(e, folder, platform)}, pointing to ${target}. Adding removes it first.`;
}

/** An entry the pop-up offers to remove (main finds it again by these). */
export interface EntryRef {
  readonly where: EntryWhere;
  readonly file: string;
}

export type RemoveResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

/** What removing an entry does, said before it runs (`program`: the agent's, as found). */
export function removeFixText(e: FoundEntry, agent: AgentDesc, folder?: string): string {
  if (e.where === 'project' || !agent.command)
    return `Removes the "${MCP_SERVER_NAME}" part of ${e.file} (a copy is kept as ${lastPart(e.file)}.bak).`;
  const runIn = e.where === 'local' ? (e.folder ?? folder) : undefined;
  return `Runs${runIn ? ` in “${lastPart(runIn)}”` : ''}: ${removeText(agent.command, e.where)}`;
}

/** The fix button's text. */
export function removeFixLabel(e: FoundEntry, folder?: string, platform = ''): string {
  return `Remove the entry in ${whereText(e, folder, platform)}…`;
}
