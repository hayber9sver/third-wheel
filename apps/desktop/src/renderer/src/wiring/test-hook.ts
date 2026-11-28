/**
 * Test hook for the e2e tests (THIRD_WHEEL_TEST=1, dev builds only).
 */
import { PaintLayer } from '../paint.js';
import type { StepModel } from '@third-wheel/geometry';
import {
  alertBody,
  alertDialog,
  alertTitle,
  autosave,
  brushRadius,
  chatPanel,
  comments,
  commentsPanel,
  fillAngle,
  history,
  loadFinished,
  loadModel,
  markers,
  notice,
  noticeText,
  paint,
  previousVersion,
  renderContactSheet,
  renderRegion,
  revisionInfo,
  selection,
  shownFile,
  shownModel,
  shownPath,
  viewport,
} from '../main.js';

// --- Test hook (THIRD_WHEEL_TEST=1, dev builds only; see apps/desktop/e2e) --------
if (new URLSearchParams(location.search).get('test') === '1') {
  (window as Window & { __thirdWheelTest?: unknown }).__thirdWheelTest = {
    viewport,
    selection,
    markers,
    comments,
    commentsPanel,
    paint: (): PaintLayer | undefined => paint,
    renderRegion,
    renderContactSheet,
    history,
    brushRadius: (): number => brushRadius,
    fillAngle: (): number => fillAngle,
    model: (): StepModel | undefined => shownModel,
    /** The shown model's file path (the Open dialog starts in its folder). */
    shownPath: (): string | undefined => shownFile?.path,
    /** The shown model is drawn and its load finished (`model()` is set earlier). */
    loaded: (): boolean => loadFinished,
    /** The version the shown model replaced. */
    previousVersion: () =>
      previousVersion && {
        path: previousVersion.path,
        name: previousVersion.name,
        carried: previousVersion.carried,
        markers: previousVersion.doc?.markers.length,
        comments: previousVersion.doc?.comments.length,
        inMemory: previousVersion.model !== undefined,
      },
    revisionInfo: () => revisionInfo,
    /** Opens the shown file again (sidecar reload); `saveFirst` = save before reading it. */
    reopen: async (saveFirst = true): Promise<void> => {
      if (saveFirst) autosave.flushSync();
      const path = shownPath;
      const api = window.thirdWheel;
      if (path === undefined || !api) throw new Error('no model');
      await loadModel(await api.rereadModelFile(path));
    },
    /** Writes pending annotation changes now (like Cmd/Ctrl+S). */
    flush: (): Promise<void> => autosave.flush(),
    notice: (): string | undefined => (notice.hidden ? undefined : noticeText.textContent),
    /** Text of the open pop-up (title + messages), or undefined. */
    alert: (): string | undefined =>
      alertDialog.open ? `${alertTitle.textContent}: ${alertBody.textContent}` : undefined,
    /** Shortens the chat's permission hint delay (ms) so e2e needn't wait 30 s. */
    chatHintMs: (ms: number): void => {
      chatPanel.hintMs = ms;
    },
  };
}
