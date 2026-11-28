/**
 * Cheat sheet content: six groups for one navigation style.
 * Pure data so it can be tested; `wiring/view.ts` renders it into the "?" panel.
 */
import { dictationLabel, shortcutLabel, undoRedoLabels } from '../../shared/shortcuts.js';
import { FIT_KEY, PRESET_VIEWS } from './camera-views.js';
import { leftDragNavigates, type NavigationStyle, type NavigationStyleId } from './navigation.js';
import { BRUSH_LARGER_KEY, BRUSH_SMALLER_KEY, TOOLS, type ToolDef } from './tools.js';

export interface HelpRow {
  /** What to press/do, e.g. "Middle-drag". */
  readonly input: string;
  /** What it does, e.g. "Pan". */
  readonly action: string;
}

export interface HelpSection {
  readonly title: string;
  /** The few things most people need; always shown. */
  readonly rows: readonly HelpRow[];
  /** The rest, folded under "More". */
  readonly more: readonly HelpRow[];
}

/** Key that opens/closes the cheat sheet. */
export const HELP_KEY = '?';

const MOUSE_ROWS: Record<NavigationStyleId, readonly HelpRow[]> = {
  fusion: [
    { input: 'Shift + middle-drag', action: 'Orbit' },
    { input: 'Middle-drag', action: 'Pan' },
    { input: 'Wheel', action: 'Zoom to the cursor' },
  ],
  onshape: [
    { input: 'Right-drag', action: 'Orbit' },
    { input: 'Middle-drag or Ctrl + right-drag', action: 'Pan' },
    { input: 'Wheel', action: 'Zoom to the cursor' },
  ],
  slicer: [
    { input: 'Left-drag on the background', action: 'Orbit' },
    { input: 'Right- or middle-drag', action: 'Pan' },
    { input: 'Wheel', action: 'Zoom to the cursor' },
  ],
};

function trackpadRows(style: NavigationStyle): HelpRow[] {
  const other = style.trackpadSwipe === 'orbit' ? 'pan' : 'orbit';
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  return [
    { input: 'Trackpad: two-finger swipe', action: cap(style.trackpadSwipe) },
    { input: 'Trackpad: Shift + swipe', action: cap(other) },
    { input: 'Trackpad: pinch', action: 'Zoom' },
  ];
}

function viewSection(style: NavigationStyle): HelpSection {
  const views = PRESET_VIEWS.map((v) => `${v.key} ${v.label}`).join(', ');
  const more: HelpRow[] = [...trackpadRows(style)];
  if (style.id === 'slicer') more.push({ input: 'Alt + left-drag', action: 'Orbit (anywhere)' });
  more.push(
    { input: `0–${String(PRESET_VIEWS.length - 1)}`, action: `Views: ${views}` },
    { input: 'Body list: eye / ⌖', action: 'Hide or show a body / zoom to it' },
    {
      input: 'Body list: right-click or drag a row',
      action:
        'Move bodies into your own folders (only sorts the list); double-click or F2 renames a folder',
    },
  );
  return {
    title: `View (${style.label})`,
    rows: [
      ...MOUSE_ROWS[style.id],
      { input: FIT_KEY.toUpperCase(), action: 'Zoom to the selection (or everything)' },
    ],
    more,
  };
}

function selectSection(style: NavigationStyle): HelpSection {
  const slicerLike = leftDragNavigates(style);
  const drag = slicerLike ? 'Drag from the model, or Shift + drag' : 'Drag';
  // Slicer: Alt held at the press orbits, so Alt only switches to crossing once the box runs.
  const alt = slicerLike ? 'Press Alt once the box has started' : 'Hold Alt while boxing';
  const select = TOOLS.find((t) => t.cursor === 'pick');
  return {
    title: 'Select',
    rows: [
      { input: 'Click', action: 'Add / remove the entity' },
      { input: `${drag} left → right`, action: 'Box: add what is fully inside' },
      { input: `${drag} right → left`, action: 'Box: remove what is fully inside' },
      { input: 'Esc or double-click empty space', action: 'Clear the selection' },
      {
        input: 'Select 1 or 2 things',
        action:
          'Their size is drawn on the model; comment "make this 45 mm" and the AI gets the exact value',
      },
    ],
    more: [
      ...(select
        ? [{ input: `${select.shortcut} ${select.label}`, action: 'The Select tool' }]
        : []),
      {
        input: 'Double-click an edge',
        action: 'Add / remove the edges that continue it smoothly (a fillet’s outline)',
      },
      { input: 'Double-click a face', action: 'Add / remove the whole body' },
      { input: alt, action: 'Crossing: touching the box is enough' },
      {
        input: 'Right-click (no drag)',
        action:
          'Comment on the selection, add it to a marker / remove it (an unselected item is selected first)',
      },
    ],
  };
}

