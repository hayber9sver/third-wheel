/**
 * Paths and ids of a project folder, for macOS and Windows. Core has no Node
 * imports: callers pass Node's `path` (tests pass `path.win32` / `path.posix` to check both).
 */
import { MAX_VERSION_PATH } from './schema.js';
import {
  CHATS_DIR,
  GITIGNORE_FILE,
  LOCK_FILE,
  MARKS_DIR,
  PROJECT_DIR,
  PROJECT_FILE,
  isFileId,
} from './project-schema.js';

/** The part of Node's `path` module used here (`path`, `path.win32` or `path.posix`). */
export interface PathApi {
  readonly sep: string;
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
  relative(from: string, to: string): string;
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  isAbsolute(p: string): boolean;
  parse(p: string): { root: string };
}

// --- ids -----------------------------------------------------------------------------------------

/** Length of new ids: 10 base-36 characters ≈ 52 bits, no collision in practice. */
export const NEW_ID_LENGTH = 10;

/** Random bytes, from the caller (tests) or the platform's `crypto.getRandomValues`. */
export type RandomBytes = (n: number) => Uint8Array;

const platformRandom: RandomBytes = (n) => {
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint8Array): Uint8Array } }).crypto;
  if (!c) throw new Error('no crypto.getRandomValues on this platform');
  return c.getRandomValues(new Uint8Array(n));
};

/**
 * A new random id (markers, comments, parts, versions, chats): lower-case `a-z0-9`, safe as a file
 * name everywhere. Random, not a counter: two people adding at once never make the same id.
 * Starts with a letter, so it never reads as a number and is never a Windows device name.
 */
export function newId(random: RandomBytes = platformRandom): string {
  for (;;) {
    const bytes = random(NEW_ID_LENGTH);
    let s = '';
    bytes.forEach((b, i) => {
      // First character a–z, the rest a–z / 0–9 (bias of 256 % 36 is harmless for ids).
      s += i === 0 ? String.fromCharCode(97 + (b % 26)) : (b % 36).toString(36);
    });
    if (isFileId(s)) return s;
  }
}

/** A new id not in `taken` (and added to it). */
export function newUniqueId(taken: Set<string>, random?: RandomBytes): string {
  for (;;) {
    const id = newId(random);
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

// --- files of a project ------------------------------------------------------------------------

/**
 * Longest `.thirdwheel` folder path accepted (characters). Its deepest file
 * (`marks/<32>.json.<10>.tmp`) then stays below Windows' 260-character `MAX_PATH`.
 */
export const MAX_PROJECT_DIR_PATH = 200;

export interface ProjectFiles {
  readonly folder: string;
  readonly dir: string;
  readonly project: string;
  readonly lock: string;
  /** `.thirdwheel/.gitignore` (written when missing, never overwritten). */
  readonly gitignore: string;
  readonly marksDir: string;
  readonly chatsDir: string;
  marks(versionId: string): string;
  chat(chatId: string): string;
}

export class ProjectPathError extends Error {
  constructor(
    message: string,
    readonly code: 'too-long' | 'network' | 'bad-id',
  ) {
    super(message);
  }
}

/** Whether `p` is a network path (`\\host\share\…` or `//host/share/…`), refused as in v1. */
export function isNetworkPath(p: string): boolean {
  return /^(\\\\|\/\/)[^\\/]/.test(p);
}

/** The project files of a folder. Throws `ProjectPathError` for a network or too-long folder. */
export function projectFiles(folder: string, path: PathApi): ProjectFiles {
  if (isNetworkPath(folder)) {
    throw new ProjectPathError('Projects on network paths are not supported.', 'network');
  }
  const dir = path.join(folder, PROJECT_DIR);
  if (dir.length > MAX_PROJECT_DIR_PATH) {
    throw new ProjectPathError(
      `This folder's path is too long for a project (${String(dir.length)} characters, at most ${String(MAX_PROJECT_DIR_PATH)}). Move the files to a shorter path.`,
      'too-long',
    );
  }
  const checked = (id: string): string => {
    if (!isFileId(id)) throw new ProjectPathError(`not a valid id: "${id}"`, 'bad-id');
    return id;
  };
  const marksDir = path.join(dir, MARKS_DIR);
  const chatsDir = path.join(dir, CHATS_DIR);
  return {
    folder,
    dir,
    project: path.join(dir, PROJECT_FILE),
    lock: path.join(dir, LOCK_FILE),
    gitignore: path.join(dir, GITIGNORE_FILE),
    marksDir,
    chatsDir,
    marks: (v) => path.join(marksDir, `${checked(v)}.json`),
    chat: (c) => path.join(chatsDir, `${checked(c)}.jsonl`),
  };
}

// --- version paths -----------------------------------------------------------------------------

export interface StoredPath {
  readonly path: string;
  readonly outside?: true;
}

/**
 * How a model file is stored in `project.json`: relative to the project folder with `/`
 * (`exports/part.step`, `../out/part.step`); absolute with `outside: true` when there is no
 * relative path (another drive on Windows: `path.win32.relative('C:\\a', 'D:\\b')` is `D:\\b`).
 */
export function toStoredPath(folder: string, file: string, path: PathApi): StoredPath {
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(folder), abs);
  if (rel === '' || path.isAbsolute(rel) || isNetworkPath(rel) || rel.length > MAX_VERSION_PATH) {
    return { path: abs, outside: true };
  }
  return { path: rel.split(path.sep).join('/') };
}

/** The file a stored version path points to, on this system. */
export function resolveStoredPath(folder: string, stored: StoredPath, path: PathApi): string {
  if (stored.outside) return stored.path;
  return path.resolve(folder, ...stored.path.split('/'));
}

// --- upward project search ---------------------------------------------------------------------

/**
 * Folders to look in for `.thirdwheel/`, nearest first: `start`, then each parent, up to and
 * including the home folder when `start` is inside it, else up to the drive / file-system root
 * (`C:\`, `/`). Network paths give none (refused as in v1).
 */
export function projectSearchFolders(start: string, home: string, path: PathApi): string[] {
  if (isNetworkPath(start)) return [];
  const from = path.resolve(start);
  const homeAbs = path.resolve(home);
  const rel = path.relative(homeAbs, from);
  const insideHome =
    rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  const out: string[] = [];
  for (let at = from; ;) {
    out.push(at);
    // `relative` compares as the OS does (Windows: without case).
    if (insideHome && path.relative(at, homeAbs) === '') break;
    const up = path.dirname(at);
    if (up === at) break; // root
    at = up;
  }
  return out;
}

/** Names allowed in `.thirdwheel/` and its sub-folders; anything else is reported (sync conflict copies). */
export function isKnownProjectEntry(where: 'dir' | 'marks' | 'chats', name: string): boolean {
  if (isOurTemp(name)) return true;
  if (where === 'dir')
    return [PROJECT_FILE, MARKS_DIR, CHATS_DIR, LOCK_FILE, GITIGNORE_FILE].includes(name);
  const ext = where === 'marks' ? '.json' : '.jsonl';
  return name.endsWith(ext) && isFileId(name.slice(0, -ext.length));
}

/** Temp files of an atomic save (`<file>.<id>.tmp`) and backups (`….bak.json`). */
export function isOurTemp(name: string): boolean {
  return /\.[0-9a-z]{1,32}\.tmp$/.test(name) || /\.bak(-\d+)?\.jsonl?$/.test(name);
}
