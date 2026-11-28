import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatTitle, MAX_CHAT_TITLE, newestVersionOf, withChatLines } from './project-chats.js';
import { sampleProject } from './testing/fixtures.js';

const P = path.posix;

describe('project chats index', () => {
  it('title = first non-empty line of the first message, one line, cut', () => {
    expect(chatTitle('\n  Make the  hole\t6 mm  \nand the slot')).toBe('Make the hole 6 mm');
    expect(chatTitle('x'.repeat(200))).toHaveLength(MAX_CHAT_TITLE);
    expect(chatTitle('x'.repeat(200)).endsWith('…')).toBe(true);
    expect(chatTitle('   ')).toBe('');
  });

  it('a new chat goes last; a known one gets time and count', () => {
    let p = sampleProject();
    p = withChatLines(p, 'a', { count: 2, at: '2026-11-21T12:00:00.000Z', title: 'First' });
    p = withChatLines(p, 'b', { count: 1, at: '2026-11-21T13:00:00.000Z', title: '' });
    p = withChatLines(p, 'a', { count: 3, at: '2026-11-21T14:00:00.000Z', title: 'ignored' });
    expect(p.chats).toEqual([
      {
        id: 'a',
        title: 'First',
        created: '2026-11-21T12:00:00.000Z',
        last: '2026-11-21T14:00:00.000Z',
        entries: 5,
      },
      {
        id: 'b',
        title: 'Chat',
        created: '2026-11-21T13:00:00.000Z',
        last: '2026-11-21T13:00:00.000Z',
        entries: 1,
      },
    ]);
  });

  it("a part's newest version (as Versions ▾ orders them)", () => {
    const p = sampleProject();
    expect(newestVersionOf(p, '/w/cad', 'part000001', P)?.id).toBe('ver0000002');
    expect(newestVersionOf(p, '/w/cad', 'nope', P)).toBeUndefined();
  });
});
