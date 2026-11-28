/**
 * Undo / redo of markers, paint and comments; the comments panel; paint strokes from the view.
 */
import { UndoHistory } from '../undo.js';
import {
  COMMENT_EDIT_LABELS,
  nextCommentMarkerName,
  resolvedMarkerIds,
  type Comment,
} from '../comments.js';
import { CommentsPanel } from '../comments-panel.js';
import { dictationLabel, undoRedoLabels, undoRedoShortcut } from '../../../shared/shortcuts.js';
import type { SelectionItem } from '../selection.js';
import { PaintRecord } from '../paint.js';
import { placeGhost } from '@third-wheel/geometry';
import { fromRuns } from '@third-wheel/core';
import { merge as mergePieces } from '../sidecar.js';
import { ShortcutOnce } from '../../../shared/menu-commands.js';
import {
  applyCommentFocus,
  applyDimensions,
  applyBareMarkers,
  applyMarkers,
  applyResolvedMarkers,
  autosave,
  byId,
  chatAgent,
  comments,
  COMMENTS_SHOW_CLOSED_KEY,
  commentTargets,
  currentTool,
  eraseLocks,
  isMac,
  isTextField,
  loadSetting,
  lockedMarkers,
  markers,
  openDropdown,
  otherSessionModels,
  shownFile,
  paint,
  postThreadReply,
  queuePins,
  renderSendToAi,
  reopenModel,
  saveSetting,
  selection,
  sent,
  showActiveIfHidden,
  resolvedActiveMarker,
  resolvedMarkerNotice,
  shownModel,
  showNotice,
  viewport,
} from '../main.js';

// --- Undo / redo ------------------------------------------------------
// One paint stroke = one step; marker add / delete / rename / recolour = one step each.
// Selection and hiding are not undoable (CAD convention / view state).
export const history = new UndoHistory();
comments.onEdit = (edit) => {
  // The user's reply under a comment goes to the chat agent (after the change is in place).
  // Marked sent now, so a Send review in the same click (it posts the reply box first) doesn't
  // send it twice.
  if (edit.kind === 'reply' && edit.by === 'human' && chatAgent()) {
    const c = comments.get(edit.id);
    if (c) sent.mark(c);
    queueMicrotask(() => {
      postThreadReply(edit.id);
    });
  }
  // Undo is the user's own steps; the AI's replies / status changes are never undone, and
  // undoing a user step keeps whatever the AI changed since (`apply`, not `restore`).
  if (edit.by === 'ai') return;
  const step = {
    label: COMMENT_EDIT_LABELS[edit.kind],
    undo: () => {
      comments.apply(edit.after, edit.before);
    },
    redo: () => {
      comments.apply(edit.before, edit.after);
    },
  };
  // Your Resolve / Won't fix / Confirm that closes the last open comment on a marker settles
  // it: ⚠ Changed ("Looks right") and ✕ Lost ("Dismiss") go, in the same undo step.
  // "? Check" stays for you to place or drop.
  const settle =
    edit.kind === 'status' || edit.kind === 'confirm'
      ? markersToSettle(edit.before.items, edit.after.items)
      : [];
  if (settle.length === 0) {
    history.push(step);
    return;
  }
  history.group(step.label, () => {
    history.push(step);
    for (const id of settle) markers.confirmTransfer(id);
  });
};
/** Markers newly resolved by a comment change whose transfer flag a resolve clears. */
function markersToSettle(before: readonly Comment[], after: readonly Comment[]): string[] {
  const was = resolvedMarkerIds(before);
  return [...resolvedMarkerIds(after)].filter((id) => {
    const status = markers.get(id)?.transfer?.status;
    return !was.has(id) && (status === 'changed' || status === 'lost');
  });
}
export const commentsPanel = new CommentsPanel(
  byId('comments'),
  comments,
  markers,
  {
    dropdown: (anchor, entries) => {
      openDropdown(anchor, entries);
    },
    focus: (id) => {
      const t = commentTargets(id);
      viewport.setCommentFocus(t.items, t.markerIds);
      queuePins();
      applyDimensions(id);
    },
    zoom: (id) => {
      const t = commentTargets(id);
      viewport.frameFocus(t.items, paint?.trianglesOf(t.markerIds) ?? []);
    },
    postOnSelection: (text, markerIds, linkedModels) => {
      const items = pendingCommentSelection;
      pendingCommentSelection = [];
      if (items.length === 0) return;
      history.group('Comment on selection', () => {
        const marker = markers.add(items, nextCommentMarkerName(markers.names()));
        comments.add(text, [marker.id, ...markerIds], 'human', linkedModels);
      });
      selection.clear(); // used up (Cancel keeps it), as in addSelectionTo
    },
    linkParts: async () => {
      const api = window.thirdWheel;
      const shown = shownFile;
      if (!api || !shown) return [];
      const rows = await api.projectParts({ path: shown.path, contentHash: shown.contentHash });
      return rows.filter((r) => !r.shown).map((r) => ({ name: r.name, fileName: r.fileName }));
    },
    canOpenModel: (name) => otherSessionModels().some((m) => m.name === name),
    openModel: (name) => {
      const m = otherSessionModels().find((o) => o.name === name);
      if (m) void reopenModel(m.path);
    },
    showClosedChanged: (show) => {
      saveSetting(COMMENTS_SHOW_CLOSED_KEY, show ? '1' : '0');
      applyResolvedMarkers(true); // resolved markers shown faded / hidden again
      queuePins();
    },
    postKeyLabel: isMac ? '⌘ Enter' : 'Ctrl+Enter',
    dictationLabel: dictationLabel(isMac),
  },
  loadSetting(COMMENTS_SHOW_CLOSED_KEY, (v): v is string => v === '1' || v === '0', '0') === '1',
);
comments.onChange = () => {
  // A marker whose comments all closed (or one reopened) changes look; that redraw also
  // renders the panel and the focus.
  if (!applyResolvedMarkers()) {
    commentsPanel.render();
    applyCommentFocus();
    applyBareMarkers(); // a marker's last comment deleted: no longer listed for a comment
  }
  autosave.changed();
  renderSendToAi();
};
/** Selection when "Comment on selection" opened the writing box (the marker is made on post). */
export let pendingCommentSelection: SelectionItem[] = [];
/** Sets `pendingCommentSelection` from another module (an import can't be assigned). */
export function setPendingCommentSelection(value: typeof pendingCommentSelection): void {
  pendingCommentSelection = value;
}
export function commentOnSelection(): void {
  const items = selection.list();
  if (items.length === 0) return;
  pendingCommentSelection = [...items];
  const section = byId('comments');
  if (section.classList.contains('collapsed')) section.querySelector<HTMLElement>('h2')?.click();
  commentsPanel.openOnSelection(nextCommentMarkerName(markers.names()), items.length);
}
commentsPanel.hooksSelection = commentOnSelection;
applyMarkers();
/** Changes of the stroke in progress; becomes one undo step when it ends. */
export let strokeRecord: { record: PaintRecord; label: string } | undefined;
/** Sets `strokeRecord` from another module (an import can't be assigned). */
export function setStrokeRecord(value: typeof strokeRecord): void {
  strokeRecord = value;
}

