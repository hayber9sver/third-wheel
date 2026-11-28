/**
 * Parts menu (toolbar, between Add file and Versions): the project's parts; a row opens the
 * part at its newest version. Adding a part is Add file → Separate part.
 */
import type { ProjectPartRow } from '../../../shared/ipc.js';
import { partDetail, partRows, partTitle, type PartMenuRow } from '../part-list.js';
import type { MenuEntry } from '../context-menu.js';
import {
  autosave,
  byId,
  contextMenu,
  count,
  openDropdown,
  openVersion,
  shownFile,
  shownProject,
} from '../main.js';

const partsButton = byId('parts-menu') as HTMLButtonElement;
/** Most part rows in the menu; the shown part always stays listed. */
const MAX_PART_ROWS = 30;

/** The shown project's parts, each with its newest file checked on disk. */
async function projectParts(): Promise<readonly ProjectPartRow[]> {
  const api = window.thirdWheel;
  if (!api) return [];
  const shown = shownFile;
  try {
    // The window's latest comments first, so the open counts are current.
    await autosave.flush();
    return await api.projectParts(
      shown ? { path: shown.path, contentHash: shown.contentHash } : undefined,
    );
  } catch (err) {
    console.warn('Could not read the parts of the project', err);
    return [];
  }
}

function partEntry(row: PartMenuRow): MenuEntry {
  const base = {
    label: row.name,
    detail: partDetail(row, (n) => count.format(n)),
    title: partTitle(row),
    action: 'part-row',
  };
  switch (row.state) {
    case 'shown':
      return { ...base, checked: true, disabled: true };
    case 'missing':
      return { ...base, disabled: true };
    case 'shownOlder':
      return {
        ...base,
        checked: true,
        onSelect: () => void openVersion({ path: row.path, name: row.fileName }),
      };
    case 'found':
    case 'changed':
      return {
        ...base,
        onSelect: () => void openVersion({ path: row.path, name: row.fileName }),
      };
  }
}

async function partEntries(): Promise<MenuEntry[]> {
  const shown = shownFile;
  const rows = partRows(await projectParts(), shown ?? undefined);
  const entries: MenuEntry[] = [];
  entries.push({
    label: !shownProject
      ? 'No project open'
      : rows.length > 0
        ? `Parts of ${shownProject.name}`
        : 'No parts yet',
    disabled: true,
  });
  const shownAt = Math.max(
    0,
    rows.findIndex((r) => r.state === 'shown' || r.state === 'shownOlder'),
  );
  const listed = rows.filter((_r, i) => Math.abs(i - shownAt) < MAX_PART_ROWS / 2);
  for (const row of listed) entries.push(partEntry(row));
  if (rows.length > listed.length)
    entries.push({ label: `… ${count.format(rows.length - listed.length)} more`, disabled: true });
  entries.push('separator', {
    label: 'Add a part with Add file',
    title: 'Add file → Separate part lists a file as a part of this project.',
    disabled: true,
  });
  return entries;
}

partsButton.addEventListener('click', () => {
  if (contextMenu.justClosedBy(partsButton)) return;
  const shown = shownFile;
  void partEntries().then((entries) => {
    if (shownFile === shown) openDropdown(partsButton, entries);
  });
});
