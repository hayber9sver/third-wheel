import { describe, expect, it } from 'vitest';
import {
  chatProgressParamsSchema,
  chatSendParamsSchema,
  chatWaitParamsSchema,
  DEFAULT_CHAT_WAIT_SECONDS,
  MAX_CHAT_WAIT_SECONDS,
  MAX_CHAT_MESSAGE_LENGTH,
  MAX_CHAT_PROGRESS_LENGTH,
} from './chat-methods.js';

describe('chat bridge params', () => {
  it('a wait ends before Claude Code aborts a silent tool call (30 min)', () => {
    expect(MAX_CHAT_WAIT_SECONDS).toBeLessThanOrEqual(25 * 60);
    expect(DEFAULT_CHAT_WAIT_SECONDS).toBeLessThanOrEqual(MAX_CHAT_WAIT_SECONDS);
  });

  it('chat_wait takes only an optional positive ack', () => {
    expect(chatWaitParamsSchema.parse({})).toEqual({});
    expect(chatWaitParamsSchema.parse({ ack: 3 })).toEqual({ ack: 3 });
    expect(chatWaitParamsSchema.safeParse({ ack: 0 }).success).toBe(false);
    expect(chatWaitParamsSchema.safeParse({ timeoutSec: 5 }).success).toBe(false);
  });

  it('chat_send and chat_progress need text within their limits', () => {
    expect(chatSendParamsSchema.parse({ text: ' ok ' })).toEqual({ text: 'ok' });
    expect(chatSendParamsSchema.safeParse({ text: '   ' }).success).toBe(false);
    expect(
      chatSendParamsSchema.safeParse({ text: 'x'.repeat(MAX_CHAT_MESSAGE_LENGTH + 1) }).success,
    ).toBe(false);
    expect(
      chatProgressParamsSchema.safeParse({ text: 'x'.repeat(MAX_CHAT_PROGRESS_LENGTH) }).success,
    ).toBe(true);
    expect(
      chatProgressParamsSchema.safeParse({ text: 'x'.repeat(MAX_CHAT_PROGRESS_LENGTH + 1) })
        .success,
    ).toBe(false);
  });
});