const MARKER_EDIT_LABELS = {
  add: 'Add marker',
  remove: 'Delete marker',
  rename: 'Rename marker',
  color: 'Marker colour',
  'add-entities': 'Add to marker',
  'remove-entities': 'Remove from marker',
  confirm: 'Marker looks right',
  place: 'Place marker here',
} as const;
/** Paint set by "✓ Place here" just before its marker edit: undone / redone with it. */
let placedPaint: PaintRecord | undefined;
/**
 * "✓ Place here" on a "? Check" marker: its ghost — the dots at the
 * mirrored place — becomes paint and held items there; one undo step.
 */
export function placeMarkerGhost(id: string): void {
  const marker = markers.get(id);
  const ghost = marker?.transfer?.ghost;
  const model = shownModel;
  const layer = paint;
  if (!marker || !model || !layer) return;
  if (!ghost) {
    markers.confirmTransfer(id);
    return;
  }
  const placed = placeGhost(ghost, model);
  const rec = new PaintRecord();
  for (const f of placed.paint) {
    for (const t of fromRuns(f.triangles))
      if (model.triangleFace[t] === f.faceId) rec.note(t, layer.stateAt(t), id);
    for (const p of f.pieces ?? []) {
      const was = layer.stateAt(p.triangle);
      rec.note(p.triangle, was, mergePieces(was, p.tree, id));
    }
  }
  rec.seal();
  layer.restore(rec, 'after');
  viewport.paintChanged();
  placedPaint = rec;
  try {
    markers.placeTransfer(id, placed.entities, placed.ghost);
  } finally {
    placedPaint = undefined;
  }
  if (placed.ghost)
    showNotice(
      `Part of ${marker.name} couldn't be placed: it is still shown as dots (✕ Lost). Paint it again or dismiss it.`,
    );
}
markers.onEdit = (edit) => {
  const layer = paint;
  // A deleted marker loses its paint (applyMarkers runs right after this): keep it for undo.
  const lost = edit.kind === 'remove' ? layer?.recordMarker(edit.id).seal() : undefined;
  const placed = edit.kind === 'place' ? placedPaint : undefined;
  const takeActive = edit.kind === 'add' || edit.kind === 'remove';
  history.push(
    {
      label:
        edit.kind === 'add' && markers.get(edit.id)?.entities.length
          ? 'New marker from selection'
          : MARKER_EDIT_LABELS[edit.kind],
      undo: () => {
        markers.restore(edit.before, takeActive);
        if (lost && layer && lost.size > 0) {
          layer.restore(lost, 'before');
          viewport.paintChanged();
        }
        if (placed && layer) {
          layer.restore(placed, 'before');
          viewport.paintChanged();
        }
        applyBareMarkers(); // the list was drawn before the paint came back
      },
      redo: () => {
        markers.restore(edit.after, takeActive);
        if (placed && layer) {
          layer.restore(placed, 'after');
          viewport.paintChanged();
        }
        applyBareMarkers();
      },
    },
    // The system colour picker sends a change per drag step: those become one undo step.
    edit.live ? { mergeKey: `color:${edit.id}` } : {},
  );
};

