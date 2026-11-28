import { describe, expect, it } from 'vitest';
import { FOCUS_FADE, focusedEntities, focusedStyles, mixColor } from './comment-focus.js';

describe('comment focus look', () => {
  it('mixColor blends per channel', () => {
    expect(mixColor(0xff0000, 0x0000ff, 0)).toBe(0xff0000);
    expect(mixColor(0xff0000, 0x0000ff, 1)).toBe(0x0000ff);
    expect(mixColor(0x000000, 0xc8c8c8, 0.5)).toBe(0x646464);
  });

  const styles = [
    { id: 'm1', color: 0xff0000, visible: true },
    { id: 'm2', color: 0x00ff00, visible: false },
    { id: 'm3', color: 0x0000ff, visible: true },
  ];

  it('without a focus nothing changes', () => {
    expect(focusedStyles(styles, undefined, 0xc0c0c0)).toBe(styles);
    expect(focusedStyles(styles, new Set(), 0xc0c0c0)).toBe(styles);
  });

  it('focused markers keep their colour and show even when hidden; others fade', () => {
    const out = focusedStyles(styles, new Set(['m2']), 0xffffff);
    expect(out[1]).toEqual({ id: 'm2', color: 0x00ff00, visible: true });
    expect(out[0]).toEqual({
      id: 'm1',
      color: mixColor(0xff0000, 0xffffff, FOCUS_FADE),
      visible: true,
    });
    expect(out[2]?.visible).toBe(true);
  });

  it('resolved markers shown by "Show resolved" fade, unless their comment is focused', () => {
    const withResolved = [...styles, { id: 'm4', color: 0xff0000, visible: true, fade: true }];
    const faded = mixColor(0xff0000, 0xffffff, FOCUS_FADE);
    expect(focusedStyles(withResolved, undefined, 0xffffff)[3]?.color).toBe(faded);
    expect(focusedStyles(withResolved, undefined, 0xffffff)[0]).toBe(styles[0]);
    expect(focusedStyles(withResolved, new Set(['m4']), 0xffffff)[3]?.color).toBe(0xff0000);
    expect(focusedStyles(withResolved, new Set(['m1']), 0xffffff)[3]?.color).toBe(faded);
    const ents = [
      { kind: 'face' as const, id: 1, markerId: 'm1', color: '#ff0000' },
      { kind: 'face' as const, id: 2, markerId: 'm4', color: '#000000', fade: true },
    ];
    const plain = focusedEntities(ents, undefined, 0xffffff);
    expect(plain[0]).toBe(ents[0]);
    expect(plain[1]?.color).toBe('#b3b3b3');
    expect(focusedEntities(ents, new Set(['m4']), 0xffffff)[1]).toBe(ents[1]);
  });

  it('fades entities of other markers', () => {
    const ents = [
      { kind: 'face' as const, id: 1, markerId: 'm1', color: '#ff0000' },
      { kind: 'edge' as const, id: 2, markerId: 'm2', color: '#000000' },
    ];
    const out = focusedEntities(ents, new Set(['m1']), 0xffffff);
    expect(out[0]).toBe(ents[0]);
    expect(out[1]?.color).toBe('#b3b3b3');
  });
});
