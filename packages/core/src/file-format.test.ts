import { describe, expect, it } from 'vitest';
import specV1 from '../../../docs/file-format-v1.md?raw';
import spec from '../../../docs/file-format.md?raw';
import { parseChatLog, parseProjectJson, parseVersionMarksJson } from './project-schema.js';
import { parseAnnotationsJson } from './schema.js';

const blocks = (text: string, lang: string): string[] =>
  [...text.matchAll(new RegExp('```' + lang + '\\n([\\s\\S]*?)```', 'g'))].map((m) => m[1] ?? '');

/** The examples in docs/file-format.md must stay valid project files. */
describe('docs/file-format.md', () => {
  it('has a project.json, a marks file and a chat log that pass the schemas', () => {
    const json = blocks(spec, 'json');
    expect(json).toHaveLength(2);
    const project = parseProjectJson(json[0] ?? '');
    if (!project.ok) throw new Error(project.errors.join('\n'));
    expect(project.data.models[0]?.versions).toHaveLength(2);
    expect(project.data.models[0]?.versions[1]?.from).toBe(project.data.models[0]?.versions[0]?.id);
    expect(project.data.comments[0]?.replies).toHaveLength(1);

    const marks = parseVersionMarksJson(json[1] ?? '');
    if (!marks.ok) throw new Error(marks.errors.join('\n'));
    expect(marks.data.versionId).toBe(project.data.models[0]?.versions[0]?.id);
    expect(marks.data.markers.map((m) => m.id)).toEqual(project.data.markers.map((m) => m.id));

    const chat = parseChatLog(blocks(spec, 'jsonl')[0] ?? '');
    expect(chat.badLines).toEqual([]);
    expect(chat.entries).toHaveLength(project.data.chats[0]?.entries ?? -1);
  });
});

/** The example in docs/file-format-v1.md must stay a valid sidecar (older files are still read). */
describe('docs/file-format-v1.md', () => {
  it('has an example that passes the schema', () => {
    const json = blocks(specV1, 'json');
    expect(json).toHaveLength(1);
    const result = parseAnnotationsJson(json[0] ?? '');
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.data.markers).toHaveLength(2);
    expect(result.data.comments).toHaveLength(2);
    expect(result.data.bodyTree?.folders).toHaveLength(1);
    expect(result.data.bodies).toHaveLength(2);
    expect(result.data.markers[1]?.entities[0]?.fingerprint?.form).toBe('hole');
    expect(result.droppedFields).toEqual([]);
  });
});