function cursorText(tool: ToolDef): string {
  if (tool.cursor === 'crosshair') return 'crosshair; the area it would fill is tinted';
  return 'circle on the surface = brush size (red dashed while Shift erases)';
}

/** Brush tools: what each one does and what its cursor looks like. */
function paintSection(style: NavigationStyle): HelpSection {
  const brushes = TOOLS.filter((t) => t.cursor !== 'pick');
  const more: HelpRow[] = brushes.map((t) => ({
    input: `${t.label} cursor`,
    action: cursorText(t),
  }));
  more.push(
    { input: 'Whole CAD face (toolbar)', action: 'Smart fill takes exactly the clicked CAD face' },
    { input: 'Hidden marker', action: 'Its paint is kept safe from painting and erasing' },
  );
  if (leftDragNavigates(style))
    more.push({ input: 'Left press on the model', action: 'Use the tool (background: orbit)' });
  return {
    title: 'Paint',
    rows: [
      ...brushes.map((t) => ({
        input: `${t.shortcut} ${t.label}`,
        action:
          t.cursor === 'crosshair'
            ? 'Click: fill up to edges sharper than the angle'
            : 'Drag on the model: paint with the active marker',
      })),
      { input: 'Shift + drag / click', action: "Erase the active marker's paint" },
      {
        input: `${BRUSH_SMALLER_KEY} / ${BRUSH_LARGER_KEY} or Alt + scroll`,
        action: 'Smaller / larger brush (Smart fill: angle)',
      },
    ],
    more,
  };
}

function notesSection(isMac: boolean): HelpSection {
  const { undo, redo } = undoRedoLabels(isMac);
  return {
    title: 'Markers and comments',
    rows: [
      { input: 'Click a marker row', action: 'Make it the active marker (Brush paints with it)' },
      { input: '+ Comment', action: 'Write a comment on the active marker or the selection' },
      { input: 'Click a comment', action: 'Highlight its markers (⌖ on the card zooms to them)' },
      {
        input: `${undo} / ${redo}`,
        action: 'Undo / redo paint, marker and comment changes (not selection)',
      },
    ],
    more: [
      { input: 'Double-click or F2 on a marker row', action: 'Rename the marker' },
      { input: 'Delete on a marker row', action: 'Delete the marker and its paint (undoable)' },
      { input: '+ Selection on the active row', action: 'Add the selected entities to the marker' },
      { input: 'Click marked geometry', action: 'Tint the comments about it' },
      {
        input: 'Resolve / Confirm the last open comment on a marker',
        action:
          'The marker is resolved: hidden, its ⚠ / ✕ flag cleared, no painting with it ("Show resolved" shows it faded; Reopen brings it back)',
      },
      {
        input: isMac ? '⌘ Enter / Esc' : 'Ctrl+Enter / Esc',
        action: 'In the comment box: post / cancel',
      },
      {
        input: dictationLabel(isMac),
        action: isMac
          ? 'Dictate a comment (macOS dictation: press Fn / 🌐 twice; turn it on in System Settings → Keyboard)'
          : 'Dictate a comment (Windows voice typing)',
      },
    ],
  };
}

function filesSection(isMac: boolean): HelpSection {
  return {
    title: 'Files and versions',
    rows: [
      {
        input: shortcutLabel('o', isMac),
        action: 'Open a folder: its project (STEP models; STL / 3MF: paint and comments only)',
      },
      {
        input: shortcutLabel('i', isMac),
        action: 'Add a file: a new version (your notes move over) or a separate part',
      },
      { input: 'Versions ▾', action: 'Compare with an earlier version, or open one' },
      {
        input: 'File ▸ Reload from disk',
        action: 'Read the shown file again after you saved over it',
      },
    ],
    more: [
      {
        input: shortcutLabel('s', isMac),
        action: 'Save notes now (they also save by themselves, next to the model)',
      },
    ],
  };
}

function aiSection(): HelpSection {
  return {
    title: 'AI',
    rows: [
      {
        input: 'Send review',
        action:
          "Send your new comments to the agent in the Agent tab, answer the AI's review request, or (no agent connected) copy a message to paste into your AI chat",
      },
      { input: 'AI status (bottom left)', action: 'Click: how to set up an AI agent' },
    ],
    more: [
      { input: 'Text still in the comment box', action: 'Send review posts it first' },
      {
        input: 'Reply under a comment',
        action: 'Goes to the listening agent at once; it answers in the thread',
      },
      { input: 'Waiting for you', action: 'The AI closed a comment: ✓ Confirm or Reopen it' },
    ],
  };
}

/** Six short groups: the few things most people need first, the rest under "More". */
export function cheatSheet(style: NavigationStyle, isMac: boolean): HelpSection[] {
  return [
    viewSection(style),
    selectSection(style),
    paintSection(style),
    notesSection(isMac),
    filesSection(isMac),
    aiSection(),
  ];
}
