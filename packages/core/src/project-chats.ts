/**
 * The project's chats index (`project.json` `chats[]`) and what a chat line points to. Pure: the
 * app appends the lines (`chats/<id>.jsonl`, `project-store.ts`), this keeps the index in step.
 * The last chat in the index is the current one (New chat appends); older ones are read-only.
 */
import type { PathApi } from './project-paths.js';
import type { ChatInfo, Project, ProjectVersion } from './project-schema.js';
import { partVersions, versionFile } from './project-notes.js';

/** Longest chat title (first message, one line). */
export const MAX_CHAT_TITLE = 80;

/** A chat's title: the first line of its first message, cut to {@link MAX_CHAT_TITLE}. */
export function chatTitle(text: string): string {
  const line = (text.split(/\r?\n/).find((l) => l.trim() !== '') ?? '').trim().replace(/\s+/g, ' ');
  return line.length > MAX_CHAT_TITLE ? `${line.slice(0, MAX_CHAT_TITLE - 1)}…` : line;
}

/**
 * The index after lines were appended to chat `id`: a new chat is added at the end (it becomes the
 * current one) with `title`; a known one gets its new `last` time and line count.
 */
export function withChatLines(
  project: Project,
  id: string,
  lines: {
    readonly count: number;
    readonly at: string;
    readonly title: string;
    /** The agent stored a summary of this chat (`post_chat_summary`). */
    readonly summary?: string;
  },
): Project {
  const summary = lines.summary === undefined ? {} : { summary: lines.summary };
  const known = project.chats.find((c) => c.id === id);
  if (!known) {
    const info: ChatInfo = {
      id,
      title: lines.title || 'Chat',
      created: lines.at,
      last: lines.at,
      entries: lines.count,
      ...summary,
    };
    return { ...project, chats: [...project.chats, info] };
  }
  return {
    ...project,
    chats: project.chats.map((c) =>
      c.id === id
        ? {
            ...c,
            last: lines.at,
            entries: c.entries + lines.count,
            ...(c.title ? {} : { title: lines.title }),
            ...summary,
          }
        : c,
    ),
  };
}

/** A part's newest version (as Versions ▾ orders them), or undefined when the part is gone. */
export function newestVersionOf(
  project: Project,
  folder: string,
  partId: string,
  path: PathApi,
): ProjectVersion | undefined {
  const part = project.models.find((m) => m.id === partId);
  const any = part?.versions[0];
  if (!part || !any) return undefined;
  const list = partVersions(project, folder, versionFile(folder, any, path), any.contentHash, path);
  const id = list?.rows[0]?.id;
  return part.versions.find((v) => v.id === id) ?? any;
}
