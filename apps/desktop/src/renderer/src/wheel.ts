/**
 * Tells mouse wheels from trackpad two-finger swipes. Browsers deliver both as `wheel` events
 * (a pinch arrives as `wheel` with `ctrlKey: true` on macOS and on Windows precision touchpads),
 * so we classify heuristically, per gesture "stream".
 */

export type WheelKind = 'mouse' | 'trackpad';

/** The fields of a DOM `WheelEvent` we look at (`wheelDeltaY` is legacy but present in Chromium). */
export interface WheelSample {
  readonly deltaX: number;
  readonly deltaY: number;
  readonly deltaMode: number;
  readonly shiftKey: boolean;
  readonly timeStamp: number;
  readonly wheelDeltaY?: number | undefined;
}

/** Evidence that a single event came from a trackpad (or other smooth-scrolling surface). */
export function looksLikeTrackpad(e: WheelSample, isMac: boolean): boolean {
  if (e.deltaMode !== 0) return false; // line/page deltas = notched wheel
  // Two-axis motion; Shift+wheel on a mouse is turned into horizontal scroll, so ignore that.
  if (!e.shiftKey && e.deltaX !== 0) return true;
  const w = e.wheelDeltaY;
  if (w === undefined || w === 0 || e.deltaY === 0) return false;
  // Chromium on macOS: trackpad wheelDeltaY is exactly -3 × deltaY; mouse notches are not.
  if (isMac) return Math.abs(w + 3 * e.deltaY) < 1e-6;
  // Windows/Linux: mouse notches are multiples of 120 (WHEEL_DELTA); touchpads report pixels.
  return w % 120 !== 0;
}

/**
 * Classifies a stream of wheel events. A new stream starts after `gapMs` of silence; within a
 * stream the kind can only upgrade mouse → trackpad, so one gesture never flips back mid-way.
 */
export class WheelClassifier {
  private lastTime = Number.NEGATIVE_INFINITY;
  private kind: WheelKind = 'mouse';

  constructor(
    private readonly isMac: boolean,
    private readonly gapMs = 250,
  ) {}

  classify(e: WheelSample): WheelKind {
    const newStream = e.timeStamp - this.lastTime > this.gapMs;
    this.lastTime = e.timeStamp;
    const evidence = looksLikeTrackpad(e, this.isMac);
    if (newStream) this.kind = evidence ? 'trackpad' : 'mouse';
    else if (evidence) this.kind = 'trackpad';
    return this.kind;
  }
}
