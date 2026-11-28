/**
 * Changes the Connect pop-up makes besides Connect itself, each shown to the user first:
 * "Ask fewer permission questions" (pre-allow rules in the agent's settings file in the folder,
 * `chat.allow` of its description) and removing a Third Wheel entry that is in the way (the
 * check's `fixes`).
 */
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { renameWithRetry } from '@third-wheel/core';
import path from 'node:path';
import type { AgentDesc } from '../shared/agent-desc.js';
import { keyPath, removeArgs } from '../shared/agents.js';
import type { ConnectTarget, McpSetup } from '../shared/ai-status.js';
import {
  allowRules,
  cadCommandProblem,
  mergeAllow,
  type AllowPlan,
  type AllowResult,
} from '../shared/chat-setup.js';
import { nodeProjectFs } from './project-fs.js';
import { checkSetup, samePath, type EntryRef, type RemoveResult } from '../shared/claude-setup.js';
import {
  agentEntries,
  findProgram,
  realFolder,
  run,
  targetFolder,
  type Overrides,
} from './agent-cli.js';

/** The file's text; undefined when it doesn't exist. Other read errors throw. */
async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Write a settings file inside a project folder, which may be a cloned repo: never through a
 * link. Refused when the file or its folder is a link (or resolves elsewhere); the `.bak` and the
 * temporary file are made fresh (a planted link in their place is removed, not followed). The old
 * file is kept as `.bak`; the new one is swapped in whole.
 */
export async function writeNoLinks(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await mkdir(dir, { recursive: true });
  if (!samePath(await realpath(dir), dir, process.platform))
    throw new Error(`${dir} is a link to another folder: nothing was written`);
  let existed = false;
  try {
    const st = await lstat(file);
    if (st.isSymbolicLink())
      throw new Error(`${file} is a link to another file: nothing was written`);
    existed = st.isFile();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (existed) {
    const bak = `${file}.bak`;
    await rm(bak, { force: true });
    await copyFile(file, bak, constants.COPYFILE_EXCL);
  }
  const tmp = `${file}.thirdwheel-tmp`;
  await rm(tmp, { force: true });
  await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' });
  try {
    // Windows: a virus scanner or the indexer may hold the file for a moment (EPERM / EBUSY).
    await renameWithRetry(nodeProjectFs, tmp, file);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

interface AllowWork {
  readonly plan: AllowPlan;
  readonly text?: string;
}

async function allowWork(agent: AgentDesc, folder: unknown, cad: unknown): Promise<AllowWork> {
  const spec = agent.chat?.allow;
  const real = await realFolder(typeof folder === 'string' ? folder : undefined);
  const none = (error: string, file = ''): AllowWork => ({
    plan: { file, exists: false, add: [], error },
  });
  if (!spec) return none(`${agent.label} has no settings file for this.`);
  if (!real) return none('Open a project folder first.');
  const file = path.join(real, ...spec.file.split('/'));
  const command = typeof cad === 'string' ? cad : '';
  const problem = cadCommandProblem(command);
  if (problem) return none(problem, file);
  let text: string | undefined;
  try {
    if ((await lstat(file).catch(() => undefined))?.isSymbolicLink())
      return none(`${file} is a link to another file: Third Wheel doesn’t change it.`, file);
    text = await readText(file);
  } catch (e) {
    return none(`Can’t read ${file}: ${e instanceof Error ? e.message : String(e)}`, file);
  }
  const merged = mergeAllow(text, spec.key, allowRules(spec, command, process.platform));
  if (!merged.ok) return none(`Can’t add to ${file}: ${merged.error}.`, file);
  return {
    plan: { file, exists: text !== undefined, add: merged.add },
    text: merged.text,
  };
}

/** What "Allow these" would add to the settings file in `folder` (reads only). */
export async function planAllow(
  agent: AgentDesc,
  folder: unknown,
  cad: unknown,
): Promise<AllowPlan> {
  return (await allowWork(agent, folder, cad)).plan;
}

/**
 * Add the rules the preview showed (`shown`). Refused when the file changed meanwhile so that
 * other rules would be added; the old file is kept as `.bak`.
 */
export async function writeAllow(
  agent: AgentDesc,
  folder: unknown,
  cad: unknown,
  shown: unknown,
): Promise<AllowResult> {
  const work = await allowWork(agent, folder, cad);
  const { plan } = work;
  if (plan.error !== undefined) return { ok: false, error: plan.error };
  const same =
    Array.isArray(shown) &&
    shown.length === plan.add.length &&
    shown.every((r, i) => r === plan.add[i]);
  if (!same)
    return { ok: false, error: 'The file changed: look at the lines again.', changed: true };
  if (plan.add.length === 0 || work.text === undefined)
    return { ok: true, file: plan.file, added: [] };
  try {
    await writeNoLinks(plan.file, work.text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  return { ok: true, file: plan.file, added: plan.add };
}

/**
 * Remove a Third Wheel entry the check offered to remove (`which`), found again in the agent's
 * settings for the folder: a folder's `.mcp.json` part is cut out of the file (`.bak` kept);
 * others go through the agent's own remove command, in the entry's folder.
 */
export async function removeEntry(
  agent: AgentDesc,
  setup: McpSetup,
  target: ConnectTarget,
  which: EntryRef,
  ov: Overrides = {},
): Promise<RemoveResult> {
  const cmd = agent.command;
  if (!cmd) return { ok: false, detail: 'This agent has no entries to remove.' };
  const folder = await targetFolder(target);
  const entries = await agentEntries(agent, folder, ov);
  const e = entries.find(
    (x) => x.where === which.where && samePath(x.file, which.file, process.platform),
  );
  // Only what the check offered: an entry in the way, never the one that works.
  const offered = checkSetup(agent, entries, setup, folder).fixes;
  if (!e || !offered.includes(e))
    return { ok: false, detail: 'That entry isn’t there any more (or is fine now): look again.' };
  if (e.where === 'project') {
    const spec = cmd.entries.find((x) => x.where === 'project');
    try {
      const text = await readText(e.file);
      const json: unknown = text === undefined ? undefined : JSON.parse(text);
      const key = keyPath(spec?.key ?? []);
      let at: unknown = json;
      for (const k of key.slice(0, -1))
        at = typeof at === 'object' && at !== null ? (at as Record<string, unknown>)[k] : undefined;
      const last = key.at(-1);
      if (typeof at !== 'object' || at === null || last === undefined || !(last in at))
        return { ok: false, detail: 'That entry isn’t there any more: look again.' };
      Reflect.deleteProperty(at, last);
      await writeNoLinks(e.file, `${JSON.stringify(json, null, 2)}\n`);
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
  const program = await findProgram(agent, ov);
  if (!program) return { ok: false, detail: `${agent.label} wasn’t found.` };
  if (target.program !== undefined && target.program !== program)
    return { ok: false, detail: `${agent.label} was found in another place now: look again.` };
  const cwd = (e.where === 'local' ? (e.folder ?? folder) : undefined) ?? homedir();
  const { code, out } = await run(program, removeArgs(cmd, e.where), cmd.timeoutSec * 1000, cwd);
  return code === 0
    ? { ok: true }
    : { ok: false, detail: out.slice(0, 500) || `exit code ${String(code)}` };
}
