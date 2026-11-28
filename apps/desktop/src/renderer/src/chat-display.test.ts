import { describe, expect, it } from 'vitest';
import type { ChatEntry, ChatStatus } from '../../shared/chat.js';
import {
  agentLabel,
  chatHelp,
  chatLock,
  LISTEN_COMMAND,
  chatItems,
  chatWhen,
  modelEventText,
  PERMISSION_HINT_MS,
  refLabel,
  stateLine,
  stepsLabel,
  topicNote,
  unreadCount,
} from './chat-display.js';

let seq = 0;
const at = 1000;
const e = (kind: ChatEntry['kind'], text: string, time = at): ChatEntry => ({
  seq: ++seq,
  kind,
  text,
  at: time,
});
const status = (state: ChatStatus['state'], queued: number[] = []): ChatStatus => ({
  state,
  waitSec: 600,
  queued,
  agent: 'claude-code',
});

describe('chatItems', () => {
  it('folds progress lines under the answer they led to', () => {
    seq = 0;
    const entries = [
      e('user', 'Make the pin Ø4.80'),
      e('progress', 'Editing'),
      e('progress', 'Exporting'),
      e('agent', 'Done'),
    ];
    const items = chatItems({ entries, status: status('listening'), now: at });
    expect(items).toEqual([
      { kind: 'user', seq: 1, text: 'Make the pin Ø4.80', queued: false },
      {
        kind: 'agent',
        seq: 4,
        text: 'Done',
        steps: ['Editing', 'Exporting'],
        name: 'Claude Code',
      },
    ]);
  });

  it('names the agent above the first answer of a run, from the name it had then', () => {
    seq = 0;
    const entries = [
      { ...e('agent', 'one'), agent: 'codex-cli' },
      e('agent', 'two'),
      e('user', 'ok'),
      e('agent', 'three'),
    ];
    const items = chatItems({ entries, status: status('listening'), now: at });
    expect(items.map((it) => ('name' in it ? it.name : undefined))).toEqual([
      'Codex',
      undefined,
      undefined,
      'Claude Code',
    ]);
  });

  it('join / leave lines carry their time; catch-up and summary lines fold', () => {
    seq = 0;
    const entries = [
      { ...e('joined', 'Claude Code connected'), connection: 'c1' },
      { ...e('caught-up', 'Caught up · bracket.step'), detail: 'On screen: bracket.step' },
      e('left', 'Claude Code stopped listening'),
    ];
    const items = chatItems({ entries, status: status('not-listening'), now: at });
    expect(items[0]).toMatchObject({
      kind: 'event',
      text: `Claude Code connected · ${chatWhen(at, at)}`,
    });
    expect(items[1]).toEqual({
      kind: 'folded',
      seq: 2,
      text: 'Caught up · bracket.step',
      detail: 'On screen: bracket.step',
      at,
    });
    expect(items[2]).toMatchObject({ kind: 'event' });
    expect(items.some((it) => it.rail)).toBe(false); // nobody listening: no rail
  });

  it('the rail: lines before the connection fade; it runs off the top without a start', () => {
    seq = 0;
    const entries = [
      e('user', 'old'),
      e('agent', 'old answer'),
      e('joined', 'connected'),
      e('user', 'new'),
    ];
    const live = { ...status('listening'), connection: 'c1' };
    const rails = (railFrom?: number) =>
      chatItems({
        entries,
        status: railFrom === undefined ? live : { ...live, railFrom },
        now: at,
      }).map((it) => it.rail);
    expect(rails(3)).toEqual(['before', 'before', 'start', 'on']);
    expect(rails()).toEqual(['top', 'on', 'on', 'on']);
    // Started before the first line loaded: off the top too.
    expect(
      chatItems({ entries: entries.slice(2), status: { ...live, railFrom: 1 }, now: at }).map(
        (it) => it.rail,
      ),
    ).toEqual(['top', 'on']);
    // Not listening (before its "stopped listening" line): no rail, nothing faded.
    const quiet = { ...status('not-listening'), connection: 'c1', railFrom: 3 };
    expect(chatItems({ entries, status: quiet, now: at }).map((it) => it.rail)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('while working: "…" with the latest line, before messages queued meanwhile', () => {
    seq = 0;
    const entries = [
      e('user', 'a'),
      e('progress', 'Reading'),
      e('progress', 'Editing'),
      e('user', 'and b'),
    ];
    const items = chatItems({
      entries,
      status: status('working', [4]),
      now: at + 1000,
      workingSince: at,
    });
    expect(items.map((i) => i.kind)).toEqual(['user', 'working', 'user']);
    expect(items[1]).toEqual({
      kind: 'working',
      latest: 'Editing',
      hint: false,
      hintAt: at + PERMISSION_HINT_MS,
    });
    expect(items[2]).toMatchObject({
      queued: true,
      queuedNote: 'Queued · goes to the agent when it’s done',
    });
  });

  it('working but quiet: the "…" stays and says so', () => {
    seq = 0;
    const items = chatItems({
      entries: [e('user', 'a')],
      status: { ...status('working'), quiet: true },
      now: at,
    });
    expect(items.at(-1)).toMatchObject({ kind: 'working', quiet: true });
  });

  it('working on another topic: a note naming it instead of the "…"; the queued note still says it is busy', () => {
    seq = 0;
    const entries = [e('user', 'new topic')];
    const items = chatItems({
      entries,
      status: {
        ...status('working', [1]),
        workingIn: { title: 'make the hole 8 mm', chatId: 'c1' },
      },
      now: at,
    });
    // The note sits where the "…" would: before the messages queued here.
    expect(items.map((i) => i.kind)).toEqual(['working-in', 'user']);
    expect(items[0]).toMatchObject({ title: 'make the hole 8 mm', chatId: 'c1' });
    expect(items[1]).toMatchObject({ queuedNote: 'Queued · goes to the agent when it’s done' });
  });

  it('"Answered in topic": a line that opens the topic; another project named, no link; counts as unread', () => {
    seq = 0;
    const note = (topic: NonNullable<ChatEntry['topic']>): ChatEntry => ({
      ...e('elsewhere', 'x'),
      topic,
    });
    const entries = [
      e('user', 'new topic'),
      note({ title: 'make the hole 8 mm', chatId: 'c1' }),
      note({ title: 'thicker wall', project: 'cad' }),
    ];
    const items = chatItems({ entries, status: status('listening'), now: at });
    expect(items.slice(1)).toEqual([
      { kind: 'answered-in', seq: 2, title: 'make the hole 8 mm', chatId: 'c1' },
      { kind: 'answered-in', seq: 3, title: 'thicker wall', project: 'cad' },
    ]);
    expect(unreadCount(entries, 1)).toBe(2);
    expect(topicNote('Answered', { title: 'A', chatId: 'c1' })).toBe('Answered in topic “A” →');
    expect(topicNote('Answered', { title: 'A', project: 'cad' })).toBe(
      'Answered in topic “A” (project cad)',
    );
    expect(topicNote('Working on your message', { title: 'A' })).toBe(
      'Working on your message in topic “A” (another project)',
    );
  });

  it('permission hint after 30 s with no new progress line', () => {
    seq = 0;
    const entries = [e('user', 'a'), e('progress', 'Editing', at + 5000)];
    const working = (now: number) =>
      chatItems({ entries, status: status('working'), now, workingSince: at }).at(-1);
    expect(working(at + 5000 + PERMISSION_HINT_MS - 1)).toMatchObject({ hint: false });
    expect(working(at + 5000 + PERMISSION_HINT_MS)).toMatchObject({ hint: true });
  });

  it('queued note only under the last queued message, worded for "not listening"', () => {
    seq = 0;
    const entries = [e('user', 'one'), e('user', 'two')];
    const items = chatItems({ entries, status: status('not-listening', [1, 2]), now: at });
    expect(items[0]).not.toHaveProperty('queuedNote');
    expect(items[1]).toMatchObject({ queuedNote: 'Queued · sent when the agent listens' });
  });

  it('lines with no answer stay folded where they were once the agent stopped', () => {
    seq = 0;
    const entries = [e('user', 'a'), e('progress', 'Editing')];
    const items = chatItems({ entries, status: status('not-listening'), now: at });
    expect(items[1]).toEqual({ kind: 'steps', seq: 2, steps: ['Editing'] });
  });
});

describe('chat state and help', () => {
  it('state line per state', () => {
    expect(stateLine(status('none'))).toEqual({ dot: 'grey', text: 'No agent connected' });
    expect(stateLine(status('listening'))).toEqual({
      dot: 'green',
      text: 'Claude Code · listening',
    });
    expect(stateLine(status('working')).text).toBe('Claude Code · working…');
    expect(stateLine(status('stopped'))).toEqual({
      dot: 'amber',
      text: 'Claude Code · not listening',
    });
  });

  it('help box per state', () => {
    expect(chatHelp(status('none'), true)).toBeUndefined(); // the locked box's card has the steps
    expect(chatHelp(status('listening'), false)).toBe('listening-empty');
    expect(chatHelp(status('listening'), true)).toBeUndefined();
    expect(chatHelp(status('working'), true)).toBeUndefined();
    expect(chatHelp(status('not-listening'), true)).toBe('restart');
    expect(chatHelp(status('stopped'), false)).toBe('restart');
  });

  it('the message box is locked until a project is open and an agent listened this session', () => {
    expect(chatLock(false, status('none'))).toBe('project');
    expect(chatLock(false, status('listening'))).toBe('project');
    expect(chatLock(true, status('none'))).toBe('agent');
    expect(chatLock(true, status('listening'))).toBeUndefined();
    // Once an agent listened, messages queue while it is away.
    expect(chatLock(true, status('stopped'))).toBeUndefined();
    expect(chatLock(true, status('not-listening'))).toBeUndefined();
  });

  it('the start phrase is safe for an agent without the Third Wheel tools', () => {
    expect(LISTEN_COMMAND).toMatch(/^Listen to Third Wheel/);
    expect(LISTEN_COMMAND).toContain('wait_for_message');
    expect(LISTEN_COMMAND).toMatch(/don't have that tool, say so and stop/);
  });

  it('agent names people know; unknown names as they are', () => {
    expect(agentLabel('claude-code')).toBe('Claude Code');
    expect(agentLabel('codex-mcp-client')).toBe('Codex');
    expect(agentLabel('Visual Studio Code')).toBe('VS Code');
    expect(agentLabel('my-agent')).toBe('my-agent');
    expect(agentLabel(undefined)).toBe('Agent');
  });

  it('unread counts answers only, not progress lines', () => {
    seq = 0;
    const entries = [e('agent', 'a'), e('progress', 'p'), e('agent', 'b'), e('user', 'u')];
    expect(unreadCount(entries, 0)).toBe(2);
    expect(unreadCount(entries, 1)).toBe(1);
    expect(stepsLabel(1)).toBe('1 step');
    expect(stepsLabel(3)).toBe('3 steps');
  });
});

describe('comment threads in the chat', () => {
  const ref = {
    modelId: 'abc',
    file: 'bracket.step',
    path: '/cad/bracket.step',
    commentId: 'c5',
    n: 3,
    title: 'Pin too tight',
  };

  it("a thread reply queues like a message; the agent's reply under a comment takes the steps", () => {
    seq = 0;
    const entries: ChatEntry[] = [
      { ...e('thread', 'Make it looser'), ref },
      e('progress', 'Editing'),
      { ...e('replied', 'Loosened to 5.05'), ref },
      e('review', 'Review sent: 2 new comments on bracket.step'),
    ];
    const items = chatItems({ entries, status: status('working', [4]), now: at });
    expect(items).toEqual([
      { kind: 'thread', seq: 1, text: 'Make it looser', ref, queued: false },
      { kind: 'replied', seq: 3, text: 'Loosened to 5.05', ref, steps: ['Editing'] },
      expect.objectContaining({ kind: 'working' }),
      {
        kind: 'review',
        seq: 4,
        text: 'Review sent: 2 new comments on bracket.step',
        queued: true,
        queuedNote: 'Queued · goes to the agent when it’s done',
      },
    ]);
    expect(unreadCount(entries, 0)).toBe(1); // the reply under the comment counts as an answer
  });

  it('refLabel: card number and the first line, cut', () => {
    expect(refLabel(ref)).toBe('#3 Pin too tight');
    expect(refLabel({ ...ref, title: 'x'.repeat(60) }, 10)).toBe(`#3 ${'x'.repeat(9)}…`);
  });
});

describe('model event lines and the history list', () => {
  it('an event is its own line; it does not break progress folding or count as unread', () => {
    seq = 0;
    const entries = [
      e('user', 'Make v2'),
      e('progress', 'Editing'),
      e('event', 'Agent loaded b_v2.step — new version of b.step'),
      e('agent', 'Done'),
    ];
    const items = chatItems({ entries, status: status('listening'), now: at });
    expect(items.map((i) => i.kind)).toEqual(['user', 'event', 'agent']);
    expect(items[2]).toMatchObject({ kind: 'agent', steps: ['Editing'] });
    expect(unreadCount([e('event', 'Opened a.step')], 0)).toBe(0);
  });

  it('event texts', () => {
    expect(modelEventText('b.step', 'opened')).toBe('Opened b.step');
    expect(modelEventText('b_v2.step', 'agent', 'b.step')).toBe(
      'Agent loaded b_v2.step — new version of b.step',
    );
    expect(modelEventText('b.step', 'reloaded', 'x.step')).toBe(
      'Reloaded b.step (changed on disk)',
    );
  });

  it('times: today as a clock time, other days as a date', () => {
    const now = new Date(2026, 10, 21, 15, 0).getTime();
    expect(chatWhen(new Date(2026, 10, 21, 9, 5).getTime(), now)).toMatch(/09.05|9.05/);
    expect(chatWhen(new Date(2026, 10, 20, 9, 5).getTime(), now)).toMatch(/20/);
    expect(chatWhen(new Date(2025, 10, 20).getTime(), now)).toMatch(/2025/);
  });
});
