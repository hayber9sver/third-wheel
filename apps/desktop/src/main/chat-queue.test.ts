import type { ChatWaitResult } from '@third-wheel/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatQueue, type ChatQueueSnapshot } from './chat-queue.js';

const messages = (r: ChatWaitResult): string[] =>
  r.state === 'message' ? r.messages.map((m) => m.text) : [];

describe('ChatQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts with no agent; a wait makes it listening and takes a message at once', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    expect(q.state).toBe('none');
    const waiting = q.wait();
    expect(q.state).toBe('listening');
    q.send('hello');
    const r = await waiting;
    expect(r).toMatchObject({
      state: 'message',
      delivery: 1,
      messages: [{ id: 1, text: 'hello' }],
    });
    expect(q.state).toBe('working');
  });

  it('queues messages while nobody waits and hands them over together, oldest first', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    q.send('a');
    q.send('b');
    expect(q.snapshot().queuedIds).toEqual([1, 2]);
    expect(messages(await q.wait())).toEqual(['a', 'b']);
    expect(q.snapshot().queuedIds).toEqual([]);
  });

  it('answers waiting when the time runs out', async () => {
    const q = new ChatQueue({ waitSec: 5 });
    const waiting = q.wait();
    vi.advanceTimersByTime(5000);
    expect(await waiting).toEqual({ state: 'waiting', waitedSec: 5 });
  });

  it('a newer wait answers the older one replaced', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    const first = q.wait();
    const second = q.wait();
    expect((await first).state).toBe('replaced');
    q.send('x');
    expect(messages(await second)).toEqual(['x']);
  });

  it('a closed connection drops its wait; the message stays queued for the next one', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    const closed = new AbortController();
    const first = q.wait({}, closed.signal);
    closed.abort();
    expect((await first).state).toBe('replaced');
    q.send('kept');
    expect(q.snapshot().queuedIds).toEqual([1]);
    expect(messages(await q.wait())).toEqual(['kept']);
  });

  it('a late close of an old wait does not cancel the next wait', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    const oldConnection = new AbortController();
    void q.wait({}, oldConnection.signal);
    const next = q.wait({}, new AbortController().signal);
    oldConnection.abort();
    expect(q.state).toBe('listening');
    q.send('for the next');
    expect(messages(await next)).toEqual(['for the next']);
  });

  it('hands a delivery over again when the next wait does not ack it', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    q.send('one');
    const r1 = await q.wait();
    expect(r1).toMatchObject({ delivery: 1 });
    q.send('two');
    // No ack: the agent never got "one".
    expect(messages(await q.wait())).toEqual(['one', 'two']);
  });

  it('an acked delivery is not handed over again', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    q.send('one');
    await q.wait();
    q.send('two');
    expect(messages(await q.wait({ ack: 1 }))).toEqual(['two']);
  });

  it('listening for a short grace between waits, then not listening', () => {
    const q = new ChatQueue({ waitSec: 10, graceSec: 30 });
    const states: ChatQueueSnapshot['state'][] = [];
    const q2 = new ChatQueue({
      waitSec: 10,
      graceSec: 30,
      onChange: (s) => states.push(s.state),
    });
    void q.wait();
    vi.advanceTimersByTime(10_000);
    expect(q.state).toBe('listening');
    vi.advanceTimersByTime(30_001);
    expect(q.state).toBe('not-listening');

    void q2.wait();
    vi.advanceTimersByTime(10_000 + 30_002);
    expect(states).toEqual(['listening', 'not-listening']);
  });

  it('working while the agent shows signs of life; quiet (still working) when it goes silent', async () => {
    const q = new ChatQueue({ waitSec: 60, graceSec: 30 });
    q.send('edit the CAD');
    await q.wait();
    vi.advanceTimersByTime(50_000);
    expect(q.snapshot()).toMatchObject({ state: 'working' });
    q.agentActivity(); // post_progress
    vi.advanceTimersByTime(60_000);
    expect(q.snapshot().quiet).toBeUndefined();
    vi.advanceTimersByTime(1);
    expect(q.snapshot()).toMatchObject({ state: 'working', quiet: true });
    q.agentActivity(); // news again
    expect(q.snapshot().quiet).toBeUndefined();
    void q.wait({ ack: 1 });
    expect(q.state).toBe('listening');
  });

  it('working turns quiet after 10 silent minutes, even with a 25-minute wait; never not listening', async () => {
    const changes: (true | undefined)[] = [];
    const q = new ChatQueue({
      waitSec: 1500,
      graceSec: 30,
      onChange: (s) => changes.push(s.quiet),
    });
    q.send('edit the CAD');
    await q.wait();
    vi.advanceTimersByTime(590_000);
    q.agentToolCall(); // e.g. load_model: still alive
    vi.advanceTimersByTime(600_000);
    expect(q.snapshot().quiet).toBeUndefined();
    vi.advanceTimersByTime(2);
    expect(changes.at(-1)).toBe(true); // the window is told without another call
    vi.advanceTimersByTime(3_600_000);
    expect(q.snapshot()).toMatchObject({ state: 'working', quiet: true });
  });

  it('other tool calls count as signs of life only while it works on a message', () => {
    const q = new ChatQueue({ waitSec: 60, graceSec: 30 });
    void q.wait();
    vi.advanceTimersByTime(60_000 + 30_001);
    expect(q.state).toBe('not-listening');
    q.agentToolCall(); // a review-only agent's get_annotations
    expect(q.state).toBe('not-listening');
  });

  it('a catch-up alone is not work: an agent that goes after it is not listening', async () => {
    const q = new ChatQueue({ waitSec: 60, graceSec: 30 });
    expect(await q.wait({}, undefined, true)).toMatchObject({ state: 'message', messages: [] });
    expect(q.state).toBe('listening');
    vi.advanceTimersByTime(30_001);
    expect(q.state).toBe('not-listening');
  });

  it('an answer ends working: an agent that quits after it is not listening after the grace', async () => {
    const q = new ChatQueue({ waitSec: 60, graceSec: 30 });
    q.send('make the hole 8 mm');
    await q.wait();
    expect(q.state).toBe('working');
    q.agentAnswered();
    expect(q.state).toBe('listening');
    q.agentToolCall(); // not working any more: ignored
    vi.advanceTimersByTime(30_001);
    expect(q.state).toBe('not-listening');
  });

  it('answers an open wait closed when the app quits', async () => {
    const q = new ChatQueue({ waitSec: 60 });
    const waiting = q.wait();
    vi.advanceTimersByTime(4000);
    q.dispose();
    expect(await waiting).toEqual({ state: 'closed', waitedSec: 4 });
  });

  it('stops after the idle time without a user message; a new wait starts again', async () => {
    const q = new ChatQueue({ waitSec: 600, idleStopSec: 1200 });
    const w1 = q.wait();
    vi.advanceTimersByTime(600_000);
    expect((await w1).state).toBe('waiting');
    const w2 = q.wait();
    vi.advanceTimersByTime(600_000);
    expect(await w2).toEqual({ state: 'stopped', idleSec: 1200 });
    expect(q.state).toBe('stopped');
    // The user typed "listen to Third Wheel": the clock starts again.
    const w3 = q.wait();
    expect(q.state).toBe('listening');
    q.send('hi');
    expect(messages(await w3)).toEqual(['hi']);
  });

  it('a user message resets the idle clock', async () => {
    const q = new ChatQueue({ waitSec: 600, idleStopSec: 1200 });
    void q.wait();
    vi.advanceTimersByTime(900_000);
    q.send('still here');
    expect(messages(await q.wait())).toEqual(['still here']);
    const w = q.wait({ ack: 1 });
    vi.advanceTimersByTime(600_000);
    expect((await w).state).toBe('waiting');
  });

  it('reports queued ids and state changes', () => {
    const seen: ChatQueueSnapshot[] = [];
    const q = new ChatQueue({ waitSec: 60, onChange: (s) => seen.push(s) });
    q.send('a');
    void q.wait();
    expect(seen.map((s) => [s.state, s.queuedIds.join()])).toEqual([
      ['none', '1'],
      ['working', ''],
    ]);
  });
});
