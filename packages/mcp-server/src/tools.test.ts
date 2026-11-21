import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { BridgeError, type BridgeClient } from './bridge-client.js';
import { createToolServer, DEFAULT_WAIT_SECONDS, REPLY_NEXT_STEP } from './tools.js';

interface Sent {
  method: string;
  params: unknown;
  timeoutMs: number | undefined;
}

/** A tool server whose bridge answers with `answer`; records every call. */
async function setup(answer: (method: string, params: unknown) => unknown, cwd = '/proj') {
  const sent: Sent[] = [];
  let closed = 0;
  const fake: BridgeClient = {
    call(method, params, timeoutMs) {
      sent.push({ method, params, timeoutMs });
      return new Promise((resolve) => {
        resolve(answer(method, params));
      });
    },
    close() {
      closed++;
    },
  };
  const server = createToolServer({ connect: () => Promise.resolve(fake), cwd });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  open.push(client);
  return { client, sent, closed: () => closed };
}
const open: Client[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

type Content = { type: string; text?: string; data?: string; mimeType?: string }[];
const text = (r: unknown): string => (r as { content: Content }).content[0]?.text ?? '';

describe('MCP tools', () => {
  it('lists the nine tools', async () => {
    const { client } = await setup(() => null);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_annotations',
      'get_open_model',
      'load_model',
      'render_region',
      'reply_to_comment',
      'request_review',
      'search_parts',
      'set_comment_status',
      'wait_for_review',
    ]);
  });

  it('get_open_model asks the app for its status without loading anything', async () => {
    const answer = {
      model: { modelId: 'abc', name: 'part.step', path: 'C:/p/part.step', contentHash: 'sha256:x' },
      summary: { bodies: 6, markers: 1, comments: { open: 1, resolved: 0, wontfix: 0 } },
    };
    const { client, sent } = await setup(() => answer);
    const r = await client.callTool({ name: 'get_open_model', arguments: {} });
    expect(JSON.parse(text(r))).toEqual(answer);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('open_model');
  });

  it('load_model resolves relative paths from the server folder', async () => {
    const { client, sent, closed } = await setup(() => ({ modelId: 'abc' }));
    const r = await client.callTool({ name: 'load_model', arguments: { path: 'out/part.step' } });
    expect(JSON.parse(text(r))).toEqual({ modelId: 'abc' });
    expect(sent[0]?.method).toBe('load');
    expect((sent[0]?.params as { path: string }).path).toMatch(/proj[\\/]out[\\/]part\.step$/);
    expect(closed()).toBe(1);
  });

  it('load_model passes revisionOf only when given (T8.1)', async () => {
    const { client, sent } = await setup(() => ({ modelId: 'def' }));
    await client.callTool({
      name: 'load_model',
      arguments: { path: '/p/part-v2.step', revisionOf: 'abc' },
    });
    await client.callTool({ name: 'load_model', arguments: { path: '/p/part-v3.step' } });
    const params = sent[0]?.params as { path: string; revisionOf?: string };
    expect(params.path).toMatch(/part-v2\.step$/);
    expect(params.revisionOf).toBe('abc');
    expect(sent[1]?.params).not.toHaveProperty('revisionOf');
  });

  it('get_annotations passes the payload text through', async () => {
    const payload = '{"model":"a.step","units":"mm","comments":[],"markers":[],"bodies":{}}';
    const { client, sent } = await setup(() => payload);
    const r = await client.callTool({ name: 'get_annotations', arguments: { modelId: 'abc' } });
    expect(text(r)).toBe(payload);
    expect(sent[0]).toMatchObject({ method: 'annotations', params: { modelId: 'abc' } });
  });

  it('wait_for_review long-polls with a longer bridge timeout', async () => {
    const { client, sent } = await setup(() => ({ reviewId: 'r1', state: 'sent' }));
    await client.callTool({ name: 'wait_for_review', arguments: { reviewId: 'r1' } });
    expect(sent[0]?.params).toEqual({ reviewId: 'r1', timeoutSec: DEFAULT_WAIT_SECONDS });
    expect(sent[0]?.timeoutMs).toBeGreaterThan(DEFAULT_WAIT_SECONDS * 1000);
  });

  it('render_region returns the image and the camera facts as text', async () => {
    const { client } = await setup(() => ({
      png: 'iVBORw0KGgo=',
      width: 384,
      height: 384,
      view: { viewDir: [0, 0, 1], up: [0, 1, 0], center: [1, 2, 3], mmPerPx: 0.1, ghosted: [] },
    }));
    const r = await client.callTool({
      name: 'render_region',
      arguments: { modelId: 'abc', markerIds: ['m1'] },
    });
    const content = (r as { content: Content }).content;
    expect(content[0]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
    expect(JSON.parse(content[1]?.text ?? '')).toMatchObject({
      width: 384,
      view: { mmPerPx: 0.1 },
    });
  });

  it('render_region wants markerIds or groups, not both', async () => {
    const { client, sent } = await setup(() => null);
    const r = await client.callTool({
      name: 'render_region',
      arguments: { modelId: 'abc', markerIds: ['m1'], groups: [['m1']] },
    });
    expect(r.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('reply_to_comment sends reply_comment with the text', async () => {
    const { client, sent } = await setup(() => ({
      commentId: 'c1',
      replyId: 'r2',
      status: 'open',
    }));
    const r = await client.callTool({
      name: 'reply_to_comment',
      arguments: { modelId: 'abc', commentId: 'c1', text: 'Which side, left or right?' },
    });
    const content = (r as { content: Content }).content;
    expect(content[0]?.text).toBe(REPLY_NEXT_STEP);
    expect(JSON.parse(content.at(-1)?.text ?? '')).toEqual({
      commentId: 'c1',
      replyId: 'r2',
      status: 'open',
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      method: 'reply_comment',
      params: { modelId: 'abc', commentId: 'c1', text: 'Which side, left or right?' },
    });
  });

  it('passes part results through with set_comment_status and reply_to_comment', async () => {
    const partResults = [
      { partId: 'p1', status: 'placed', bodies: ['Screw M5 (Hole 1)'], note: 'two screws' },
      { partId: 'p2', status: 'needs-info', note: 'Which thread length?' },
    ];
    const { client, sent } = await setup(() => ({ commentId: 'c1', changed: true }));
    await client.callTool({
      name: 'set_comment_status',
      arguments: { modelId: 'abc', commentId: 'c1', status: 'resolved', partResults },
    });
    await client.callTool({
      name: 'reply_to_comment',
      arguments: { modelId: 'abc', commentId: 'c1', text: 'One question', partResults },
    });
    expect(sent[0]).toMatchObject({ method: 'set_comment_status', params: { partResults } });
    expect(sent[1]).toMatchObject({ method: 'reply_comment', params: { partResults } });
  });

  it('refuses a part result with an unknown status', async () => {
    const { client, sent } = await setup(() => ({}));
    const r = await client.callTool({
      name: 'set_comment_status',
      arguments: {
        modelId: 'abc',
        commentId: 'c1',
        status: 'resolved',
        partResults: [{ partId: 'p1', status: 'done' }],
      },
    });
    expect(r.isError).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('turns bridge errors into readable tool errors', async () => {
    const { client } = await setup(() => {
      throw new BridgeError('not_running', 'x');
    });
    const r = await client.callTool({
      name: 'set_comment_status',
      arguments: { modelId: 'abc', commentId: 'c1', status: 'resolved' },
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not running/);
  });
});
