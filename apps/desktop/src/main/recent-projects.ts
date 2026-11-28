/**
 * File ▸ Open Recent: the projects shown last (folder, name, the model shown there last), newest
 * first, kept in the app's settings folder. Pure list logic + a tolerant parser (a broken file
 * gives an empty list).
 */

export interface RecentProject {
  /** The project folder (holds `.thirdwheel/`, or will on the first change). */
  readonly folder: string;
  readonly name: string;
  /** The model shown last in it (opened again from the menu); '' = none yet. */
  readonly model: string;
  /** When it was last opened (ISO; the start page shows it). */
  readonly opened?: string;
}

export const MAX_RECENT = 10;

/** `entry` first; the same folder appears once. */
export function addRecent(
  list: readonly RecentProject[],
  entry: RecentProject,
  max = MAX_RECENT,
): RecentProject[] {
  return [entry, ...list.filter((r) => r.folder !== entry.folder)].slice(0, max);
}

export function parseRecent(text: string): RecentProject[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: RecentProject[] = [];
  for (const r of data as unknown[]) {
    if (typeof r !== 'object' || r === null) continue;
    const { folder, name, model, opened } = r as Record<string, unknown>;
    if (typeof folder !== 'string' || typeof name !== 'string' || typeof model !== 'string')
      continue;
    if (out.some((o) => o.folder === folder)) continue;
    out.push({ folder, name, model, ...(typeof opened === 'string' ? { opened } : {}) });
  }
  return out.slice(0, MAX_RECENT);
}

/** The folder as shown: `~/…` under the home folder. */
export function folderLabel(folder: string, home: string): string {
  if (!home) return folder;
  const rest = folder.slice(home.length);
  return folder.startsWith(home) && (rest === '' || rest.startsWith('/') || rest.startsWith('\\'))
    ? `~${rest}`
    : folder;
}

/** Menu label: "name — folder" (the folder tells two projects of the same name apart). */
export function recentLabel(r: RecentProject, home: string): string {
  return `${r.name} — ${folderLabel(r.folder, home)}`;
}
