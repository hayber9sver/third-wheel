/**
 * `.thirdwheel/lock`: which app window has a project open, so a second window or
 * another computer (a shared OneDrive / Dropbox folder) doesn't overwrite it. Pure logic; the
 * store writes the file with an exclusive create.
 */
import { z } from 'zod';
import { parseJsonText } from './project-schema.js';

export const lockSchema = z.looseObject({
  host: z.string().min(1).max(255),
  pid: z.number().int().positive(),
  started: z.iso.datetime({ offset: true }),
});
export type ProjectLock = z.infer<typeof lockSchema>;

export function lockText(lock: ProjectLock): string {
  return `${JSON.stringify(lockSchema.parse(lock), null, 2)}\n`;
}

/** The lock file's text; `undefined` when it is not a valid lock (half-written, edited). */
export function parseLock(text: string): ProjectLock | undefined {
  const j = parseJsonText(text);
  if (!j.ok) return undefined;
  const r = lockSchema.safeParse(j.value);
  return r.success ? r.data : undefined;
}

export interface LockSelf {
  readonly host: string;
  readonly pid: number;
  /** Whether a process with this id runs on this computer. */
  isAlive(pid: number): boolean;
}

/**
 * - `free`: no lock (or not readable as one: a crash while writing it) → take it.
 * - `mine`: this process holds it.
 * - `stale`: this computer, but that process is gone → take it over.
 * - `busy`: another running app on this computer → open read-only.
 * - `other-host`: another computer; can't check → warn "open on <host> since …", the user
 *   chooses read-only or take over.
 */
export type LockState =
  | { readonly kind: 'free' }
  | { readonly kind: 'mine' }
  | { readonly kind: 'stale'; readonly lock: ProjectLock }
  | { readonly kind: 'busy'; readonly lock: ProjectLock }
  | { readonly kind: 'other-host'; readonly lock: ProjectLock };

/** Host names compare without case (Windows names are upper case, macOS ones `….local`). */
function sameHost(a: string, b: string): boolean {
  const norm = (h: string): string =>
    h
      .trim()
      .toLowerCase()
      .replace(/\.local$/, '');
  return norm(a) === norm(b);
}

export function lockState(lock: ProjectLock | undefined, self: LockSelf): LockState {
  if (!lock) return { kind: 'free' };
  if (!sameHost(lock.host, self.host)) return { kind: 'other-host', lock };
  if (lock.pid === self.pid) return { kind: 'mine' };
  return self.isAlive(lock.pid) ? { kind: 'busy', lock } : { kind: 'stale', lock };
}
