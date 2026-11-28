/**
 * Reading and writing a project folder (docs/file-format.md). Core does no I/O itself: the app
 * passes a `ProjectFs` over Node's `fs` and Node's `path`; tests pass an in-memory one. Rules:
 *
 * - Saves are atomic: each file goes to `<file>.<id>.tmp`, then is renamed over the old one;
 *   a rename that Windows refuses for a moment (antivirus, OneDrive, Explorer preview holding the
 *   file: `EPERM` / `EBUSY` / `EACCES`) is retried ≈ 50 → 500 ms, then reported.
 * - A grouped save writes all temp files first; if any fails, none is renamed. Marks files are
 *   renamed before `project.json`, so the project never lists marks that are not there.
 * - Everything is checked against the schema before it is written: a bug never writes a file
 *   this app can't read back.
 * - Chat lines are appended one `appendFile` per entry (no long-held handles).
 * - v1 limits kept: a file over 256 MB is unreadable; a newer `schemaVersion` is refused.
 * - Writing `\n`; reading accepts `\r\n` (git autocrlf on Windows).
 */
import { formatJson } from './format-json.js';
import { lockState, lockText, parseLock, type LockSelf, type LockState } from './project-lock.js';
import {
  isKnownProjectEntry,
  newId,
  projectSearchFolders,
  type PathApi,
  type ProjectFiles,
  type RandomBytes,
} from './project-paths.js';
import {
  PROJECT_DIR,
  PROJECT_GITIGNORE,
  chatLine,
  parseChatLog,
  parseProjectJson,
  parseVersionMarksJson,
  projectSchema,
  versionMarksSchema,
  type ChatEntry,
  type ChatParse,
  type Project,
  type V2ParseResult,
  type VersionMarks,
} from './project-schema.js';

/** Largest project file read (as v1 sidecars). */
export const MAX_PROJECT_FILE_BYTES = 256 * 1024 * 1024;