/** One key press that reaches both the page and the app menu runs once. */
export const shortcutOnce = new ShortcutOnce();

export function undoRedo(which: 'undo' | 'redo'): void {
  if (strokeRecord) return; // finish the stroke first
  if (which === 'undo') history.undo();
  else history.redo();
}

const undoButton = byId('undo') as HTMLButtonElement;
const redoButton = byId('redo') as HTMLButtonElement;
const undoKeys = undoRedoLabels(isMac);
function renderUndoButtons(): void {
  const u = history.undoLabel();
  const r = history.redoLabel();
  undoButton.disabled = u === undefined;
  redoButton.disabled = r === undefined;
  undoButton.title = u ? `Undo ${u} (${undoKeys.undo})` : `Nothing to undo (${undoKeys.undo})`;
  redoButton.title = r ? `Redo ${r} (${undoKeys.redo})` : `Nothing to redo (${undoKeys.redo})`;
}
history.onChange = () => {
  renderUndoButtons();
  queuePins(); // a paint stroke / undo moves the paint pins sit on
  autosave.changed(); // paint strokes and undo / redo (marker and comment edits also land here)
};
renderUndoButtons();
undoButton.addEventListener('click', () => {
  undoRedo('undo');
});
redoButton.addEventListener('click', () => {
  undoRedo('redo');
});
window.addEventListener('keydown', (e) => {
  const which = undoRedoShortcut(e, isMac);
  // In a text field (renaming a marker) the keys undo typing, as everywhere.
  if (!which || isTextField(e.target)) return;
  e.preventDefault();
  if (shortcutOnce.take(which, 'key', performance.now())) undoRedo(which);
});

const STROKE_LABELS = { brush: 'Brush stroke', erase: 'Erase', fill: 'Smart fill' } as const;
/** The stroke in progress uses a resolved marker: it does nothing (notice shown once). */
let strokeOnResolved = false;
viewport.onStrokeStart = (erase) => {
  const resolved = resolvedActiveMarker();
  strokeOnResolved = resolved !== undefined;
  if (resolved) {
    showNotice(resolvedMarkerNotice(resolved.name));
    return;
  }
  if (!erase) showActiveIfHidden();
  const kind = currentTool === 'smart-fill' ? 'fill' : erase ? 'erase' : 'brush';
  strokeRecord = { record: new PaintRecord(), label: STROKE_LABELS[kind] };
};
viewport.onStroke = (triangles, erase, spheres) => {
  if (!paint || strokeOnResolved) return;
  const active = markers.active();
  const record = strokeRecord?.record;
  const changed = erase
    ? active
      ? paint.erase(triangles, eraseLocks(active.id), record, spheres)
      : 0
    : active
      ? paint.paint(triangles, active.id, lockedMarkers(), record, spheres)
      : 0; // no marker → Brush / erase do nothing
  if (changed > 0) viewport.paintChanged();
};
viewport.onStrokeEnd = () => {
  const done = strokeRecord;
  strokeRecord = undefined;
  const layer = paint;
  if (!done || !layer || done.record.size === 0) return;
  // A committed paint action ends the selection (switching tools alone keeps it, so a wrong
  // tool pick costs nothing). Selection isn't undoable, so undo doesn't bring it back.
  selection.clear();
  const record = done.record.seal();
  history.push({
    label: done.label,
    undo: () => {
      layer.restore(record, 'before');
      viewport.paintChanged();
      applyBareMarkers();
    },
    redo: () => {
      layer.restore(record, 'after');
      viewport.paintChanged();
      applyBareMarkers();
    },
  });
  applyBareMarkers();
};