/** Waits between rename tries while Windows holds the target (ms). */
export const RENAME_RETRY_MS: readonly number[] = [50, 100, 200, 400, 500];
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** The file operations the store needs. Errors carry Node's `code` (`ENOENT`, `EPERM`, …). */
export interface ProjectFs {
  /** UTF-8 text of a file. */
  readText(file: string): Promise<string>;
  /** Last `bytes` bytes of a file as text ("" when empty). */
  readTail(file: string, bytes: number): Promise<string>;
  /** Size in bytes; `undefined` when there is no such file. */
  size(file: string): Promise<number | undefined>;
  isDirectory(p: string): Promise<boolean>;
  writeText(file: string, text: string): Promise<void>;
  /** Create a file only if it doesn't exist (`wx`); `false` when it exists. */
  createExclusive(file: string, text: string): Promise<boolean>;
  appendText(file: string, text: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** Remove a file; no error when it is already gone. */
  remove(file: string): Promise<void>;
  /** Names in a folder; `[]` when the folder doesn't exist. */
  list(dir: string): Promise<string[]>;
  /** Make a folder and its parents. */
  makeDir(dir: string): Promise<void>;
  /** Wait (tests make it instant). */
  sleep(ms: number): Promise<void>;
}

export function errorCode(e: unknown): string | undefined {
  return typeof e === 'object' && e !== null && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;
}

// --- reading -------------------------------------------------------------------------------------

export type ReadResult<T> =
  | { readonly kind: 'missing' }
  | { readonly kind: 'ok'; readonly data: T }
  /** Not JSON, schema errors, too big or not readable → moved aside to a `.bak.json` by the caller. */
  | { readonly kind: 'unreadable'; readonly errors: readonly string[] }
  /** Made by a newer app: refused, never moved aside or overwritten. */
  | { readonly kind: 'newer'; readonly errors: readonly string[] };

async function readChecked(fs: ProjectFs, file: string): Promise<ReadResult<string>> {
  let size: number | undefined;
  try {
    size = await fs.size(file);
  } catch (e) {
    return { kind: 'unreadable', errors: [`can't read the file (${errorCode(e) ?? String(e)})`] };
  }
  if (size === undefined) return { kind: 'missing' };
  if (size > MAX_PROJECT_FILE_BYTES) {
    return { kind: 'unreadable', errors: ['larger than 256 MB'] };
  }
  try {
    return { kind: 'ok', data: await fs.readText(file) };
  } catch (e) {
    if (errorCode(e) === 'ENOENT') return { kind: 'missing' };
    return { kind: 'unreadable', errors: [`can't read the file (${errorCode(e) ?? String(e)})`] };
  }
}

async function readParsed<T>(
  fs: ProjectFs,
  file: string,
  parse: (text: string) => V2ParseResult<T>,
): Promise<ReadResult<T>> {
  const text = await readChecked(fs, file);
  if (text.kind !== 'ok') return text;
  const r = parse(text.data);
  if (r.ok) return { kind: 'ok', data: r.data };
  return { kind: r.reason === 'newer' ? 'newer' : 'unreadable', errors: r.errors };
}

export function readProject(fs: ProjectFs, files: ProjectFiles): Promise<ReadResult<Project>> {
  return readParsed(fs, files.project, parseProjectJson);
}

/**
 * A version's marks. A file that names another version (copied by hand) is unreadable: its
 * triangle numbers belong to that other version.
 */
export async function readMarks(
  fs: ProjectFs,
  files: ProjectFiles,
  versionId: string,
): Promise<ReadResult<VersionMarks>> {
  const r = await readParsed(fs, files.marks(versionId), parseVersionMarksJson);
  if (r.kind === 'ok' && r.data.versionId !== versionId) {
    return {
      kind: 'unreadable',
      errors: [`belongs to version "${r.data.versionId}", not "${versionId}"`],
    };
  }
  return r;
}

export async function readChat(
  fs: ProjectFs,
  files: ProjectFiles,
  chatId: string,
): Promise<ReadResult<ChatParse>> {
  const text = await readChecked(fs, files.chat(chatId));
  return text.kind === 'ok' ? { kind: 'ok', data: parseChatLog(text.data) } : text;
}

/**
 * Files in `.thirdwheel/` that are not ours (sync conflict copies like `project (1).json` or
 * `project-PC.json`, stray files), relative with `/`. The app ignores them and names them in a notice.
 */
export async function strayProjectFiles(fs: ProjectFs, files: ProjectFiles): Promise<string[]> {
  const out: string[] = [];
  for (const name of await fs.list(files.dir)) {
    if (!isKnownProjectEntry('dir', name)) out.push(name);
  }
  for (const [where, dir] of [
    ['marks', files.marksDir],
    ['chats', files.chatsDir],
  ] as const) {
    for (const name of await fs.list(dir)) {
      if (!isKnownProjectEntry(where, name)) out.push(`${where}/${name}`);
    }
  }
  return out.sort();
}

/**
 * The nearest project folder holding `start` (a model's folder): `start` or a parent with a
 * `.thirdwheel/` folder, up to the home folder or the drive root. `undefined` = none yet.
 */
export async function findProjectFolder(
  fs: ProjectFs,
  start: string,
  home: string,
  path: PathApi,
): Promise<string | undefined> {
  for (const folder of projectSearchFolders(start, home, path)) {
    if (await fs.isDirectory(path.join(folder, PROJECT_DIR))) return folder;
  }
  return undefined;
}

// --- writing -------------------------------------------------------------------------------------

/** `rename`, retried while Windows briefly holds the target. */
export async function renameWithRetry(fs: ProjectFs, from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      const wait = RENAME_RETRY_MS[attempt];
      if (wait === undefined || !RETRY_CODES.has(errorCode(e) ?? '')) throw e;
      await fs.sleep(wait);
    }
  }
}

async function writeTemp(fs: ProjectFs, file: string, text: string, random?: RandomBytes) {
  const tmp = `${file}.${newId(random)}.tmp`;
  try {
    await fs.writeText(tmp, text);
  } catch (e) {
    await fs.remove(tmp).catch(() => undefined);
    throw e;
  }
  return tmp;
}

/** Write one file atomically (temp + rename with retry). */
export async function writeAtomic(
  fs: ProjectFs,
  file: string,
  text: string,
  random?: RandomBytes,
): Promise<void> {
  const tmp = await writeTemp(fs, file, text, random);
  try {
    await renameWithRetry(fs, tmp, file);
  } catch (e) {
    await fs.remove(tmp).catch(() => undefined);
    throw e;
  }
}

export interface ProjectSave {
  readonly project?: Project;
  readonly marks?: readonly VersionMarks[];
}

/**
 * Save project files together. All are checked and written to temp files first; if one fails,
 * nothing is renamed (the old files stay as they were). Then marks files, then `project.json`.
 */
export async function saveProject(
  fs: ProjectFs,
  files: ProjectFiles,
  save: ProjectSave,
  random?: RandomBytes,
): Promise<void> {
  const jobs: { file: string; text: string }[] = [];
  const seen = new Set<string>();
  for (const m of save.marks ?? []) {
    const data = versionMarksSchema.parse(m);
    if (seen.has(data.versionId)) throw new Error(`marks of "${data.versionId}" given twice`);
    seen.add(data.versionId);
    jobs.push({ file: files.marks(data.versionId), text: formatJson(data) });
  }
  if (save.project)
    jobs.push({ file: files.project, text: formatJson(projectSchema.parse(save.project)) });
  if (jobs.length === 0) return;

  await fs.makeDir(files.dir);
  await ensureGitignore(fs, files);
  if (save.marks?.length) await fs.makeDir(files.marksDir);
  const temps: string[] = [];
  try {
    for (const j of jobs) temps.push(await writeTemp(fs, j.file, j.text, random));
  } catch (e) {
    await Promise.all(temps.map((t) => fs.remove(t).catch(() => undefined)));
    throw e;
  }
  for (let i = 0; i < jobs.length; i++) {
    const tmp = temps[i] as string;
    try {
      await renameWithRetry(fs, tmp, (jobs[i] as { file: string }).file);
    } catch (e) {
      // Files renamed so far are complete on their own (marks before the project that lists them).
      await Promise.all(temps.slice(i).map((t) => fs.remove(t).catch(() => undefined)));
      throw e;
    }
  }
}

/**
 * Write `.thirdwheel/.gitignore` (chats and the lock stay out of git) when it is missing — also in
 * projects made before it existed. One the user wrote or edited is never touched. A failure never
 * stops the save (the files that matter are written next).
 */
export async function ensureGitignore(fs: ProjectFs, files: ProjectFiles): Promise<void> {
  try {
    await fs.createExclusive(files.gitignore, PROJECT_GITIGNORE);
  } catch {
    // Not writable: the project save that follows reports it.
  }
}

/**
 * Append one chat entry. If the log ends in a half-written line (crash while appending), a line
 * break goes first, so the new entry is never glued onto the broken one.
 */
export async function appendChatEntry(
  fs: ProjectFs,
  files: ProjectFiles,
  chatId: string,
  entry: ChatEntry,
): Promise<void> {
  const line = chatLine(entry);
  const file = files.chat(chatId);
  await fs.makeDir(files.chatsDir);
  const size = await fs.size(file);
  const tail = size ? await fs.readTail(file, 1) : '';
  await fs.appendText(file, tail === '' || tail === '\n' ? line : `\n${line}`);
}

/**
 * Backup name next to `file` that doesn't exist yet: `project.json` at 2026-11-21 14:05:09 →
 * `project.2026-11-21-140509.bak.json`, then `….bak-2.json`, … (local time, as v1).
 */
export async function backupPath(
  fs: ProjectFs,
  file: string,
  at: Date,
  path: PathApi,
): Promise<string> {
  const p = (n: number): string => String(n).padStart(2, '0');
  const stamp = `${String(at.getFullYear())}-${p(at.getMonth() + 1)}-${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  const base = path.basename(file).replace(/\.jsonl?$/, '');
  const ext = file.endsWith('.jsonl') ? 'jsonl' : 'json';
  const dir = path.dirname(file);
  for (let n = 1; ; n++) {
    const name = `${base}.${stamp}.bak${n === 1 ? '' : `-${String(n)}`}.${ext}`;
    const candidate = path.join(dir, name);
    if ((await fs.size(candidate)) === undefined) return candidate;
  }
}

/** Move an unreadable file aside (rename to a backup); returns the backup's path. */
export async function moveAside(
  fs: ProjectFs,
  file: string,
  at: Date,
  path: PathApi,
): Promise<string> {
  const to = await backupPath(fs, file, at, path);
  await renameWithRetry(fs, file, to);
  return to;
}

/** Copy a file to a backup before a save loses data (v1 rule); returns the backup's path. */
export async function copyAside(
  fs: ProjectFs,
  file: string,
  at: Date,
  path: PathApi,
): Promise<string> {
  const to = await backupPath(fs, file, at, path);
  await writeAtomic(fs, to, await fs.readText(file));
  return to;
}

// --- lock ----------------------------------------------------------------------------------------

export type LockResult =
  | { readonly kind: 'acquired'; readonly tookOver?: 'stale' | 'broken' | 'forced' }
  | Exclude<LockState, { kind: 'free' } | { kind: 'stale' }>;

/**
 * Take the project's lock: created only if it isn't there (two windows starting at once can't
 * both win); a stale lock (this computer, process gone) or a broken one is taken over and read back
 * to check no one else took it in between (two windows taking over in the same few milliseconds
 * can still both win; accepted). `force` takes over a lock held elsewhere (the user chose "take
 * over"). One lock per process: windows of one app share the pid, so the app guards those itself.
 */
export async function acquireLock(
  fs: ProjectFs,
  files: ProjectFiles,
  self: LockSelf,
  now: Date,
  force = false,
): Promise<LockResult> {
  const text = lockText({ host: self.host, pid: self.pid, started: now.toISOString() });
  await fs.makeDir(files.dir);
  if (await fs.createExclusive(files.lock, text)) return { kind: 'acquired' };
  const current = await fs.readText(files.lock).catch(() => '');
  const state = lockState(parseLock(current), self);
  let tookOver: 'stale' | 'broken' | 'forced';
  if (state.kind === 'mine') return { kind: 'acquired' };
  if (state.kind === 'free') tookOver = 'broken';
  else if (state.kind === 'stale') tookOver = 'stale';
  // `force`: the user chose "take over" — another computer's lock, or one whose process id now
  // belongs to another program (pid reused after a reboot).
  else if (force) tookOver = 'forced';
  else return state;
  await writeAtomic(fs, files.lock, text);
  const back = parseLock(await fs.readText(files.lock).catch(() => ''));
  if (!back || back.pid !== self.pid || lockState(back, self).kind !== 'mine') {
    const s = lockState(back, self);
    return s.kind === 'free' || s.kind === 'stale' || s.kind === 'mine'
      ? { kind: 'busy', lock: back ?? { host: '?', pid: 1, started: now.toISOString() } }
      : s;
  }
  return { kind: 'acquired', tookOver };
}

/** Remove the lock if this process holds it (never someone else's). */
export async function releaseLock(
  fs: ProjectFs,
  files: ProjectFiles,
  self: LockSelf,
): Promise<void> {
  const text = await fs.readText(files.lock).catch(() => undefined);
  if (text === undefined) return;
  if (lockState(parseLock(text), self).kind === 'mine') await fs.remove(files.lock);
}
